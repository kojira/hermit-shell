import { test } from "node:test";
import assert from "node:assert/strict";
import { convertUsage } from "./usage";
import { createUsageChunk } from "./stream";
import { convertResponse } from "./convert";
import { convertResponseWithTools } from "./tool_convert";

const usage = { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 14519, cache_creation_input_tokens: 350000 };
const expected = {
  ...usage, prompt_tokens: 364521, completion_tokens: 7, total_tokens: 364528,
  prompt_tokens_details: { cached_tokens: 14519, cache_write_tokens: 350000 },
};

test("cache counters survive non-streaming and streaming OpenAI conversion", () => {
  assert.deepEqual(convertUsage(usage), expected);
  const response = { id: "msg", model: "claude-sonnet-4-6", usage, content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" };
  assert.deepEqual(convertResponse(response, response.model).usage, expected);
  assert.deepEqual((convertResponseWithTools(response, response.model) as { usage: unknown }).usage, expected);
  const chunk = JSON.parse(createUsageChunk("id", response.model, 0, usage).slice(6).trim());
  assert.deepEqual(chunk.usage, expected);
});

test("missing cache fields retain valid OpenAI totals", () => {
  assert.deepEqual(convertUsage({ input_tokens: 5, output_tokens: 3 }), {
    input_tokens: 5, output_tokens: 3, prompt_tokens: 5, completion_tokens: 3,
    total_tokens: 8, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  });
});
