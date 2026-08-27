import { strict as assert } from "assert";
import { test, before, after } from "node:test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

/**
 * 偽 codex backend を立てて、express アプリ全体を通した end-to-end
 * （認証ファイル読み込み → ルーティング → リクエスト変換 → SSE 集約/転送）を検証する。
 * 本物の chatgpt.com には一切アクセスしない。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermit-codex-chat-test-"));
process.env.HERMIT_CODEX_AUTH_FILE = path.join(tmpDir, "auth.json");

// テストから本物の Anthropic へ跳ねないように必ず外す（Claude 経路は構築時に落ちて 500 になる）。
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

// 偽 backend が最後に受け取ったリクエスト（変換の検証に使う）
let lastBackendRequest: { headers: http.IncomingHttpHeaders; body: any } | null = null;
let backendMode: "text" | "toolcall" | "error401" = "text";

const fakeBackend = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastBackendRequest = { headers: req.headers, body: JSON.parse(body) };
    if (req.url !== "/codex/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (backendMode === "error401") {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { code: "token_expired", message: "expired" } }));
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    const write = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    write({ type: "response.created", response: { id: "resp_fake" } });
    if (backendMode === "text") {
      write({ type: "response.reasoning_summary_text.delta", delta: "let me think" });
      write({ type: "response.output_text.delta", delta: "Hello " });
      write({ type: "response.output_text.delta", delta: "from codex" });
      write({
        type: "response.completed",
        response: {
          id: "resp_fake",
          status: "completed",
          usage: {
            input_tokens: 20,
            output_tokens: 7,
            total_tokens: 27,
            input_tokens_details: { cached_tokens: 3 },
          },
        },
      });
    } else {
      write({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_t1",
          name: "web_search",
          arguments: '{"q":"news"}',
        },
      });
      write({
        type: "response.completed",
        response: {
          id: "resp_fake",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

let appServer: http.Server;
let baseUrl: string;

function fakeJwt(accountId: string): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "");
  return [
    b64({ alg: "none" }),
    b64({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
    "sig",
  ].join(".");
}

function writeAuthFile(): void {
  fs.writeFileSync(
    process.env.HERMIT_CODEX_AUTH_FILE!,
    JSON.stringify({
      access_token: fakeJwt("acct_e2e"),
      refresh_token: "rt_e2e",
      account_id: "acct_e2e",
      expires_at: Date.now() + 3600_000,
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 }
  );
}

before(async () => {
  await new Promise<void>((resolve) => fakeBackend.listen(0, "127.0.0.1", resolve));
  const backendPort = (fakeBackend.address() as any).port;
  process.env.HERMIT_CODEX_BASE_URL = `http://127.0.0.1:${backendPort}`;

  // env を整えてからアプリを読み込む
  const app = require("../src/server").default;
  await new Promise<void>((resolve) => {
    appServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(appServer.address() as any).port}`;
});

after(() => {
  appServer?.close();
  fakeBackend.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("未ログインの gpt-* リクエストは 503（Claude 経路には行かない）", async () => {
  fs.rmSync(process.env.HERMIT_CODEX_AUTH_FILE!, { force: true });
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(r.status, 503);
  const data = (await r.json()) as any;
  assert.match(data.error.message, /codex auth not configured/);
});

test("非ストリーミング: SSE を集約して chat.completion を返す", async () => {
  writeAuthFile();
  backendMode = "text";
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    }),
  });
  assert.equal(r.status, 200);
  const data = (await r.json()) as any;
  assert.equal(data.object, "chat.completion");
  assert.equal(data.model, "gpt-5.6-luna");
  assert.equal(data.choices[0].message.content, "Hello from codex");
  assert.equal(data.choices[0].message.reasoning_content, "let me think");
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(data.usage.prompt_tokens, 20);
  assert.equal(data.usage.completion_tokens, 7);
  assert.equal(data.usage.total_tokens, 27);

  // backend が受けたリクエストの検証（プロトコル契約）
  const sent = lastBackendRequest!;
  assert.equal(sent.headers["authorization"], `Bearer ${fakeJwt("acct_e2e")}`);
  assert.equal(sent.headers["chatgpt-account-id"], "acct_e2e");
  assert.equal(sent.headers["openai-beta"], "responses=experimental");
  assert.equal(sent.headers["originator"], "pi");
  assert.equal(sent.body.model, "gpt-5.6-luna");
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.stream, true); // 非ストリーミング要求でも backend へは stream
  assert.equal(sent.body.instructions, "be brief");
});

test("非ストリーミング: tool call を tool_calls に変換して返す", async () => {
  writeAuthFile();
  backendMode = "toolcall";
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "search" }],
      tools: [
        {
          type: "function",
          function: { name: "web_search", parameters: { type: "object" } },
        },
      ],
    }),
  });
  assert.equal(r.status, 200);
  const data = (await r.json()) as any;
  assert.equal(data.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(data.choices[0].message.tool_calls, [
    {
      id: "call_t1",
      type: "function",
      function: { name: "web_search", arguments: '{"q":"news"}' },
    },
  ]);
});

test("ストリーミング: OpenAI chunk 形式で転送し [DONE] で終わる", async () => {
  writeAuthFile();
  backendMode = "text";
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const text = await r.text();
  const chunks = text
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  // 初期チャンク（role）→ テキストデルタ → 最終チャンク → usage チャンク
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  const content = chunks
    .map((c) => c.choices?.[0]?.delta?.content ?? "")
    .join("");
  assert.equal(content, "Hello from codex");
  const finalChunk = chunks.find((c) => c.choices?.[0]?.finish_reason === "stop");
  assert.ok(finalChunk, "finish_reason=stop のチャンクがある");
  const usageChunk = chunks.find((c) => c.usage);
  assert.equal(usageChunk.usage.prompt_tokens, 20);
  assert.equal(usageChunk.usage.completion_tokens, 7);
});

test("backend の 401 はステータスごと透過する（JIT 側のリトライ判定に任せる）", async () => {
  writeAuthFile();
  backendMode = "error401";
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(r.status, 401);
  const data = (await r.json()) as any;
  assert.equal(data.error.message, "expired");
});

test("/v1/models に codex モデルが載り、claude モデルも残っている", async () => {
  const r = await fetch(`${baseUrl}/v1/models`);
  const data = (await r.json()) as any;
  const ids = data.data.map((m: any) => m.id);
  assert.ok(ids.includes("gpt-5.6-luna"));
  assert.ok(ids.includes("claude-sonnet-4-5"));
  assert.ok(ids.includes("bonsai-8b"));
});

test("claude モデルは codex 経路に入らない（未変更の Claude 経路が応答を試みる）", async () => {
  // ANTHROPIC_* が無い環境では Claude 経路は SDK 初期化 or API 呼び出しで落ちて
  // 500 系になるが、codex の 503 メッセージにはならないことだけを確認する。
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const data = (await r.json()) as any;
  assert.notEqual(r.status, 503);
  assert.ok(!String(data?.error?.message || "").includes("codex auth not configured"));
});
