import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicRequestWithTools } from "./chat";
import { convertRequest, OpenAIChatRequest } from "../utils/convert";

const cases = [
  { name: "no limit supplied", fields: {}, expected: 4096 },
  { name: "legacy max_tokens", fields: { max_tokens: 2048 }, expected: 2048 },
  { name: "modern max_completion_tokens", fields: { max_completion_tokens: 13107 }, expected: 13107 },
  {
    name: "both supplied (legacy wins for compatibility)",
    fields: { max_tokens: 2048, max_completion_tokens: 13107 },
    expected: 2048,
  },
] as const;

for (const { name, fields, expected } of cases) {
  for (const stream of [false, true]) {
    for (const tools of [false, true]) {
      test(`${name}: stream=${stream}, tools=${tools}`, () => {
        const request: OpenAIChatRequest = {
          model: "claude-opus-5-5",
          messages: [{ role: "user", content: "Hello" }],
          stream,
          ...fields,
        };
        const converted = tools
          ? buildAnthropicRequestWithTools({
              ...request,
              tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
            })
          : convertRequest(request);
        assert.equal(converted.max_tokens, expected);
        assert.ok(!("max_completion_tokens" in converted));
      });
    }
  }
}
