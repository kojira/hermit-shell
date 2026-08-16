import { v4 as uuidv4 } from "uuid";

export function mapModel(model: string): string {
  return model;
}

// temperature パラメータを受け付けないモデル。ここが唯一の定義箇所。
// Opus 5 系は temperature を送ると Anthropic が 400
// "`temperature` is deprecated for this model." を返す（実測: claude-opus-5）。
// dated variant (claude-opus-5-YYYYMMDD 等) も同じ family なので前方一致で判定する。
// haiku / sonnet では temperature は有効なので対象にしない。
const TEMPERATURE_UNSUPPORTED_PREFIXES = ["claude-opus-5"];

export function modelSupportsTemperature(model: string): boolean {
  return !TEMPERATURE_UNSUPPORTED_PREFIXES.some((p) => model.startsWith(p));
}

// 付与すべき temperature を返す。非対応モデルでは undefined を返し、
// 黙って落とさずログに残す。
export function resolveTemperature(
  model: string,
  temperature: number | undefined
): number | undefined {
  if (temperature === undefined) return undefined;
  if (!modelSupportsTemperature(model)) {
    console.log(
      `[hermit-shell] モデル ${model} は temperature 非対応のため除去した (要求値: ${temperature})`
    );
    return undefined;
  }
  return temperature;
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

  const temperature = resolveTemperature(result.model, req.temperature);
  if (temperature !== undefined) {
    result.temperature = temperature;
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
  const textContent = (anthropicResponse.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");

  return {
    // 1. まずAnthropicレスポンス全フィールドをスプレッド
    ...anthropicResponse,
    // 2. OpenAI互換フィールドで上書き
    id: `chatcmpl-${uuidv4()}`,
    anthropic_id: anthropicResponse.id,
    anthropic_model: anthropicResponse.model,
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
        logprobs: null,
        finish_reason: mapStopReason(anthropicResponse.stop_reason),
        stop_sequence: anthropicResponse.stop_sequence ?? null,
      },
    ],
    usage: {
      ...anthropicResponse.usage,
      prompt_tokens: anthropicResponse.usage?.input_tokens ?? 0,
      completion_tokens: anthropicResponse.usage?.output_tokens ?? 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens ?? 0) +
        (anthropicResponse.usage?.output_tokens ?? 0),
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
