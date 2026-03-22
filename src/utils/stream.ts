import { Response } from "express";
import { v4 as uuidv4 } from "uuid";

export function initSSE(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

export function createStreamChunk(
  id: string,
  model: string,
  created: number,
  content: string,
  finishReason: string | null = null
): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: finishReason ? {} : { content },
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function createInitialChunk(
  id: string,
  model: string,
  created: number
): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function createUsageChunk(
  id: string,
  model: string,
  created: number,
  usage: any
): string {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: {
      ...usage,
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function sendDone(res: Response): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

export interface StreamContext {
  id: string;
  model: string;
  created: number;
}

export function createStreamContext(model: string): StreamContext {
  return {
    id: `chatcmpl-${uuidv4()}`,
    model,
    created: Math.floor(Date.now() / 1000),
  };
}
