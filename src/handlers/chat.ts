import { Request, Response } from "express";
import { createAnthropicClient, resolveAuth } from "../utils/auth";
import {
  convertRequest,
  convertResponse,
  resolveTemperature,
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
  extractSystemBlocks,
  convertResponseWithTools,
  OpenAITool,
  OpenAIMessage,
} from "../utils/tool_convert";

// --- Bonsai routing helpers ---

function isBonsaiModel(model: string): boolean {
  return model === "bonsai" || model === "bonsai-8b";
}

function getBonsaiUrl(): string {
  return process.env.BONSAI_URL || "http://localhost:8081";
}

async function handleBonsaiNonStreaming(
  req: Request,
  res: Response
): Promise<void> {
  const url = `${getBonsaiUrl()}/v1/chat/completions`;
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, stream: false }),
    });
  } catch {
    res.status(503).json({
      error: {
        message: "Bonsai server is unavailable",
        type: "api_error",
        param: null,
        code: null,
      },
    });
    return;
  }
  const data = await response.json();
  res.status(response.status).json(data);
}

async function handleBonsaiStreaming(
  req: Request,
  res: Response
): Promise<void> {
  const url = `${getBonsaiUrl()}/v1/chat/completions`;
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, stream: true }),
    });
  } catch {
    res.status(503).json({
      error: {
        message: "Bonsai server is unavailable",
        type: "api_error",
        param: null,
        code: null,
      },
    });
    return;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: { message: "Bonsai error" } }));
    res.status(response.status).json(data);
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = response.body?.getReader();
  if (!reader) {
    res.status(503).json({
      error: {
        message: "Bonsai server returned no body",
        type: "api_error",
        param: null,
        code: null,
      },
    });
    return;
  }

  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    console.error("Bonsai stream error:", error);
  } finally {
    res.end();
  }

  res.on("close", () => {
    reader.cancel();
  });
}

/**
 * リクエスト内に cache_control が 1 つも無いとき、トップレベルの自動キャッシュ指定
 * （最後のキャッシュ可能ブロックに自動配置）を既定付与する（issue #4）。
 *
 * OpenAI 形式には cache_control の概念が無いため、素通し設計（クライアントが明示
 * マーカーを付けてくれば尊重する）だけでは「誰も付けない」状態になり、全リクエストが
 * 無キャッシュでフルプライスになっていた。明示マーカーがあれば従来どおり一切触らない。
 */
function ensureDefaultCacheControl(req: object): void {
  if (JSON.stringify(req).includes('"cache_control"')) {
    return; // クライアントの明示配置を尊重（素通し設計を壊さない）
  }
  (req as Record<string, unknown>).cache_control = { type: "ephemeral" };
}

// --- Claude client ---

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

  // auth token: oat tokenの場合はClaudeCode system promptを追加
  const systemBlocks: Array<Record<string, unknown>> = [];
  if (authToken && authToken.includes("sk-ant-oat")) {
    systemBlocks.push({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
  }
  systemBlocks.push(...extractSystemBlocks(messages));

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
  const temperature = resolveTemperature(body.model, body.temperature);
  if (temperature !== undefined) {
    req.temperature = temperature;
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

    // Bonsai モデルの場合はローカルサーバーに転送
    if (isBonsaiModel(body.model)) {
      if (body.stream) {
        await handleBonsaiStreaming(req, res);
      } else {
        await handleBonsaiNonStreaming(req, res);
      }
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
      ensureDefaultCacheControl(anthropicReq);
      if (body.stream) {
        await handleStreamingWithTools(res, anthropicReq, requestedModel, includeUsage);
      } else {
        await handleNonStreamingWithTools(res, anthropicReq, requestedModel);
      }
    } else {
      // 通常パス: 既存のconvertRequestを使う
      const anthropicReq = convertRequest(body, authToken);
      ensureDefaultCacheControl(anthropicReq);
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
  const { stream: _stream, ...params } = anthropicReq;
  // クライアントには非ストリーミングの単一応答を返すが、Anthropic へは内部でストリーミング
  // として呼び、最終メッセージを集約する。SDK 0.80 は非ストリーミングで max_tokens が大きいと
  // calculateNonstreamingTimeout のガードにより
  // "Streaming is required for operations that may take longer than 10 minutes" を投げる
  // （#676 で opus-5 の max_tokens が 128000 になり顕在化）。messages.stream() 経路には
  // このガードが無いため回避できる。集約中のエラーは finalMessage() が reject し、
  // 呼び出し側の try/catch が 500 として正直に返す（握り潰して部分応答を返さない）。
  const finalMsg = await getClient().messages.stream(params).finalMessage();
  const openaiResponse = convertResponse(finalMsg, requestedModel);
  res.json(openaiResponse);
}

/**
 * tools付き非ストリーミングレスポンス処理。
 * tool_use ブロックをOpenAI tool_calls形式に変換して返す。
 * handleNonStreaming と同じ理由で、内部はストリーミングで呼んで最終メッセージを集約する。
 */
async function handleNonStreamingWithTools(
  res: Response,
  anthropicReq: Record<string, unknown>,
  requestedModel: string
): Promise<void> {
  const finalMsg = await getClient()
    .messages.stream(anthropicReq as any)
    .finalMessage();
  const openaiResponse = convertResponseWithTools(finalMsg, requestedModel);
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

  // クライアント切断時の abort は SDK 内部の promise を APIUserAbortError で reject する。
  // 観測しないと unhandledRejection でプロセスごと落ちる（issue #3・2026-08-17 の本番クラッシュ）。
  // abort は「切断済みで返す相手がいない」正常系なので静かに終え、それ以外はログに出す。
  stream.done().catch((error: unknown) => {
    if (error instanceof Error && error.name === "APIUserAbortError") {
      return;
    }
    console.error("Stream terminated with error:", error);
  });

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

  // クライアント切断時の abort を観測する（issue #3。handleStreaming と同じ理由）。
  stream.done().catch((error: unknown) => {
    if (error instanceof Error && error.name === "APIUserAbortError") {
      return;
    }
    console.error("Stream terminated with error:", error);
  });

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
