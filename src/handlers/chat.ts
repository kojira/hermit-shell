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
  sendDone,
  createStreamContext,
} from "../utils/stream";

let client: ReturnType<typeof createAnthropicClient> | null = null;

function getClient() {
  if (!client) {
    client = createAnthropicClient();
  }
  return client;
}

export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const body = req.body as OpenAIChatRequest;

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
    const authToken = "apiKey" in auth ? auth.apiKey : "authToken" in auth ? auth.authToken : undefined;
    const anthropicReq = convertRequest(body, authToken);
    const requestedModel = body.model;

    if (body.stream) {
      await handleStreaming(res, anthropicReq, requestedModel);
    } else {
      await handleNonStreaming(res, anthropicReq, requestedModel);
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

async function handleStreaming(
  res: Response,
  anthropicReq: any,
  requestedModel: string
): Promise<void> {
  const { stream: _stream, ...params } = anthropicReq;
  const ctx = createStreamContext(requestedModel);

  initSSE(res);
  res.write(createInitialChunk(ctx.id, ctx.model, ctx.created));

  const stream = getClient().messages.stream(params);

  stream.on("text", (text: string) => {
    res.write(createStreamChunk(ctx.id, ctx.model, ctx.created, text));
  });

  stream.on("end", () => {
    res.write(createStreamChunk(ctx.id, ctx.model, ctx.created, "", "stop"));
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
