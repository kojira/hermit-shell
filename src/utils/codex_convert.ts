import { OpenAITool, OpenAIMessage } from "./tool_convert";

/**
 * OpenAI chat-completions ⇄ ChatGPT Codex Responses API の変換。
 *
 * リクエスト形の出典（両方とも実機で gpt-5.6-luna を動かしている実装）:
 * - opencrab `/srv/opencrab/src/crates/llm/src/providers/chatgpt.rs` build_request_body
 *   (627-829 行): assistant は素の {role, content}、tool call は
 *   {type:"function_call", call_id, name, arguments}、tool 結果は
 *   {type:"function_call_output", call_id, output}。
 * - pi-ai `dist/providers/openai-codex-responses.js` buildRequestBody (249-286 行):
 *   store:false / stream:true / instructions 必須 / text.verbosity /
 *   tool_choice:"auto" / parallel_tool_calls:true。
 *
 * 意図的に送らないもの:
 * - max_tokens → Responses backend は max_output_tokens を 400 で拒否する
 *   (opencrab chatgpt.rs:755-756 の実測コメント)。
 * - temperature → opencrab は一切送らない。gpt-5 系 reasoning モデルは
 *   temperature を拒否する事例があるため既定では落とす
 *   (HERMIT_CODEX_FORWARD_TEMPERATURE=1 で素通しに変更可)。
 * - stop → Responses API に該当パラメータが無い。非ストリーミングでは
 *   応答集約後にクライアント側相当の切り詰めを行う。
 */

// ルーティング: bonsai と同じ「モデル名で分岐」方式。gpt-* は全部 codex へ。
export function isCodexModel(model: string): boolean {
  return model.startsWith("gpt-");
}

/** /v1/models に載せる代表モデル。ルーティングは前方一致なので、ここに無い
 *  gpt-* も素通しで使える（Claude モデルの「そのまま渡す」方針と同じ）。 */
export const CODEX_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
];

export function getCodexBaseUrl(): string {
  // 既定は本番 backend（pi-ai openai-codex-responses.js:21）。テストで差し替える。
  return process.env.HERMIT_CODEX_BASE_URL || "https://chatgpt.com/backend-api";
}

export function getCodexResponsesUrl(): string {
  // resolveCodexUrl (pi-ai openai-codex-responses.js:313-321) と同じ正規化。
  const base = getCodexBaseUrl().replace(/\/+$/, "");
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
}

interface OpenAIChatBody {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: unknown;
  temperature?: number;
  stream?: boolean;
  stop?: string | string[];
  [key: string]: unknown;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }
  return "";
}

/** OpenAI content（文字列 or parts 配列）→ Responses の input content。
 *  画像は input_image（image_url は「文字列」— opencrab chatgpt.rs:585-624 の注意書き）。 */
function contentToInputContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p: any) => {
        if (p?.type === "text") return { type: "input_text", text: p.text ?? "" };
        if (p?.type === "image_url") {
          const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
          return url ? { type: "input_image", image_url: url } : null;
        }
        return null;
      })
      .filter((p) => p !== null);
    if (parts.length > 0) return parts;
  }
  return "";
}

/** assistant 履歴の content → Responses の output content。
 *  responses API は assistant ロールに input_text を認めない
 *  （400: "Supported values are: output_text and refusal" — 2026-08-28 実測）。 */
function contentToOutputContent(content: unknown): unknown {
  const text = contentToText(content);
  return [{ type: "output_text", text }];
}

/** OpenAI chat リクエスト → codex/responses リクエストボディ。 */
export function buildCodexRequestBody(
  body: OpenAIChatBody,
  stream: boolean
): Record<string, unknown> {
  const systemPrompts: string[] = [];
  const input: unknown[] = [];

  for (const msg of body.messages as any[]) {
    if (msg.role === "system") {
      const text = contentToText(msg.content);
      if (text) systemPrompts.push(text);
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // 本文つき tool call は本文も履歴に残す（opencrab chatgpt.rs:678-702）。
      const text = contentToText(msg.content);
      if (text) {
        input.push({ role: "assistant", content: contentToOutputContent(msg.content) });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name,
          arguments:
            typeof tc.function?.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
        });
      }
      continue;
    }
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: contentToText(msg.content),
      });
      continue;
    }
    // user / assistant の通常メッセージ
    if (msg.role === "assistant") {
      input.push({ role: "assistant", content: contentToOutputContent(msg.content) });
    } else {
      input.push({ role: "user", content: contentToInputContent(msg.content) });
    }
  }

  const req: Record<string, unknown> = {
    model: body.model,
    store: false, // backend は store:true を拒否する（pi-ai openai-codex-responses.js:937）
    stream, // backend は常にストリーミングで返す。非ストリーミング要求はプロキシ側で集約
    // instructions が空だと 400（opencrab chatgpt.rs:766-771 の実測）。
    instructions:
      systemPrompts.length > 0 ? systemPrompts.join("\n\n") : "You are a helpful assistant.",
    input,
    text: { verbosity: process.env.HERMIT_CODEX_VERBOSITY || "medium" },
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  // reasoning effort: opencrab の運用既定は "low"（chatgpt.rs:264）。env で上書き。
  const effort = process.env.HERMIT_CODEX_REASONING_EFFORT || "low";
  if (effort !== "none") {
    req.reasoning = { effort };
  }

  if (body.tools && body.tools.length > 0) {
    // Responses のツール形は function 直下フラット（opencrab chatgpt.rs:777-787）。
    req.tools = body.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    // tool_choice は "auto"/"none"/"required" と named をそのまま写す
    // （opencrab chatgpt.rs:808-817）。
    if (typeof body.tool_choice === "string") {
      req.tool_choice = body.tool_choice;
    } else if (
      body.tool_choice &&
      typeof body.tool_choice === "object" &&
      (body.tool_choice as any).function?.name
    ) {
      req.tool_choice = {
        type: "function",
        name: (body.tool_choice as any).function.name,
      };
    }
  }

  if (
    process.env.HERMIT_CODEX_FORWARD_TEMPERATURE === "1" &&
    body.temperature !== undefined
  ) {
    req.temperature = body.temperature;
  }

  return req;
}

// --- SSE イベントの逐次パース ---

/** codex backend の SSE ストリームを逐次 JSON イベントに切り出す。
 *  区切りは空行（pi-ai openai-codex-responses.js:401-449 parseSSE と同じ規則）。 */
export class CodexSSEParser {
  private buffer = "";

  feed(chunk: string): Array<Record<string, any>> {
    this.buffer += chunk;
    const events: Array<Record<string, any>> = [];
    let idx = this.buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length > 0) {
        const data = dataLines.join("\n").trim();
        if (data && data !== "[DONE]") {
          try {
            events.push(JSON.parse(data));
          } catch {
            // 壊れたイベントは読み飛ばす（opencrab chatgpt.rs:865-870 と同じ寛容さ）
          }
        }
      }
      idx = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}

export interface CodexToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** ストリームを集約した結果。streaming / non-streaming 両ハンドラが共有する。 */
export interface CodexAggregate {
  responseId: string | null;
  content: string;
  /** message アイテム単位のテキスト。backend は 1 応答に message を複数出すことがある
   *  (2026-08-28 実測: verbosity=medium で message アイテム 7 個(ほぼ同一 JSON)が
   *  1 応答に出る)。content は無区切り連結なので、非ストリーミングでは
   *  finalText() でアイテム境界を尊重した本文を組む。 */
  textBlocks: string[];
  reasoning: string;
  toolCalls: CodexToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens: number;
  } | null;
  /** response.completed / incomplete の status ベース（opencrab chatgpt.rs:886-898） */
  truncated: boolean;
  error: string | null;
  done: boolean;
}

export function createAggregate(): CodexAggregate {
  return {
    responseId: null,
    content: "",
    textBlocks: [],
    reasoning: "",
    toolCalls: [],
    usage: null,
    truncated: false,
    error: null,
    done: false,
  };
}

function parseFunctionCallItem(item: any): CodexToolCall | null {
  // opencrab chatgpt.rs:988-1010 parse_function_call_item と同じ規則。
  if (item?.type !== "function_call") return null;
  const name = item.name;
  if (typeof name !== "string") return null;
  let args: string;
  if (typeof item.arguments === "string" && item.arguments.trim()) {
    args = item.arguments;
  } else if (item.arguments && typeof item.arguments === "object") {
    args = JSON.stringify(item.arguments);
  } else {
    args = "{}";
  }
  const id = item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 10)}`;
  return { id, name, arguments: args };
}

/**
 * イベントを 1 件集約へ反映し、増分テキストを返す（ストリーミング転送用）。
 * イベント種別は opencrab chatgpt.rs:874-935 / pi-ai openai-responses-shared.js:216-469 に基づく。
 */
export function applyCodexEvent(
  agg: CodexAggregate,
  event: Record<string, any>
): { textDelta?: string } {
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "response.created": {
      if (event.response?.id) agg.responseId = event.response.id;
      return {};
    }
    case "response.output_item.added": {
      // message アイテムの開始でテキストブロックを切る (2026-08-28 実測:
      // verbosity=medium で message アイテム 7 個(ほぼ同一 JSON)が 1 応答に出る)。
      if (event.item?.type === "message") {
        agg.textBlocks.push("");
      }
      return {};
    }
    case "response.output_text.delta": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      // content はストリーミング素通し用にそのまま連結を維持する。
      agg.content += delta;
      // output_item.added を出さない backend への防御: ブロックが無ければ作る。
      if (agg.textBlocks.length === 0) {
        agg.textBlocks.push(delta);
      } else {
        agg.textBlocks[agg.textBlocks.length - 1] += delta;
      }
      return { textDelta: delta };
    }
    case "response.reasoning_summary_text.delta": {
      // JIT は非ストリーミングで message.reasoning_content を読むので集めておく。
      if (typeof event.delta === "string") agg.reasoning += event.delta;
      return {};
    }
    case "response.reasoning_summary_part.done": {
      agg.reasoning += "\n\n";
      return {};
    }
    case "response.output_item.done": {
      const call = parseFunctionCallItem(event.item);
      if (call && !agg.toolCalls.some((tc) => tc.id === call.id)) {
        agg.toolCalls.push(call);
      }
      return {};
    }
    case "response.completed":
    case "response.done":
    case "response.incomplete": {
      const response = event.response ?? {};
      if (response.id) agg.responseId = response.id;
      if (
        response.status === "incomplete" &&
        response.incomplete_details?.reason === "max_output_tokens"
      ) {
        agg.truncated = true;
      }
      if (Array.isArray(response.output)) {
        for (const item of response.output) {
          const call = parseFunctionCallItem(item);
          if (call && !agg.toolCalls.some((tc) => tc.id === call.id)) {
            agg.toolCalls.push(call);
          }
        }
      }
      const u = response.usage;
      if (u) {
        const prompt = u.input_tokens ?? 0;
        const completion = u.output_tokens ?? 0;
        agg.usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: u.total_tokens ?? prompt + completion,
          cached_tokens: u.input_tokens_details?.cached_tokens ?? 0,
        };
      }
      agg.done = true;
      return {};
    }
    case "response.failed": {
      const err = event.response?.error;
      agg.error = err?.message || err?.code || "codex response failed";
      agg.done = true;
      return {};
    }
    case "error": {
      agg.error = event.message || event.code || "codex error";
      agg.done = true;
      return {};
    }
    default:
      return {};
  }
}

/** 非ストリーミング応答の本文。message アイテムが複数あるとき、content の
 *  無区切り連結だと {...}{...}{...} になり strict-JSON 消費者 (JIT) がパースに
 *  失敗する (2026-08-28 実測: verbosity=medium で message アイテム 7 個
 *  (ほぼ同一 JSON)が 1 応答に出る)。
 *  HERMIT_CODEX_TEXT_MODE=first → 最初の非空ブロックのみ / last → 最後の
 *  非空ブロックのみ / 既定 concat → 非空ブロックを "\n\n" 連結。
 *  単一ブロック以下なら content と同一（後方互換）。
 *  agentic なステップループには first が正しい (2026-08-28 実測: TEXT_MODE=last
 *  だと多段 message のロールプレイ軌跡の「結論」だけが返り、ツール未実行のまま
 *  step 1 で final_answer される — 最初のアイテムが即時実行可能な JSON)。 */
export function finalText(agg: CodexAggregate): string {
  if (agg.textBlocks.length <= 1) return agg.content;
  const nonEmpty = agg.textBlocks.filter((b) => b !== "");
  if (nonEmpty.length === 0) return agg.content;
  const mode = process.env.HERMIT_CODEX_TEXT_MODE || "concat";
  if (mode === "first") {
    return nonEmpty[0];
  }
  if (mode === "last") {
    return nonEmpty[nonEmpty.length - 1];
  }
  return nonEmpty.join("\n\n");
}

export function codexFinishReason(agg: CodexAggregate): "stop" | "length" | "tool_calls" {
  // 打ち切りは tool_calls / content より優先して length（opencrab chatgpt.rs:952-961）。
  if (agg.truncated) return "length";
  if (agg.toolCalls.length > 0) return "tool_calls";
  return "stop";
}

/** stop シーケンスのクライアント側切り詰め（backend に stop パラメータが無いため）。
 *  最初に現れた stop 文字列の末尾までを残す — JIT
 *  scripts/models/openai_server.py truncate_content_based_on_stop_sequences と同じ規則。 */
export function truncateAtStop(content: string, stop: string | string[] | undefined): string {
  if (!stop) return content;
  const stops = Array.isArray(stop) ? stop : [stop];
  for (const s of stops) {
    if (!s) continue;
    const index = content.indexOf(s);
    if (index !== -1) {
      return content.slice(0, index + s.length);
    }
  }
  return content;
}

/** 集約結果 → OpenAI chat.completion（非ストリーミング応答）。 */
export function aggregateToOpenAIResponse(
  agg: CodexAggregate,
  requestedModel: string,
  id: string,
  created: number,
  stop?: string | string[]
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    // content 直読みだと複数 message アイテムが無区切り連結になるので finalText で組む。
    content: truncateAtStop(finalText(agg), stop) || null,
  };
  if (agg.reasoning.trim()) {
    message.reasoning_content = agg.reasoning.trim();
  }
  if (agg.toolCalls.length > 0) {
    message.tool_calls = agg.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  const usage = agg.usage ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
  };
  return {
    id,
    object: "chat.completion",
    created,
    model: requestedModel,
    codex_response_id: agg.responseId,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: codexFinishReason(agg),
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      prompt_tokens_details: { cached_tokens: usage.cached_tokens },
    },
  };
}
