import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateMessage,
  escapeControlCharsInJsonStrings,
  parseToolInputJson,
} from "./message_accumulator";

async function* events(list: Array<Record<string, unknown>>) {
  for (const e of list) yield e;
}

function toolStream(chunks: string[]) {
  return [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Run" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "bash", input: {} } },
    ...chunks.map((partial_json) => ({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json } })),
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9, cache_read_input_tokens: 3 } },
    { type: "message_stop" },
  ];
}

test("raw control characters inside tool input strings are preserved instead of aborting", async () => {
  // 実障害: モデルが文字列中に生の改行・タブを出し、SDK の逐次 parse が例外で応答全体を失った。
  const texts: string[] = [];
  const msg = await accumulateMessage(
    events(toolStream(['{"command":"echo a', "\nb\tc", '","x":1}'])),
    (t) => texts.push(t)
  );
  assert.deepEqual(texts, ["Run"]);
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.usage, { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 3 });
  assert.deepEqual(msg.content[1], { type: "tool_use", id: "t1", name: "bash", input: { command: "echo a\nb\tc", x: 1 } });
});

test("valid JSON split at escapes and unicode sequences parses exactly", async () => {
  const msg = await accumulateMessage(events(toolStream(['{"a":"x\\', 'ny\\u00', '41\\\\"}'])));
  assert.deepEqual(msg.content[1].input, { a: "x\nyA\\" });
});

test("tool without input deltas keeps its start input", async () => {
  const msg = await accumulateMessage(events(toolStream([])));
  assert.deepEqual(msg.content[1].input, {});
});

test("structurally invalid tool JSON still fails honestly", async () => {
  await assert.rejects(accumulateMessage(events(toolStream(['{"a":']))), SyntaxError);
});

test("control escaping touches only string contents", () => {
  assert.equal(escapeControlCharsInJsonStrings('{\n "a": "b\nc\\"\t"\n}'), '{\n "a": "b\\u000ac\\"\\u0009"\n}');
  assert.deepEqual(parseToolInputJson("  "), {});
});

test("event before message_start is rejected", async () => {
  await assert.rejects(accumulateMessage(events([{ type: "message_stop" }])), /Unexpected event order/);
});
