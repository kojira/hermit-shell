import { strict as assert } from "assert";
import { test, before, after } from "node:test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

/** /setup/codex/* エンドポイントの検証。OpenAI へは一切アクセスしない。 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermit-codex-setup-test-"));
process.env.HERMIT_CODEX_AUTH_FILE = path.join(tmpDir, "auth.json");

let appServer: http.Server;
let baseUrl: string;

before(async () => {
  const app = require("../src/server").default;
  await new Promise<void>((resolve) => {
    appServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(appServer.address() as any).port}`;
});

after(() => {
  const { cancelCodexLogin } = require("../src/handlers/codex_setup");
  cancelCodexLogin();
  appServer?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("finish はログイン未開始なら 400", async () => {
  const r = await fetch(`${baseUrl}/setup/codex/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "code=abc" }),
  });
  assert.equal(r.status, 400);
});

test("start は認可 URL を返し、status が pending を報告する", async () => {
  const r = await fetch(`${baseUrl}/setup/codex/start`, { method: "POST" });
  assert.equal(r.status, 200);
  const data = (await r.json()) as any;
  const url = new URL(data.url);
  assert.equal(url.origin, "https://auth.openai.com");
  assert.ok(url.searchParams.get("code_challenge"));

  const s = await fetch(`${baseUrl}/setup/codex/status`);
  const sd = (await s.json()) as any;
  assert.equal(sd.pendingActive, true);
  assert.equal(sd.status.configured, false);
});

test("finish は state 不一致を拒否する", async () => {
  const r = await fetch(`${baseUrl}/setup/codex/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: "http://localhost:1455/auth/callback?code=abc&state=WRONG",
    }),
  });
  assert.equal(r.status, 400);
  const data = (await r.json()) as any;
  assert.match(data.error, /state/);
});

test("setup ページに codex カードが載る", async () => {
  const r = await fetch(`${baseUrl}/setup`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /OpenAI Codex/);
  assert.match(html, /codex-start/);
});
