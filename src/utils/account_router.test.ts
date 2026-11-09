import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APIError } from "@anthropic-ai/sdk";
import { AccountStore } from "./accounts";
import { AccountRouter, PoolUnavailableError } from "./account_router";
const quota = () => new APIError(429, { error: { type: "rate_limit_error" } }, "fixture", new Headers({ "anthropic-ratelimit-unified-7d-status": "rejected" }));
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "account-router-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore(join(dir, "accounts.json"));
  for (const name of ["first", "second"]) store.saveToken({ expectedRevision: store.view().revision, name }, `sk-ant-oat-${name}`);
  return { store, router: new AccountRouter(store) };
}
test("router snapshots IDs, uses updated generation just before sending and excludes mid-request additions", async t => {
  const { store, router } = fixture(t), ids = store.snapshot();
  const tokens: string[] = [];
  await assert.rejects(router.run(undefined, async (client, token) => {
    tokens.push(token); assert.equal(client.authToken, token); assert.equal(client.apiKey, null); assert.equal(client.maxRetries, 0);
    if (tokens.length === 1) {
      store.saveToken({ expectedRevision: 2, id: ids[1], generation: 1 }, "sk-ant-oat-updated");
      store.saveToken({ expectedRevision: 3, name: "third" }, "sk-ant-oat-added");
    }
    throw quota();
  }), PoolUnavailableError);
  assert.deepEqual(tokens, ["sk-ant-oat-first", "sk-ant-oat-updated"]);
  const next = await router.run(undefined, async (_client, token) => token);
  assert.equal(next, "sk-ant-oat-first");
});
test("router skips deleted unsent IDs and never retries after upstream opened", async t => {
  const { store, router } = fixture(t), ids = store.snapshot();
  let count = 0;
  await assert.rejects(router.run(undefined, async (_client, _token, opened) => {
    count++; store.mutate({ action: "delete", id: ids[1], expectedRevision: 2 }); opened(); throw quota();
  }), APIError);
  assert.equal(count, 1);
  assert.equal(store.view().accounts.length, 1);
});
test("ambiguous 429 preserves the last quota observation without switching", async t => {
  const { store, router } = fixture(t);
  const lease = store.acquire(store.snapshot()[0])!;
  store.observe(lease, { state: "exhausted", reason: "weekly", retryAt: 1, retryBasis: "provider", failureCount: 0 });
  let count = 0;
  const before = store.view().accounts[0].observed;
  await assert.rejects(router.run(undefined, async () => { count++; throw new APIError(429, {}, "fixture", new Headers()); }), APIError);
  const a = store.view().accounts[0];
  assert.deepEqual(a.observed, before); assert.equal(count, 1);
});
test("all-reauth and mixed unavailable return 503, not all-exhausted 429", t => {
  const { store } = fixture(t), ids = store.snapshot();
  store.observe(store.acquire(ids[0])!, { state: "reauth", reason: "unauthorized", retryAt: null, retryBasis: null, failureCount: 0 });
  store.observe(store.acquire(ids[1])!, { state: "exhausted", reason: "weekly", retryAt: Date.now() + 60000, retryBasis: "provider", failureCount: 0 });
  assert.deepEqual(store.unavailable(), { status: 503, code: "credentials_unavailable" });
});
