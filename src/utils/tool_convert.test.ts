import assert from "node:assert/strict";
import test from "node:test";

import { openaiMessagesToAnthropic } from "./tool_convert";

test("preserves cache_control on a user text content part", () => {
  const cacheControl = { type: "ephemeral" };

  assert.deepStrictEqual(
    openaiMessagesToAnthropic([
      {
        role: "user",
        content: [
          { type: "text", text: "keep this marker", cache_control: cacheControl },
        ],
      },
    ]),
    [
      {
        role: "user",
        content: [
          { type: "text", text: "keep this marker", cache_control: cacheControl },
        ],
      },
    ]
  );
});

test("keeps string tool content as a string", () => {
  assert.deepStrictEqual(
    openaiMessagesToAnthropic([
      { role: "tool", tool_call_id: "call_text", content: "plain result" },
    ]),
    [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_text",
            content: "plain result",
          },
        ],
      },
    ]
  );
});

test("converts tool text and an HTTP image to tool_result content blocks", () => {
  assert.deepStrictEqual(
    openaiMessagesToAnthropic([
      {
        role: "tool",
        tool_call_id: "call_image",
        content: [
          { type: "text", text: "result image" },
          { type: "image_url", image_url: { url: "https://example.com/result.png" } },
        ],
      },
    ]),
    [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_image",
            content: [
              { type: "text", text: "result image" },
              {
                type: "image",
                source: { type: "url", url: "https://example.com/result.png" },
              },
            ],
          },
        ],
      },
    ]
  );
});

test("converts a tool data URI image to a base64 image source", () => {
  assert.deepStrictEqual(
    openaiMessagesToAnthropic([
      {
        role: "tool",
        tool_call_id: "call_data_uri",
        content: [
          { type: "image_url", image_url: { url: "data:image/webp;base64,UklGRg==" } },
        ],
      },
    ]),
    [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_data_uri",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/webp",
                  data: "UklGRg==",
                },
              },
            ],
          },
        ],
      },
    ]
  );
});

test("converts a user HTTPS image to a URL image source", () => {
  assert.deepStrictEqual(
    openaiMessagesToAnthropic([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/user.jpg" } },
        ],
      },
    ]),
    [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://example.com/user.jpg" },
          },
        ],
      },
    ]
  );
});

test("converts assistant tool_calls to tool_use blocks", () => {
  assert.deepStrictEqual(
    openaiMessagesToAnthropic([
      {
        role: "assistant",
        content: "Calling the tool",
        tool_calls: [
          {
            id: "call_weather",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          },
        ],
      },
    ]),
    [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling the tool" },
          {
            type: "tool_use",
            id: "call_weather",
            name: "get_weather",
            input: { city: "Tokyo" },
          },
        ],
      },
    ]
  );
});
