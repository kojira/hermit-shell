import { strict as assert } from "assert";
import { test } from "node:test";
import {
  CodexSSEParser,
  aggregateToOpenAIResponse,
  applyCodexEvent,
  buildCodexRequestBody,
  codexFinishReason,
  createAggregate,
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
    { role: "assistant", content: "searching..." },
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
