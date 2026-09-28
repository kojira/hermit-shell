import { Request, Response } from "express";
import { createAnthropicClient, resolveAuth } from "../utils/auth";
import {
  convertRequest,
  convertResponse,
  resolveMaxTokens,
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
  StreamContext,
} from "../utils/stream";
import { accumulateMessage } from "../utils/message_accumulator";
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
 * 共有クライアントのキャッシュを破棄する。次の getClient() が現在の env から
 * 作り直すため、設定ページでトークンを差し替えたあとに呼べば再起動なしで全経路
 * （streaming/non-streaming・tools 有無すべて getClient 経由）へ新トークンが効く。
 */
export function resetClient(): void {
  client = null;
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
export function buildAnthropicRequestWithTools(
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
    max_tokens: resolveMaxTokens(body),
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

/**
 * Anthropic へストリーミングで要求し、生イベントから最終メッセージを組み立てる。
 * SDK の MessageStream は tool 引数を受信中に逐次 parse し、生の制御文字で例外を
 * 出して応答全体を失うため使わない（accumulateMessage はブロック完了時に一度だけ解釈）。
 * 非ストリーミング応答も同じ経路で集約する（SDK 0.80 の10分ガード回避も兼ねる）。
 */
async function streamMessage(
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onText?: (text: string) => void
): Promise<any> {
  const { stream: _stream, ...rest } = params;
  const events = await getClient().messages.create(
    { ...(rest as any), stream: true },
    signal ? { signal } : undefined
  );
  return accumulateMessage(events as any, onText);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "APIUserAbortError" || error.name === "AbortError")
  );
}

async function handleNonStreaming(
  res: Response,
  anthropicReq: any,
  requestedModel: string
): Promise<void> {
  // 集約中のエラーは呼び出し側の try/catch が 500 として正直に返す（部分応答を返さない）。
  const finalMsg = await streamMessage(anthropicReq);
  res.json(convertResponse(finalMsg, requestedModel));
}

/** tools付き非ストリーミング。tool_use を OpenAI tool_calls 形式に変換して返す。 */
async function handleNonStreamingWithTools(
  res: Response,
  anthropicReq: Record<string, unknown>,
  requestedModel: string
): Promise<void> {
  const finalMsg = await streamMessage(anthropicReq);
  res.json(convertResponseWithTools(finalMsg, requestedModel));
}

/**
 * SSE 応答の共通処理。text はリアルタイムで流し、最終メッセージで finish を送る。
 * クライアント切断時は上流を abort し、その abort は正常系として静かに終える（issue #3）。
 */
async function runSseStream(
  res: Response,
  anthropicReq: Record<string, unknown>,
  requestedModel: string,
  includeUsage: boolean,
  writeFinal: (ctx: StreamContext, finalMsg: any) => void
): Promise<void> {
  const ctx = createStreamContext(requestedModel);
  initSSE(res);
  res.write(createInitialChunk(ctx.id, ctx.model, ctx.created));

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    const finalMsg = await streamMessage(anthropicReq, controller.signal, (text) => {
      if (!res.writableEnded) res.write(createStreamChunk(ctx.id, ctx.model, ctx.created, text));
    });
    if (res.writableEnded) return;
    writeFinal(ctx, finalMsg);
    if (includeUsage && finalMsg.usage) {
      res.write(createUsageChunk(ctx.id, ctx.model, ctx.created, finalMsg.usage));
    }
    sendDone(res);
  } catch (error: unknown) {
    if (controller.signal.aborted || isAbortError(error)) return;
    console.error("Stream error:", error);
    if (res.writableEnded) return;
    const message = error instanceof Error ? error.message : String(error);
    res.write(`data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`);
    sendDone(res);
  }
}

async function handleStreaming(
  res: Response,
  anthropicReq: any,
  requestedModel: string,
  includeUsage: boolean = false
): Promise<void> {
  await runSseStream(res, anthropicReq, requestedModel, includeUsage, (ctx, finalMsg) => {
    const finishReason = finalMsg.stop_reason === "max_tokens" ? "length" : "stop";
    res.write(createFinalChunk(ctx.id, ctx.model, ctx.created, finishReason, finalMsg));
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
  await runSseStream(res, anthropicReq, requestedModel, includeUsage, (ctx, finalMsg) => {
    const toolCalls = (finalMsg.content ?? []).filter((c: any) => c.type === "tool_use");
    if (toolCalls.length > 0) {
      const toolCallsFormatted = toolCalls.map((tc: any, idx: number) => ({
        index: idx,
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
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
            delta: { role: "assistant", content: null, tool_calls: toolCallsFormatted },
            finish_reason: "tool_calls",
          },
        ],
      });
      res.write(`data: ${delta}\n\n`);
    }
    const finishReason =
      toolCalls.length > 0 || finalMsg.stop_reason === "tool_use"
        ? "tool_calls"
        : finalMsg.stop_reason === "max_tokens"
        ? "length"
        : "stop";
    res.write(createFinalChunk(ctx.id, ctx.model, ctx.created, finishReason, finalMsg));
  });
}
