import { strict as assert } from "assert";
import { test, before, after } from "node:test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import {
  CodexTokens,
  createAuthorizationFlow,
  extractAccountId,
  getFreshCodexTokens,
  loadCodexTokens,
  parseAuthorizationInput,
  saveCodexTokens,
} from "../src/utils/codex_auth";

/** テスト用の JWT もどき（署名検証はしないので中身だけ本物の形にする）。 */
function fakeJwt(accountId: string, expSec: number): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "");
  return [
    b64({ alg: "none" }),
    b64({ exp: expSec, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
    "sig",
  ].join(".");
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermit-codex-test-"));
process.env.HERMIT_CODEX_AUTH_FILE = path.join(tmpDir, "auth.json");

// 偽トークンエンドポイント。受け取ったリクエストを記録して固定応答を返す。
let tokenRequests: Array<{ body: string }> = [];
const fakeTokenServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    tokenRequests.push({ body });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        access_token: fakeJwt("acct_refreshed", Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "rt_rotated",
        expires_in: 3600,
      })
    );
  });
});

before(async () => {
  await new Promise<void>((resolve) => fakeTokenServer.listen(0, "127.0.0.1", resolve));
  const tokenPort = (fakeTokenServer.address() as any).port;
  process.env.HERMIT_CODEX_TOKEN_URL = `http://127.0.0.1:${tokenPort}/oauth/token`;
});

after(() => {
  fakeTokenServer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("extractAccountId: JWT クレームから chatgpt_account_id を取り出す", () => {
  const jwt = fakeJwt("acct_123", 9999999999);
  assert.equal(extractAccountId(jwt), "acct_123");
  assert.equal(extractAccountId("not-a-jwt"), null);
});

test("createAuthorizationFlow: PKCE パラメータ一式が URL に載る", () => {
  const flow = createAuthorizationFlow();
  const url = new URL(flow.url);
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), flow.state);
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(flow.verifier.length >= 43); // RFC 7636 の最小長
});

test("parseAuthorizationInput: URL 全体・クエリ断片・コード単体を受け付ける", () => {
  const full = parseAuthorizationInput(
    "http://localhost:1455/auth/callback?code=abc&state=st1"
  );
  assert.deepEqual(full, { code: "abc", state: "st1" });
  const query = parseAuthorizationInput("code=xyz&state=st2");
  assert.deepEqual(query, { code: "xyz", state: "st2" });
  const bare = parseAuthorizationInput("  rawcode  ");
  assert.deepEqual(bare, { code: "rawcode" });
});

test("save/load: 0600 で保存され、読み戻せる", () => {
  const tokens: CodexTokens = {
    access_token: fakeJwt("acct_a", 9999999999),
    refresh_token: "rt_1",
    account_id: "acct_a",
    expires_at: Date.now() + 3600_000,
    last_refresh: new Date().toISOString(),
  };
  saveCodexTokens(tokens);
  const mode = fs.statSync(process.env.HERMIT_CODEX_AUTH_FILE!).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(loadCodexTokens(), tokens);
});

test("getFreshCodexTokens: 有効期限内はリフレッシュしない", async () => {
  tokenRequests = [];
  const tokens: CodexTokens = {
    access_token: fakeJwt("acct_a", 9999999999),
    refresh_token: "rt_1",
    account_id: "acct_a",
    expires_at: Date.now() + 3600_000,
    last_refresh: new Date().toISOString(),
  };
  saveCodexTokens(tokens);
  const fresh = await getFreshCodexTokens();
  assert.equal(fresh?.access_token, tokens.access_token);
  assert.equal(tokenRequests.length, 0);
});

test("getFreshCodexTokens: 失効間際はリフレッシュして永続化・ローテーション", async () => {
  tokenRequests = [];
  const stale: CodexTokens = {
    access_token: fakeJwt("acct_a", 0),
    refresh_token: "rt_old",
    account_id: "acct_a",
    expires_at: Date.now() + 10_000, // 60 秒マージン内 → リフレッシュ対象
    last_refresh: new Date().toISOString(),
  };
  saveCodexTokens(stale);
  const fresh = await getFreshCodexTokens();
  assert.equal(tokenRequests.length, 1);
  const params = new URLSearchParams(tokenRequests[0].body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "rt_old");
  assert.equal(params.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(fresh?.account_id, "acct_refreshed");
  assert.equal(fresh?.refresh_token, "rt_rotated");
  // ローテーションされた refresh_token がファイルにも反映されている
  assert.equal(loadCodexTokens()?.refresh_token, "rt_rotated");
});

test("getFreshCodexTokens: 未ログインなら null", async () => {
  fs.rmSync(process.env.HERMIT_CODEX_AUTH_FILE!, { force: true });
  assert.equal(await getFreshCodexTokens(), null);
});
