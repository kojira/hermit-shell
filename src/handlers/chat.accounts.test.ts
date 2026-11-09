import assert from "node:assert/strict";
import test from "node:test";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../server";

async function listen(server: Server) {
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function event(data: any) { return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`; }
const success = event({ type: "message_start", message: { id: "fixture", role: "assistant", model: "claude-fixture", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }) +
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }) +
  event({ type: "content_block_stop", index: 0 }) +
  event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + event({ type: "message_stop" });

test("setup registration, saved variable list and all four real HTTP forwarding paths", async t => {
  const dir = mkdtempSync(join(tmpdir(), "hermit-accounts-"));
  const keys = ["HERMIT_ACCOUNTS_FILE", "HERMIT_AUTH_FILE", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  const saved = keys.map(k => process.env[k]);
  process.env.HERMIT_ACCOUNTS_FILE = join(dir, "accounts.json");
  process.env.HERMIT_AUTH_FILE = join(dir, "auth");
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-original";
  const attempts: { token: string; body: any }[] = [];
  const upstream = createServer((req, res) => {
    let raw = ""; req.on("data", c => raw += c); req.on("end", () => {
      const body = JSON.parse(raw);
      if (body.max_tokens === 1) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "verify", content: [], usage: {} })); return; }
      attempts.push({ token: req.headers.authorization!, body });
      res.setHeader("content-type", "text/event-stream"); res.end(success);
    });
  });
  process.env.ANTHROPIC_BASE_URL = await listen(upstream);
  const downstream = createServer(app);
  const url = await listen(downstream);
  t.after(async () => {
    for (const s of [downstream, upstream]) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
    keys.forEach((k, i) => saved[i] === undefined ? delete process.env[k] : process.env[k] = saved[i]);
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (path: string, body: any) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const initial = await fetch(url + "/setup/accounts");
  assert.equal(initial.status, 200, "existing setup must provide account management");
  let view = await initial.json() as any;
  assert.equal(view.mode, "legacy", "account setup must expose legacy mode before explicit activation");
  for (let i = 1; i <= 4; i++) {
    const r = await post("/setup/token", { token: `sk-ant-oat01-fixture-${i}`, name: `Contract ${i}`, expectedRevision: view.revision });
    assert.equal(r.status, 200); view = await (await fetch(url + "/setup/accounts")).json();
    assert.equal(view.accounts.length, i);
  }
  const activate = await post("/setup/accounts", { action: "mode", mode: "pool", expectedRevision: view.revision });
  assert.equal(activate.status, 200);
  for (const stream of [false, true]) for (const tools of [false, true]) {
    const r = await post("/v1/chat/completions", { model: "claude-fixture", messages: [{ role: "user", content: "hello" }], stream,
      ...(tools ? { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] } : {}) });
    assert.equal(r.status, 200); assert.match(await r.text(), /hello/);
    assert.equal(attempts[attempts.length - 1].token, "Bearer sk-ant-oat01-fixture-1");
    assert.match(JSON.stringify(attempts[attempts.length - 1].body.system), /Claude Code/);
    assert.deepEqual(attempts[attempts.length - 1].body.cache_control, { type: "ephemeral" });
  }
});

import type { TestContext } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccountStore, getAccountStore } from "../utils/accounts";
import { resetClient } from "./chat";
const rejection = { type: "error", error: { type: "rate_limit_error", message: "fixture" } };
const quotaHeaders = { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "five_hour" };
function reject(res: ServerResponse, headers: Record<string, string> = quotaHeaders, status = 429) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(status === 429 ? rejection : { type: "error", error: { type: "api_error", message: "fixture" } }));
}
async function poolHarness(t: TestContext, respond: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hermit-pool-http-"));
  const keys = ["HERMIT_ACCOUNTS_FILE", "HERMIT_AUTH_FILE", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  const saved = keys.map(k => process.env[k]);
  process.env.HERMIT_ACCOUNTS_FILE = join(dir, "accounts.json");
  process.env.HERMIT_AUTH_FILE = join(dir, "auth");
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-original";
  const attempts: { token: string; body: any }[] = [];
  let verifyStatus = 200;
  let verifyHold: (() => Promise<void>) | undefined;
  const upstream = createServer((req, res) => {
    let raw = ""; req.on("data", c => raw += c); req.on("end", async () => {
      const body = JSON.parse(raw);
      if (body.max_tokens === 1) {
        if (verifyHold) await verifyHold();
        res.writeHead(verifyStatus, { "content-type": "application/json", "x-should-retry": "false" });
        res.end(JSON.stringify(verifyStatus === 200 ? { id: "verify", content: [], usage: {} } : rejection)); return;
      }
      attempts.push({ token: req.headers.authorization!, body }); respond(req, res, body);
    });
  });
  process.env.ANTHROPIC_BASE_URL = await listen(upstream);
  const downstream = createServer(app), url = await listen(downstream);
  resetClient();
  t.after(async () => {
    for (const s of [downstream, upstream]) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
    keys.forEach((k, i) => saved[i] === undefined ? delete process.env[k] : process.env[k] = saved[i]);
    resetClient(); rmSync(dir, { recursive: true, force: true });
  });
  const post = (path: string, body: any, signal?: AbortSignal) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const store = getAccountStore();
  const mutate = (body: any) => post("/setup/accounts", { expectedRevision: store.view().revision, ...body });
  const add = (name: string) => post("/setup/token", { name, token: `sk-ant-oat01-${name}`, expectedRevision: store.view().revision });
  for (const name of ["first", "second"]) assert.equal((await add(name)).status, 200);
  assert.equal((await mutate({ action: "mode", mode: "pool" })).status, 200);
  return { store, url, attempts, post, mutate, add,
    setVerification: (status: number, hold?: () => Promise<void>) => { verifyStatus = status; verifyHold = hold; },
    chat: (stream = false, tools = false, signal?: AbortSignal) => post("/v1/chat/completions", { model: "claude-fixture", messages: [{ role: "user", content: "hello" }], stream,
      ...(tools ? { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] } : {}), stream_options: { include_usage: true } }, signal),
  };
}
const ok = (res: ServerResponse) => { res.setHeader("content-type", "text/event-stream"); res.end(success); };

for (const stream of [false, true]) for (const tools of [false, true]) {
  test(`pool quota switches once before open and preserves request: stream=${stream}, tools=${tools}`, async t => {
    const h = await poolHarness(t, (req, res) => req.headers.authorization?.endsWith("first") ? reject(res) : ok(res));
    const r = await h.chat(stream, tools); assert.equal(r.status, 200); assert.match(await r.text(), /hello/);
    assert.deepEqual(h.attempts.map(a => a.token), ["Bearer sk-ant-oat01-first", "Bearer sk-ant-oat01-second"]);
    assert.deepEqual(h.attempts[0].body, h.attempts[1].body);
    assert.equal(h.store.view().accounts[0].observed.state, "exhausted");
    await (await h.chat(stream, tools)).text();
    assert.deepEqual(h.attempts.map(a => a.token), ["Bearer sk-ant-oat01-first", "Bearer sk-ant-oat01-second", "Bearer sk-ant-oat01-first", "Bearer sk-ant-oat01-second"]);
  });
}
test("each request retries A then B despite persisted future quota observations", async t => {
  let secondAvailable = false;
  const h = await poolHarness(t, (req, res) => {
    if (secondAvailable && req.headers.authorization?.endsWith("second")) return ok(res);
    reject(res, { ...quotaHeaders, "retry-after": "3600" });
  });
  // Reload a schema-v1 observation written by the old cooldown implementation.
  const persisted = JSON.parse(readFileSync(h.store.filePath, "utf8"));
  for (const account of persisted.accounts) account.observed = {
    state: "exhausted", reason: "weekly", retryAt: Date.now() + 86400000,
    retryBasis: "local_probe", failureCount: 3,
  };
  const file = join(tmpdir(), `hermit-reloaded-${persisted.accounts[0].id}.json`);
  writeFileSync(file, JSON.stringify(persisted));
  t.after(() => rmSync(file, { force: true }));
  process.env.HERMIT_ACCOUNTS_FILE = file;
  const store = getAccountStore();
  const r = await h.chat(true);
  assert.equal(r.status, 429); assert.equal(r.headers.get("retry-after"), "3600");
  const data = await r.json() as any; assert.equal(data.error.reason, "all_accounts_exhausted");
  assert.deepEqual(h.attempts.map(a => a.token), ["Bearer sk-ant-oat01-first", "Bearer sk-ant-oat01-second"]);
  assert.ok(store.view().accounts.every(a => a.observed.retryAt! > Date.now()));
  secondAvailable = true;
  const next = await h.chat();
  assert.equal(next.status, 200); assert.match(await next.text(), /hello/);
  assert.deepEqual(h.attempts.map(a => a.token), [
    "Bearer sk-ant-oat01-first", "Bearer sk-ant-oat01-second",
    "Bearer sk-ant-oat01-first", "Bearer sk-ant-oat01-second",
  ]);
});

for (const [status, headers, expected] of [
  [429, { "retry-after": "2" }, 429], [401, {}, 503], [403, {}, 403], [400, {}, 400], [503, {}, 503],
] as [number, Record<string, string>, number][]) test(`pool pre-open ${status} does not switch/retry`, async t => {
  const h = await poolHarness(t, (_req, res) => reject(res, headers, status));
  const r = await h.chat(true); assert.equal(r.status, expected);
  assert.match(r.headers.get("content-type")!, /application\/json/); await r.text();
  assert.equal(h.attempts.length, 1);
  if (status === 429) { assert.equal(r.headers.get("retry-after"), "2"); assert.notEqual(h.store.view().accounts[0].observed.state, "exhausted"); }
  if (status === 401) {
    assert.equal(h.store.view().accounts[0].observed.state, "reauth");
    await (await h.chat()).text(); assert.equal(h.attempts[1].token, "Bearer sk-ant-oat01-second");
  }
});
for (const stream of [false, true]) test(`pool upstream open is terminal even before output: stream=${stream}`, async t => {
  const h = await poolHarness(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(event(rejection)); });
  const r = await h.chat(stream); assert.equal(r.status, stream ? 200 : 429);
  const text = await r.text(); assert.equal(h.attempts.length, 1);
  if (stream) { assert.equal(text.split("data: [DONE]").length - 1, 1); assert.equal(text.split('"error":').length - 1, 1); }
});
test("setup reorder/update/failure/conflict/delete/legacy return affect subsequent forwarding only", async t => {
  const h = await poolHarness(t, (_req, res) => ok(res));
  const [first, second] = h.store.view().accounts;
  assert.equal((await h.mutate({ action: "reorder", ids: [second.id, first.id] })).status, 200);
  await (await h.chat()).text(); assert.equal(h.attempts[0].token, "Bearer sk-ant-oat01-second");
  const target = () => ({ id: second.id, generation: h.store.view().accounts[0].generation, expectedRevision: h.store.view().revision });
  h.setVerification(429);
  const failed = await h.post("/setup/token", { ...target(), token: "sk-ant-oat01-new" });
  assert.equal(failed.status, 429); assert.match(await failed.text(), /現在検証できません/);
  await (await h.chat()).text(); assert.equal(h.attempts[1].token, "Bearer sk-ant-oat01-second");
  h.setVerification(200);
  assert.equal((await h.post("/setup/token", { ...target(), token: "sk-ant-oat01-new" })).status, 200);
  await (await h.chat()).text(); assert.equal(h.attempts[2].token, "Bearer sk-ant-oat01-new");
  assert.equal((await h.add("first")).status, 409);
  let release!: () => void, entered!: () => void;
  const verifying = new Promise<void>(r => entered = r);
  h.setVerification(200, () => { entered(); return new Promise<void>(r => release = r); });
  const pending = h.post("/setup/token", { ...target(), token: "sk-ant-oat01-stale" });
  await verifying;
  assert.equal((await h.mutate({ action: "delete", id: second.id })).status, 200);
  release(); assert.equal((await pending).status, 409);
  await (await h.chat()).text(); assert.equal(h.attempts[3].token, "Bearer sk-ant-oat01-first");
  assert.equal((await h.mutate({ action: "delete", id: first.id })).status, 200);
  const empty = await h.chat(); assert.equal(empty.status, 503); assert.match(await empty.text(), /credentials_unavailable/);
  assert.equal(h.store.view().mode, "pool");
  assert.equal((await h.mutate({ action: "mode", mode: "legacy" })).status, 200);
  await (await h.chat()).text(); assert.equal(h.attempts[4].token, "Bearer sk-ant-oat01-original");
});
for (const stream of [false, true]) test(`pool disconnect aborts pre-open without switching, stream=${stream}`, async t => {
  let entered!: () => void, closed!: () => void;
  const started = new Promise<void>(r => entered = r), ended = new Promise<void>(r => closed = r);
  const h = await poolHarness(t, (_req, res) => { res.on("close", closed); entered(); });
  const controller = new AbortController();
  const pending = h.chat(stream, false, controller.signal);
  const aborted = assert.rejects(pending, { name: "AbortError" });
  await started; controller.abort(); await aborted;
  await Promise.race([ended, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("upstream not aborted")), 2000); ended.then(() => clearTimeout(timer)); })]);
  assert.equal(h.attempts.length, 1);
});
test("pool API key precedence is explicit and prevents activation without changing stored pool", async t => {
  const h = await poolHarness(t, (req, res) => { assert.equal(req.headers["x-api-key"], "fake-api-key"); ok(res); });
  process.env.ANTHROPIC_API_KEY = "fake-api-key";
  const view = await (await fetch(h.url + "/setup/accounts")).json() as any;
  assert.equal(view.effectiveSource, "env-api-key");
  assert.equal((await h.mutate({ action: "mode", mode: "pool" })).status, 409);
  const r = await h.chat(); assert.equal(r.status, 200); await r.text();
  assert.equal(h.store.view().mode, "pool");
});
