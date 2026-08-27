import { Request, Response } from "express";
import { getFreshCodexTokens } from "../utils/codex_auth";
import {
  CodexSSEParser,
  applyCodexEvent,
  aggregateToOpenAIResponse,
  buildCodexRequestBody,
  codexFinishReason,
  createAggregate,
  getCodexResponsesUrl,
} from "../utils/codex_convert";
import {
  initSSE,
  createStreamChunk,
  createInitialChunk,
  createUsageChunk,
  sendDone,
  createStreamContext,
} from "../utils/stream";

/**
 * OpenAI Codex (ChatGPT サブスク) 向け /v1/chat/completions ハンドラ。
 *
 * chat.ts の bonsai 分岐と同じ「モデル名でここへ回ってくる」だけの造りで、
 * Claude 経路には一切触れない。バックエンドは常にストリーミングで返すため、
 * 非ストリーミング要求はここで集約して単一 JSON にする（handleNonStreaming が
 * Anthropic に対してやっているのと同じ流儀）。
 *
 * リトライはしない: 429/5xx はステータスごとクライアントへ返す。JIT の
 * OpenAIServerModel が自前で 5 回リトライするので、二重リトライにしない。
 */

function openAIError(
  res: Response,
  status: number,
  message: string,
  type = "api_error"
): void {
  res.status(status).json({
    error: { message, type, param: null, code: null },
  });
}

/** 429/エラー本文から利用上限の親切メッセージを組む（pi-ai
 *  openai-codex-responses.js:999-1021 parseErrorResponse と同じ規則）。 */
function friendlyBackendError(status: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const err = parsed?.error;
    if (err) {
      const code = err.code || err.type || "";
      if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || status === 429) {
        const plan = err.plan_type ? ` (${String(err.plan_type).toLowerCase()} plan)` : "";
        const mins = err.resets_at
          ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        return `ChatGPT usage limit reached${plan}.${when}`.trim();
      }
      if (err.message) return err.message;
    }
  } catch {
    // JSON でなければ生のまま
  }
  return raw.slice(0, 500) || `codex backend error (${status})`;
}

export async function handleCodexChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const body = req.body;

  let tokens;
  try {
    tokens = await getFreshCodexTokens();
  } catch (error: any) {
    // リフレッシュ失敗（refresh_token 失効など）。再ログインが必要。
    openAIError(res, 503, error?.message || "codex token refresh failed");
    return;
  }
  if (!tokens) {
    openAIError(
      res,
      503,
      "codex auth not configured — open /setup on the proxy host and complete the OpenAI Codex login"
    );
    return;
  }

  const stream = body.stream === true;
  const codexBody = buildCodexRequestBody(body, true);

  let backendRes: globalThis.Response;
  try {
    backendRes = await fetch(getCodexResponsesUrl(), {
      method: "POST",
      // ヘッダは pi-ai openai-codex-responses.js:1046-1067 buildSSEHeaders /
      // opencrab chatgpt.rs:465-480 request_builder と同一（UA のみ自分の名前）。
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "chatgpt-account-id": tokens.account_id,
        "OpenAI-Beta": "responses=experimental",
        originator: "pi",
        accept: "text/event-stream",
        "content-type": "application/json",
        "User-Agent": "hermit-shell/1.0.0",
      },
      body: JSON.stringify(codexBody),
    });
  } catch (error: any) {
    openAIError(res, 502, `codex backend unreachable: ${error?.message || error}`);
    return;
  }

  if (!backendRes.ok) {
    const raw = await backendRes.text().catch(() => "");
    openAIError(res, backendRes.status, friendlyBackendError(backendRes.status, raw));
    return;
  }
  if (!backendRes.body) {
    openAIError(res, 502, "codex backend returned no body");
    return;
  }

  if (stream) {
    await pipeStreaming(res, backendRes, body);
  } else {
    await aggregateNonStreaming(res, backendRes, body);
  }
}

async function readBackendEvents(
  backendRes: globalThis.Response,
  onEvent: (event: Record<string, any>) => void
): Promise<void> {
  const reader = backendRes.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new CodexSSEParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 既に閉じている
    }
  }
}

async function aggregateNonStreaming(
  res: Response,
  backendRes: globalThis.Response,
  body: any
): Promise<void> {
  const agg = createAggregate();
  try {
    await readBackendEvents(backendRes, (event) => applyCodexEvent(agg, event));
  } catch (error: any) {
    openAIError(res, 502, `codex stream read failed: ${error?.message || error}`);
    return;
  }
  if (agg.error) {
    openAIError(res, 502, agg.error);
    return;
  }
  const ctx = createStreamContext(body.model);
  res.json(aggregateToOpenAIResponse(agg, ctx.model, ctx.id, ctx.created, body.stop));
}

async function pipeStreaming(
  res: Response,
  backendRes: globalThis.Response,
  body: any
): Promise<void> {
  const includeUsage = body.stream_options?.include_usage === true;
  const ctx = createStreamContext(body.model);
  const agg = createAggregate();

  initSSE(res);
  res.write(createInitialChunk(ctx.id, ctx.model, ctx.created));

  // クライアント切断でバックエンド読み取りを打ち切る。
  let clientClosed = false;
  res.on("close", () => {
    clientClosed = true;
  });

  try {
    await readBackendEvents(backendRes, (event) => {
      if (clientClosed) throw new Error("client disconnected");
      const { textDelta } = applyCodexEvent(agg, event);
      if (textDelta) {
        res.write(createStreamChunk(ctx.id, ctx.model, ctx.created, textDelta));
      }
    });
  } catch (error: any) {
    if (clientClosed) {
      res.end();
      return;
    }
    res.write(
      `data: ${JSON.stringify({ error: { message: String(error?.message || error), type: "api_error" } })}\n\n`
    );
    sendDone(res);
    return;
  }

  if (agg.error) {
    res.write(
      `data: ${JSON.stringify({ error: { message: agg.error, type: "api_error" } })}\n\n`
    );
    sendDone(res);
    return;
  }

  // tool call は Anthropic 側の tools ストリーミングと同じく最後に一括で流す
  // （chat.ts handleStreamingWithTools と同じ形）。
  if (agg.toolCalls.length > 0) {
    const toolCallsFormatted = agg.toolCalls.map((tc, idx) => ({
      index: idx,
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
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

  res.write(createStreamChunk(ctx.id, ctx.model, ctx.created, "", codexFinishReason(agg)));
  if (includeUsage && agg.usage) {
    res.write(
      createUsageChunk(ctx.id, ctx.model, ctx.created, {
        input_tokens: agg.usage.prompt_tokens,
        output_tokens: agg.usage.completion_tokens,
      })
    );
  }
  sendDone(res);
}
