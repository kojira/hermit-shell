import { v4 as uuidv4 } from "uuid";

export function mapModel(model: string): string {
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
