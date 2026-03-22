import { Request, Response } from "express";
import { createAnthropicClient, resolveAuth } from "../utils/auth";
import {
  convertRequest,
  convertResponse,
  OpenAIChatRequest,
} from "../utils/convert";
import {
  initSSE,
  createStreamChunk,
  createInitialChunk,
  createFinalChunk,
  createUsageChunk,
  sendDone,
  createStreamContext,
} from "../utils/stream";
import {
  openaiToolsToAnthropic,
  openaiMessagesToAnthropic,
  extractSystemPrompt,
  convertResponseWithTools,
  OpenAITool,
  OpenAIMessage,
} from "../utils/tool_convert";

let client: ReturnType<typeof createAnthropicClient> | null = null;

function getClient() {
  if (!client) {
    client = createAnthropicClient();
  }
  return client;
}

/**
 * リクエストにtoolsが含まれているかチェックする。
 * tools対応パスと通常パスを分岐するために使用。
 */
function hasTools(body: any): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * tools付きリクエストをAnthropicフォーマットに変換する。
 * convertRequest (変更不可) はtoolsを扱わないため、このパスで補完。
 */
function buildAnthropicRequestWithTools(
  body: any,
  authToken?: string
): Record<string, unknown> {
  const messages = body.messages as OpenAIMessage[];
  const tools = body.tools as OpenAITool[];

  // systemプロンプトを取り出す
  const systemText = extractSystemPrompt(messages);

  // auth token: oat tokenの場合はClaudeCode system promptを追加
  const systemBlocks: Array<{ type: string; text: string }> = [];
  if (authToken && authToken.includes("sk-ant-oat")) {
    systemBlocks.push({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
  }
  if (systemText) {
    systemBlocks.push({ type: "text", text: systemText });
  }

  // メッセージ変換（tool role含む）
  const anthropicMessages = openaiMessagesToAnthropic(messages);

  // tools変換
  const anthropicTools = openaiToolsToAnthropic(tools);

  const req: Record<string, unknown> = {
    model: body.model,
    messages: anthropicMessages,
    max_tokens: body.max_tokens ?? 4096,
    tools: anthropicTools,
  };

  if (systemBlocks.length > 0) {
    req.system = systemBlocks;
  }
  if (body.temperature !== undefined) {
    req.temperature = body.temperature;
  }

  return req;
}

export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const body = req.body as OpenAIChatRequest & { tools?: OpenAITool[] };

    if (!body.messages || !Array.isArray(body.messages)) {
      res.status(400).json({
        error: {
          message: "messages is required and must be an array",
          type: "invalid_request_error",
          param: "messages",
          code: null,
        },
      });
      return;
    }

    if (!body.model) {
      res.status(400).json({
        error: {
          message: "model is required",
          type: "invalid_request_error",
          param: "model",
          code: null,
        },
      });
      return;
    }

    const auth = resolveAuth();
    const authToken =
      "apiKey" in auth
        ? auth.apiKey
        : "authToken" in auth
        ? auth.authToken
        : undefined;
    const requestedModel = body.model;

    const includeUsage = (body as any).stream_options?.include_usage === true;

    if (hasTools(body)) {
      // tools付きリクエスト: tool対応パスを使う
      const anthropicReq = buildAnthropicRequestWithTools(body, authToken);
      if (body.stream) {
        await handleStreamingWithTools(res, anthropicReq, requestedModel, includeUsage);
      } else {
        await handleNonStreamingWithTools(res, anthropicReq, requestedModel);
      }
    } else {
      // 通常パス: 既存のconvertRequestを使う
      const anthropicReq = convertRequest(body, authToken);
      if (body.stream) {
        await handleStreaming(res, anthropicReq, requestedModel, includeUsage);
      } else {
        await handleNonStreaming(res, anthropicReq, requestedModel);
      }
    }
  } catch (error: any) {
    console.error("Chat completion error:", error);

    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal server error";

    res.status(status).json({
      error: {
        message,
        type: "api_error",
        param: null,
        code: null,
      },
    });
  }
}

async function handleNonStreaming(
  res: Response,
  anthropicReq: any,
  requestedModel: string
): Promise<void> {
  const { stream, ...params } = anthropicReq;
  const response = await getClient().messages.create(params);
  const openaiResponse = convertResponse(response, requestedModel);
  res.json(openaiResponse);
}

/**
 * tools付き非ストリーミングレスポンス処理。
 * tool_use ブロックをOpenAI tool_calls形式に変換して返す。
 */
async function handleNonStreamingWithTools(
  res: Response,
  anthropicReq: Record<string, unknown>,
  requestedModel: string
): Promise<void> {
  const response = await getClient().messages.create(anthropicReq as any);
  const openaiResponse = convertResponseWithTools(response, requestedModel);
  res.json(openaiResponse);
}

async function handleStreaming(
  res: Response,
  anthropicReq: any,
  requestedModel: string,
  includeUsage: boolean = false
): Promise<void> {
  const { stream: _stream, ...params } = anthropicReq;
  const ctx = createStreamContext(requestedModel);

  initSSE(res);
  res.write(createInitialChunk(ctx.id, ctx.model, ctx.created));

  const stream = getClient().messages.stream(params);

  stream.on("text", (text: string) => {
    res.write(createStreamChunk(ctx.id, ctx.model, ctx.created, text));
  });

  stream.on("finalMessage", (finalMsg: any) => {
    const finishReason = finalMsg.stop_reason === "max_tokens" ? "length" : "stop";
    res.write(createFinalChunk(ctx.id, ctx.model, ctx.created, finishReason, finalMsg));
    if (includeUsage && finalMsg.usage) {
      res.write(createUsageChunk(ctx.id, ctx.model, ctx.created, finalMsg.usage));
    }
    sendDone(res);
  });

  stream.on("error", (error: Error) => {
    console.error("Stream error:", error);
    res.write(
      `data: ${JSON.stringify({ error: { message: error.message, type: "api_error" } })}\n\n`
    );
    sendDone(res);
  });

  res.on("close", () => {
    stream.abort();
  });
}

/**
 * tools付きストリーミング処理。
 * tool_useはストリームで受け取り、最終的にtool_callsとして送信する。
 * (ストリーム中にtool_useは断片化されるため、最終メッセージで一括変換)
 */
async function handleStreamingWithTools(
  res: Response,
  anthropicReq: Record<string, unknown>,
  requestedModel: string,
  includeUsage: boolean = false
): Promise<void> {
  const ctx = createStreamContext(requestedModel);

  initSSE(res);
  res.write(createInitialChunk(ctx.id, ctx.model, ctx.created));

  const stream = getClient().messages.stream(anthropicReq as any);

  // テキスト部分はリアルタイムでストリーム
  stream.on("text", (text: string) => {
    res.write(createStreamChunk(ctx.id, ctx.model, ctx.created, text));
  });

  stream.on("finalMessage", (finalMsg: any) => {
    // tool_callsが含まれている場合は最終メッセージをDeltaとして送信
    const toolCalls = (finalMsg.content ?? []).filter(
      (c: any) => c.type === "tool_use"
    );
    if (toolCalls.length > 0) {
      const toolCallsFormatted = toolCalls.map((tc: any, idx: number) => ({
        index: idx,
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments:
            typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
        },
      }));
      const delta = JSON.stringify({
        id: ctx.id,
        object: "chat.completion.chunk",
        created: ctx.created,
        model: ctx.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: toolCallsFormatted,
            },
            finish_reason: "tool_calls",
          },
        ],
      });
      res.write(`data: ${delta}\n\n`);
    }
    // Anthropicメタデータ付き最終チャンクを送信
    const finishReason = toolCalls.length > 0 || finalMsg.stop_reason === "tool_use"
      ? "tool_calls"
      : finalMsg.stop_reason === "max_tokens" ? "length" : "stop";
    res.write(createFinalChunk(ctx.id, ctx.model, ctx.created, finishReason, finalMsg));
    if (includeUsage && finalMsg.usage) {
      res.write(createUsageChunk(ctx.id, ctx.model, ctx.created, finalMsg.usage));
    }
    sendDone(res);
  });

  stream.on("error", (error: Error) => {
    console.error("Stream error:", error);
    res.write(
      `data: ${JSON.stringify({ error: { message: error.message, type: "api_error" } })}\n\n`
    );
    sendDone(res);
  });

  res.on("close", () => {
    stream.abort();
  });
}
