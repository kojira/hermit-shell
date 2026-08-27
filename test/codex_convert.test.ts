import { strict as assert } from "assert";
import { test } from "node:test";
import {
  CodexSSEParser,
  aggregateToOpenAIResponse,
  applyCodexEvent,
  buildCodexRequestBody,
  codexFinishReason,
  createAggregate,
  finalText,
  getCodexResponsesUrl,
  isCodexModel,
  truncateAtStop,
} from "../src/utils/codex_convert";

test("isCodexModel: gpt-* だけを codex に振る", () => {
  assert.equal(isCodexModel("gpt-5.6-luna"), true);
  assert.equal(isCodexModel("gpt-5.3-codex"), true);
  assert.equal(isCodexModel("claude-sonnet-4-6"), false);
  assert.equal(isCodexModel("bonsai-8b"), false);
});

test("getCodexResponsesUrl: base の形に依らず /codex/responses に正規化", () => {
  const prev = process.env.HERMIT_CODEX_BASE_URL;
  try {
    delete process.env.HERMIT_CODEX_BASE_URL;
    assert.equal(getCodexResponsesUrl(), "https://chatgpt.com/backend-api/codex/responses");
    process.env.HERMIT_CODEX_BASE_URL = "http://127.0.0.1:9999/";
    assert.equal(getCodexResponsesUrl(), "http://127.0.0.1:9999/codex/responses");
    process.env.HERMIT_CODEX_BASE_URL = "http://127.0.0.1:9999/codex";
    assert.equal(getCodexResponsesUrl(), "http://127.0.0.1:9999/codex/responses");
  } finally {
    if (prev === undefined) delete process.env.HERMIT_CODEX_BASE_URL;
    else process.env.HERMIT_CODEX_BASE_URL = prev;
  }
});

test("buildCodexRequestBody: system→instructions、危険パラメータは送らない", () => {
  const body = buildCodexRequestBody(
    {
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: "You are a test agent." },
        { role: "user", content: "hello" },
      ],
      temperature: 0.7,
      max_tokens: 1000,
      stop: ["<end>"],
    } as any,
    true
  );
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "You are a test agent.");
  assert.deepEqual(body.input, [{ role: "user", content: "hello" }]);
  // backend が拒否するパラメータは決して送らない（opencrab chatgpt.rs:755-756）
  assert.equal("max_tokens" in body, false);
  assert.equal("max_output_tokens" in body, false);
  assert.equal("stop" in body, false);
  assert.equal("temperature" in body, false); // 既定では落とす
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, true);
  assert.deepEqual(body.reasoning, { effort: "low" });
});

test("buildCodexRequestBody: system が無くても instructions を必ず入れる", () => {
  const body = buildCodexRequestBody(
    { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] } as any,
    true
  );
  // instructions 空は 400 になる（opencrab chatgpt.rs:766-771）
  assert.equal(body.instructions, "You are a helpful assistant.");
});

test("buildCodexRequestBody: tool 履歴を function_call / function_call_output に変換", () => {
  const body = buildCodexRequestBody(
    {
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "search something" },
        {
          role: "assistant",
          content: "searching...",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "web_search", arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "result text" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "required",
    } as any,
    true
  );
  assert.deepEqual(body.input, [
    { role: "user", content: "search something" },
    { role: "assistant", content: [{ type: "output_text", text: "searching..." }] },
    { type: "function_call", call_id: "call_1", name: "web_search", arguments: '{"q":"x"}' },
    { type: "function_call_output", call_id: "call_1", output: "result text" },
  ]);
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "web_search",
      description: "search",
      parameters: { type: "object", properties: {} },
    },
  ]);
  assert.equal(body.tool_choice, "required");
});

test("CodexSSEParser: チャンク分割をまたぐイベントを正しく切り出す", () => {
  const parser = new CodexSSEParser();
  const events1 = parser.feed('data: {"type":"response.output_text.delta","delta":"Hel');
  assert.equal(events1.length, 0);
  const events2 = parser.feed('lo"}\n\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\ndata: [DONE]\n\n');
  assert.equal(events2.length, 2);
  assert.equal(events2[0].delta, "Hello");
  assert.equal(events2[1].type, "response.completed");
});

test("集約: テキスト + usage + finish_reason", () => {
  const agg = createAggregate();
  applyCodexEvent(agg, { type: "response.created", response: { id: "resp_1" } });
  const d1 = applyCodexEvent(agg, { type: "response.output_text.delta", delta: "Hello " });
  const d2 = applyCodexEvent(agg, { type: "response.output_text.delta", delta: "world" });
  assert.equal(d1.textDelta, "Hello ");
  assert.equal(d2.textDelta, "world");
  applyCodexEvent(agg, { type: "response.reasoning_summary_text.delta", delta: "thinking" });
  applyCodexEvent(agg, {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 4 },
      },
    },
  });
  assert.equal(agg.done, true);
  assert.equal(codexFinishReason(agg), "stop");

  const res = aggregateToOpenAIResponse(agg, "gpt-5.6-luna", "chatcmpl-x", 123) as any;
  assert.equal(res.object, "chat.completion");
  assert.equal(res.model, "gpt-5.6-luna");
  assert.equal(res.codex_response_id, "resp_1");
  assert.equal(res.choices[0].message.content, "Hello world");
  assert.equal(res.choices[0].message.reasoning_content, "thinking");
  assert.equal(res.choices[0].finish_reason, "stop");
  assert.equal(res.usage.prompt_tokens, 10);
  assert.equal(res.usage.completion_tokens, 5);
  assert.equal(res.usage.total_tokens, 15);
  assert.equal(res.usage.prompt_tokens_details.cached_tokens, 4);
});

test("集約: tool call（重複 call_id は 1 回だけ）と finish_reason=tool_calls", () => {
  const agg = createAggregate();
  applyCodexEvent(agg, {
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "call_9", name: "f", arguments: '{"a":1}' },
  });
  applyCodexEvent(agg, {
    type: "response.completed",
    response: {
      id: "r",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_9", name: "f", arguments: '{"a":1}' }],
    },
  });
  assert.equal(agg.toolCalls.length, 1);
  assert.equal(codexFinishReason(agg), "tool_calls");
  const res = aggregateToOpenAIResponse(agg, "gpt-5.5", "id", 0) as any;
  assert.deepEqual(res.choices[0].message.tool_calls, [
    { id: "call_9", type: "function", function: { name: "f", arguments: '{"a":1}' } },
  ]);
});

test("集約: max_output_tokens 打ち切りは length 優先（opencrab #676 と同じ）", () => {
  const agg = createAggregate();
  applyCodexEvent(agg, { type: "response.output_text.delta", delta: "partial" });
  applyCodexEvent(agg, {
    type: "response.incomplete",
    response: {
      id: "r",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    },
  });
  assert.equal(agg.truncated, true);
  assert.equal(codexFinishReason(agg), "length");
});

test("集約: error / response.failed はエラーとして拾う", () => {
  const agg1 = createAggregate();
  applyCodexEvent(agg1, { type: "error", message: "boom" });
  assert.equal(agg1.error, "boom");

  const agg2 = createAggregate();
  applyCodexEvent(agg2, {
    type: "response.failed",
    response: { error: { code: "x", message: "failed hard" } },
  });
  assert.equal(agg2.error, "failed hard");
});

test("truncateAtStop: 最初の stop 文字列の末尾で切る（JIT と同じ規則）", () => {
  assert.equal(truncateAtStop("abc<end>def", ["<end>"]), "abc<end>");
  assert.equal(truncateAtStop("abcdef", ["<end>"]), "abcdef");
  assert.equal(truncateAtStop("abcdef", undefined), "abcdef");
  assert.equal(truncateAtStop("a|b;c", [";", "|"]), "a|b;"); // 配列順に最初のヒット
});

test("buildCodexRequestBody: assistant 履歴は output_text パーツになる (2026-08-28 実測 400 の回帰)", () => {
  const body: any = {
    model: "gpt-5.6-luna",
    messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ],
  };
  const req: any = buildCodexRequestBody(body, false);
  const asst = req.input.find((m: any) => m.role === "assistant");
  assert.deepEqual(asst.content, [{ type: "output_text", text: "a1" }]);
  // user 側は input 系のまま
  const users = req.input.filter((m: any) => m.role === "user");
  assert.equal(typeof users[0].content, "string");
  assert.equal(users[1].content[0].type, "input_text");
});

test("buildCodexRequestBody: tool_call つき assistant の本文も output_text", () => {
  const body: any = {
    model: "gpt-5.6-luna",
    messages: [
      { role: "assistant", content: "calling", tool_calls: [
        { id: "c1", function: { name: "f", arguments: "{}" } } ] },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ],
  };
  const req: any = buildCodexRequestBody(body, false);
  const asst = req.input.find((m: any) => m.role === "assistant");
  assert.deepEqual(asst.content, [{ type: "output_text", text: "calling" }]);
});

/** 複数 message アイテムの集約を作るヘルパ (2026-08-28 実測: verbosity=medium で
 *  message アイテム 7 個(ほぼ同一 JSON)が 1 応答に出る — その縮小版 3 個)。 */
function aggregateWithBlocks(blocks: string[]) {
  const agg = createAggregate();
  for (const text of blocks) {
    applyCodexEvent(agg, { type: "response.output_item.added", item: { type: "message" } });
    applyCodexEvent(agg, { type: "response.output_text.delta", delta: text });
  }
  return agg;
}

test("finalText: 複数 message アイテムは既定(concat)で \\n\\n 連結", () => {
  const prev = process.env.HERMIT_CODEX_TEXT_MODE;
  try {
    delete process.env.HERMIT_CODEX_TEXT_MODE;
    const agg = aggregateWithBlocks(['{"a":1}', '{"a":2}', '{"a":3}']);
    // content 直読みだと {...}{...}{...} になり strict-JSON 消費者が壊れる
    assert.equal(agg.content, '{"a":1}{"a":2}{"a":3}');
    assert.equal(finalText(agg), '{"a":1}\n\n{"a":2}\n\n{"a":3}');
    // 非ストリーミング応答も finalText 経由
    const res = aggregateToOpenAIResponse(agg, "gpt-5.6-luna", "id", 0) as any;
    assert.equal(res.choices[0].message.content, '{"a":1}\n\n{"a":2}\n\n{"a":3}');
  } finally {
    if (prev === undefined) delete process.env.HERMIT_CODEX_TEXT_MODE;
    else process.env.HERMIT_CODEX_TEXT_MODE = prev;
  }
});

test("finalText: HERMIT_CODEX_TEXT_MODE=last は最後の非空ブロックを返す", () => {
  const prev = process.env.HERMIT_CODEX_TEXT_MODE;
  try {
    process.env.HERMIT_CODEX_TEXT_MODE = "last";
    const agg = aggregateWithBlocks(['{"a":1}', '{"a":2}', '{"a":3}']);
    assert.equal(finalText(agg), '{"a":3}');
    // 空ブロック（deltaが来なかった message アイテム）は飛ばす
    const agg2 = aggregateWithBlocks(['{"a":1}', '{"a":2}']);
    applyCodexEvent(agg2, { type: "response.output_item.added", item: { type: "message" } });
    assert.equal(finalText(agg2), '{"a":2}');
  } finally {
    if (prev === undefined) delete process.env.HERMIT_CODEX_TEXT_MODE;
    else process.env.HERMIT_CODEX_TEXT_MODE = prev;
  }
});

test("finalText: 単一 message アイテムなら content と同一（後方互換）", () => {
  const agg = aggregateWithBlocks(["Hello world"]);
  assert.equal(finalText(agg), agg.content);
  assert.equal(finalText(agg), "Hello world");
  // output_item.added を出さない backend でも delta だけでブロックが立つ
  const agg2 = createAggregate();
  applyCodexEvent(agg2, { type: "response.output_text.delta", delta: "no added event" });
  assert.equal(agg2.textBlocks.length, 1);
  assert.equal(finalText(agg2), agg2.content);
});
