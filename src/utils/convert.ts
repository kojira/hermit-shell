import { v4 as uuidv4 } from "uuid";

export const MODEL_MAP: Record<string, string> = {
  // OpenAI models → Claude haiku (safe default, works with subscription tokens)
  "gpt-3.5-turbo": "claude-haiku-4-5-20251001",
  "gpt-3.5-turbo-0125": "claude-haiku-4-5-20251001",
  "gpt-4o-mini": "claude-haiku-4-5-20251001",
  // GPT-4 class → claude-sonnet (may require higher tier API key)
  "gpt-4": "claude-sonnet-4-5-20250929",
  "gpt-4-turbo": "claude-sonnet-4-5-20250929",
  "gpt-4o": "claude-sonnet-4-5-20250929",
  // Direct claude model aliases (pass through or normalize)
  "claude-haiku": "claude-haiku-4-5-20251001",
  "claude-3-haiku": "claude-3-haiku-20240307",
  "claude-sonnet": "claude-sonnet-4-5-20250929",
  "claude-3-5-sonnet": "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus": "claude-opus-4-5-20251101",
  // Leave claude-* with full version suffix as-is (pass through)
};

/** Check if a model string already has a date suffix and can pass through directly */
function hasDateSuffix(model: string): boolean {
  return /\d{8}$/.test(model);
}

export function mapModel(model: string): string {
  if (MODEL_MAP[model]) return MODEL_MAP[model];
  // Models with date suffix (e.g. claude-sonnet-4-5-20250929) pass through directly
  if (hasDateSuffix(model)) return model;
  return model;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface AnthropicRequest {
  model: string;
  system?: Array<{type: string; text: string}>;
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
}

export function convertRequest(req: OpenAIChatRequest, apiKey?: string): AnthropicRequest {
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const nonSystemMessages = req.messages.filter((m) => m.role !== "system");

  const result: AnthropicRequest = {
    model: mapModel(req.model),
    messages: nonSystemMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    max_tokens: req.max_tokens || 4096,
  };

  const systemBlocks: Array<{type: string; text: string}> = [];
  if (apiKey && apiKey.includes("sk-ant-oat")) {
    systemBlocks.push({type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude."});
  }
  for (const m of systemMessages) {
    systemBlocks.push({type: "text", text: m.content});
  }
  if (systemBlocks.length > 0) {
    result.system = systemBlocks;
  }

  if (req.temperature !== undefined) {
    result.temperature = req.temperature;
  }

  if (req.stream !== undefined) {
    result.stream = req.stream;
  }

  return result;
}

export function convertResponse(
  anthropicResponse: any,
  requestedModel: string
) {
  const textContent = anthropicResponse.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
        },
        finish_reason: mapStopReason(anthropicResponse.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens || 0) +
        (anthropicResponse.usage?.output_tokens || 0),
    },
  };
}

function mapStopReason(
  stopReason: string | null
): "stop" | "length" | "content_filter" | null {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}
