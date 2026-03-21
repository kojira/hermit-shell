/**
 * tool_convert.ts
 *
 * OpenAI tool-calling format ↔ Anthropic tool-use format conversion utilities.
 * convert.ts (変更不可) はtoolsを扱わないため、このファイルで補完する。
 */

// ---------------------------------------------------------------------------
// OpenAI types (input)
// ---------------------------------------------------------------------------

export interface OpenAIFunction {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ContentPartText {
  type: "text";
  text: string;
}

export interface ContentPartImageUrl {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = ContentPartText | ContentPartImageUrl;

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Anthropic types (output)
// ---------------------------------------------------------------------------

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

// ---------------------------------------------------------------------------
// Conversion: OpenAI tools → Anthropic tools
// ---------------------------------------------------------------------------

/**
 * Convert OpenAI-format tools array to Anthropic tools array.
 */
export function openaiToolsToAnthropic(tools: OpenAITool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

// ---------------------------------------------------------------------------
// Conversion: OpenAI messages → Anthropic messages
// (supplements convertRequest which doesn't handle tool role or tool_calls)
// ---------------------------------------------------------------------------

type AnthropicRole = "user" | "assistant";

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | Array<unknown>;
}

/**
 * Convert an OpenAI messages array (which may include tool/assistant-with-tool-calls
 * messages) to Anthropic messages format.
 *
 * This REPLACES the message conversion from convertRequest when tools are present.
 */
export function openaiMessagesToAnthropic(
  messages: OpenAIMessage[]
): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // System messages are handled separately (via system field)
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant message with tool calls
        const content: Array<unknown> = [];

        // Include text content if present
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }

        // Add tool_use blocks
        for (const tc of msg.tool_calls) {
          let input: unknown;
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }

        result.push({ role: "assistant", content });
      } else {
        // Regular assistant message
        result.push({
          role: "assistant",
          content: msg.content ?? "",
        });
      }
    } else if (msg.role === "tool") {
      // Tool result → user message with tool_result block
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: msg.content ?? "",
          } as AnthropicToolResultBlock,
        ],
      });
    } else {
      // user message
      let anthropicContent: unknown;
      if (Array.isArray(msg.content)) {
        // Convert OpenAI ContentParts to Anthropic format
        anthropicContent = msg.content.map((part: any) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          } else if (part.type === "image_url") {
            return {
              type: "image",
              source: { type: "url", url: part.image_url.url }
            };
          }
          return part;
        });
      } else {
        anthropicContent = msg.content ?? "";
      }
      result.push({ role: "user", content: anthropicContent as any });
    }
  }

  return result;
}

/**
 * Extract the system prompt text from an OpenAI messages array.
 */
export function extractSystemPrompt(messages: OpenAIMessage[]): string | undefined {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (systemMsgs.length === 0) return undefined;
  return systemMsgs.map((m) => m.content ?? "").join("\n");
}

// ---------------------------------------------------------------------------
// Conversion: Anthropic response → OpenAI response with tool_calls
// ---------------------------------------------------------------------------

/**
 * Convert an Anthropic response that may contain tool_use blocks to
 * an OpenAI-compatible response with tool_calls.
 *
 * This supplements convertResponse (which only handles text blocks).
 */
export function convertResponseWithTools(
  anthropicResponse: any,
  requestedModel: string
): object {
  const { v4: uuidv4 } = require("uuid");

  const content = anthropicResponse.content ?? [];

  // Extract text blocks
  const textContent: string = content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text as string)
    .join("");

  // Extract tool_use blocks
  const toolUseBlocks: AnthropicToolUseBlock[] = content.filter(
    (c: any) => c.type === "tool_use"
  );

  const hasToolCalls = toolUseBlocks.length > 0;

  // Build OpenAI tool_calls if present
  const toolCalls: OpenAIToolCall[] = toolUseBlocks.map((block) => ({
    id: block.id,
    type: "function" as const,
    function: {
      name: block.name,
      arguments:
        typeof block.input === "string"
          ? block.input
          : JSON.stringify(block.input),
    },
  }));

  // Map stop reason
  let finishReason: string;
  if (hasToolCalls || anthropicResponse.stop_reason === "tool_use") {
    finishReason = "tool_calls";
  } else if (anthropicResponse.stop_reason === "max_tokens") {
    finishReason = "length";
  } else {
    finishReason = "stop";
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textContent || null,
  };

  if (hasToolCalls) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens ?? 0,
      completion_tokens: anthropicResponse.usage?.output_tokens ?? 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens ?? 0) +
        (anthropicResponse.usage?.output_tokens ?? 0),
    },
  };
}
