import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { createServer, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import app from "../server";
import { resetClient } from "./chat";

// Synthetic protocol fixtures, NOT recorded incident responses.
const rateLimit = { type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } };
const expectedError = {
  message: "Upstream rate limit exceeded", type: "rate_limit_error",
  code: "rate_limit_exceeded", param: null,
};
const tool = { type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } };
function event(data: object): string {
  return `event: ${(data as any).type}\ndata: ${JSON.stringify(data)}\n\n`;
}
const start = event({ type: "message_start", message: {
  id: "msg_fixture", type: "message", role: "assistant", model: "claude-fixture", content: [],
  stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 },
} }) + event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } });
const finish = event({ type: "content_block_stop", index: 0 }) +
  event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
  event({ type: "message_stop" });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function harness(t: TestContext, respond: (res: ServerResponse, attempt: number) => void, oauth = false) {
  let attempts = 0;
  const upstream = createServer((req, res) => {
    assert.equal(req.url, "/v1/messages");
    req.resume();
    req.on("end", () => respond(res, ++attempts));
  });
  const upstreamUrl = await listen(upstream);
  const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.ANTHROPIC_BASE_URL = upstreamUrl;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env[oauth ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = "offline-fixture-not-a-secret";
  resetClient();
  const downstreamServer = createServer(app);
  const downstream = await listen(downstreamServer);
  t.after(async () => {
    await close(downstreamServer);
    await close(upstream);
    resetClient();
    keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]);
  });
  return {
    attempts: () => attempts,
    post: (stream: boolean, tools = false, signal?: AbortSignal) => fetch(`${downstream}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fixture", messages: [{ role: "user", content: "fixture" }],
        stream, ...(tools ? { tools: [tool] } : {}), stream_options: { include_usage: true } }),
      signal: signal ?? AbortSignal.timeout(10000),
    }),
  };
}

for (const stream of [false, true]) for (const tools of [false, true]) {
  test(`HTTP429 fails fast: stream=${stream}, tools=${tools}`, async (t) => {
    const scheduled: number[] = [];
    const original = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (...args: any[]) => {
      scheduled.push(args[1]);
      return (original as any)(...args);
    });
    const h = await harness(t, (res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1", "x-should-retry": "true" });
      res.end(JSON.stringify(rateLimit));
    }, tools);
    const response = await h.post(stream, tools);
    const body = await response.text();
    assert.equal(h.attempts(), 1, "HTTP429 must never be retried by installed SDK");
    assert.equal(scheduled.includes(1000), false, "Retry-After must not schedule SDK sleep");
    assert.equal(response.status, 429);
    assert.match(response.headers.get("content-type")!, /application\/json/);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(JSON.parse(body), { error: expectedError });
  });
}

for (const [header, expected] of [
  [undefined, null], ["0", "0"], ["Wed, 07 Oct 2026 21:17:38 GMT", "Wed, 07 Oct 2026 21:17:38 GMT"],
  ["Wednesday, 07-Oct-26 21:17:38 GMT", "Wednesday, 07-Oct-26 21:17:38 GMT"],
  ["Wed Oct  7 21:17:38 2026", "Wed Oct  7 21:17:38 2026"],
  ["-1", null], ["1.5", null], ["tomorrow", null], ["2026-10-07", null],
  ["Wed, 31 Feb 2027 21:17:38 GMT", null],
] as const) {
  test(`HTTP429 Retry-After validation: ${header}`, async (t) => {
    const h = await harness(t, (res) => {
      res.writeHead(429, { "content-type": "application/json", "x-should-retry": "false",
        ...(header === undefined ? {} : { "retry-after": header }) });
      res.end(JSON.stringify(rateLimit));
    });
    const response = await h.post(false);
    await response.text();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), expected);
    assert.equal(h.attempts(), 1);
  });
}

for (const tools of [false, true]) {
  test(`committed SSE rate limit is typed and terminal, tools=${tools}`, async (t) => {
    let release!: () => void;
    let opened!: () => void;
    const upstreamOpened = new Promise<void>((resolve) => opened = resolve);
    const h = await harness(t, (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(start);
      release = () => res.end(event(rateLimit));
      opened();
    });
    const response = await h.post(true, tools);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    let body = new TextDecoder().decode(first.value);
    await upstreamOpened;
    release(); // Only inject the error after downstream headers/chunk are observed.
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += new TextDecoder().decode(chunk.value);
    }
    const frames = body.split("\n\n").filter(Boolean).map((s) => s.slice(6));
    assert.equal(frames[frames.length - 1], "[DONE]");
    assert.equal(frames.filter((s) => s === "[DONE]").length, 1);
    const chunks = frames.slice(0, -1).map((s) => JSON.parse(s));
    assert.deepEqual(chunks[chunks.length - 1], { error: { ...expectedError, status: 429 } });
    assert.ok(chunks.slice(0, -1).every((c) => c.choices?.[0]?.finish_reason === null && !c.usage && !c.choices[0].delta.tool_calls));
    assert.equal(h.attempts(), 1);
  });
  test(`nonstream structured rate limit becomes HTTP429, tools=${tools}`, async (t) => {
    const h = await harness(t, (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(start + event(rateLimit));
    });
    const response = await h.post(false, tools);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: expectedError });
    assert.equal(response.headers.get("retry-after"), null);
    assert.equal(h.attempts(), 1);
  });
}

// Actual retained log structural projection: service.stderr.log:2703–2747,
// Oct7, SDK status undefined; NOT a full replay and NOT incident-window evidence.
const recordedOverloadProjection = { type: "error", error: { type: "overloaded_error" } };
for (const payload of [recordedOverloadProjection,
  { type: "error", error: { type: "api_error", message: "path df42962 mentions 429 rate_limit_error" } }]) {
  for (const stream of [false, true]) test(`does not classify ${payload.error.type} text as rate limit, stream=${stream}`, async (t) => {
    const h = await harness(t, (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(start + event(payload));
    });
    const response = await h.post(stream);
    assert.equal(response.status, stream ? 200 : 500);
    const body = await response.text();
    const error = stream ? JSON.parse(body.split("\n\n").find((s) => s.startsWith('data: {"error":'))!.slice(6)).error : JSON.parse(body).error;
    assert.equal(error.type, "api_error");
    assert.notEqual(error.status, 429);
    assert.equal(h.attempts(), 1);
  });
}

for (const stream of [false, true]) test(`HTTP503 retains SDK retry and success, stream=${stream}`, async (t) => {
  const h = await harness(t, (res, attempt) => {
    if (attempt === 1) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0.01" });
      res.end(JSON.stringify(recordedOverloadProjection));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(start + finish);
    }
  });
  const response = await h.post(stream);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(h.attempts(), 2);
  if (stream) {
    assert.match(body, /"finish_reason":"stop"/);
    assert.match(body, /"usage":/);
    assert.ok(body.endsWith("data: [DONE]\n\n"));
  } else assert.equal(JSON.parse(body).choices[0].message.content, "hello");
});

test("pre-open non429 error retains the generic HTTP200 SSE contract", async (t) => {
  const h = await harness(t, (res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "not a 429" } }));
  });
  const response = await h.post(true);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.match(body, /"type":"api_error"/);
  assert.ok(body.endsWith("data: [DONE]\n\n"));
  assert.equal(h.attempts(), 1);
});

test("disconnect while awaiting upstream headers still aborts the SDK request", async (t) => {
  let opened!: () => void;
  let closed!: () => void;
  const upstreamOpened = new Promise<void>((resolve) => opened = resolve);
  const upstreamClosed = new Promise<void>((resolve) => closed = resolve);
  const h = await harness(t, (res) => {
    res.on("close", closed);
    opened(); // Do not send upstream headers.
  });
  const controller = new AbortController();
  const pending = h.post(true, false, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await upstreamOpened;
  controller.abort();
  await rejected;
  await Promise.race([upstreamClosed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("pre-open upstream not aborted")), 2000);
    upstreamClosed.then(() => clearTimeout(timer));
  })]);
  assert.equal(h.attempts(), 1);
});

test("downstream disconnect aborts upstream after stream opened", async (t) => {
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => closed = resolve);
  const h = await harness(t, (res) => {
    res.on("close", closed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(start);
  });
  const controller = new AbortController();
  const response = await h.post(true, false, controller.signal);
  await response.body!.getReader().read();
  controller.abort();
  await Promise.race([upstreamClosed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("upstream not aborted")), 2000);
    upstreamClosed.then(() => clearTimeout(timer));
  })]);
  assert.equal(h.attempts(), 1);
});
