/**
 * Anthropic の生ストリームイベントから最終メッセージを組み立てる。
 *
 * SDK の MessageStream は input_json_delta を受け取るたびに partial JSON parser で
 * tool 引数を逐次 parse し、その例外で応答全体を失う。モデルが文字列中に生の制御文字
 * （改行・タブなど）を含めると `Bad control character in string literal` になるため、
 * ここでは受信中は文字列として連結するだけにして、ブロック完了時に一度だけ解釈する。
 */

import { partialParse } from "@anthropic-ai/sdk/_vendor/partial-json-parser/parser";

type AnyRecord = Record<string, any>;


/**
 * JSON 文字列リテラル内の未エスケープ制御文字（U+0000〜U+001F）を \uXXXX へ置換する。
 * 文字列外の空白（改行・タブ）は JSON として正当なので変更しない。
 */
export function escapeControlCharsInJsonStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * 受信済みの tool 引数 JSON を解釈する。空は {}。
 * 通常の parse → 制御文字を救済した parse → 途中までの JSON（max_tokens 打ち切り等）
 * を SDK と同じ partial parser で解釈、の順に試し、応答全体を失わない。
 * どれも解釈できない場合だけ生文字列を input として返す（変換側は文字列 input を素通しする）。
 */
export function parseToolInputJson(json: string): unknown {
  if (json.trim() === "") return {};
  try {
    return JSON.parse(json);
  } catch {
    const escaped = escapeControlCharsInJsonStrings(json);
    try {
      return JSON.parse(escaped);
    } catch {
      try {
        return partialParse(escaped);
      } catch {
        return json;
      }
    }
  }
}

function tracksToolInput(block: AnyRecord | undefined): boolean {
  return (
    block?.type === "tool_use" ||
    block?.type === "server_tool_use" ||
    block?.type === "mcp_tool_use"
  );
}

export class MessageAccumulator {
  private snapshot: AnyRecord | undefined;
  /** tool 引数 JSON の受信バッファ。応答本体には出さない。 */
  private readonly inputBuffers = new Map<AnyRecord, string>();

  /** イベントを1件取り込む。text_delta の場合は追加テキストを返す。 */
  add(event: AnyRecord): string | undefined {
    if (event.type === "message_start") {
      this.snapshot = { ...event.message, content: [...(event.message?.content ?? [])] };
      return undefined;
    }
    const snapshot = this.snapshot;
    if (!snapshot) {
      throw new Error(`Unexpected event order, got ${event.type} before "message_start"`);
    }
    switch (event.type) {
      case "message_delta": {
        snapshot.stop_reason = event.delta?.stop_reason ?? snapshot.stop_reason;
        snapshot.stop_sequence = event.delta?.stop_sequence ?? snapshot.stop_sequence;
        const usage = event.usage ?? {};
        snapshot.usage = { ...(snapshot.usage ?? {}) };
        for (const [key, value] of Object.entries(usage)) {
          if (value != null) snapshot.usage[key] = value;
        }
        return undefined;
      }
      case "content_block_start": {
        const block: AnyRecord = { ...event.content_block };
        if (tracksToolInput(block)) this.inputBuffers.set(block, "");
        snapshot.content[event.index] = block;
        return undefined;
      }
      case "content_block_delta": {
        const block: AnyRecord | undefined = snapshot.content[event.index];
        const delta = event.delta ?? {};
        switch (delta.type) {
          case "text_delta":
            if (block?.type === "text") {
              block.text = (block.text ?? "") + delta.text;
              return delta.text;
            }
            return undefined;
          case "input_json_delta":
            if (block && this.inputBuffers.has(block)) {
              this.inputBuffers.set(block, this.inputBuffers.get(block)! + (delta.partial_json ?? ""));
            }
            return undefined;
          case "thinking_delta":
            if (block?.type === "thinking") block.thinking = (block.thinking ?? "") + delta.thinking;
            return undefined;
          case "signature_delta":
            if (block?.type === "thinking") block.signature = delta.signature;
            return undefined;
          case "citations_delta":
            if (block?.type === "text") block.citations = [...(block.citations ?? []), delta.citation];
            return undefined;
          default:
            return undefined;
        }
      }
      case "content_block_stop": {
        this.finalizeBlock(snapshot.content[event.index]);
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private finalizeBlock(block: AnyRecord | undefined): void {
    if (!block || !this.inputBuffers.has(block)) return;
    const buffer = this.inputBuffers.get(block)!;
    this.inputBuffers.delete(block);
    // 差分が無い場合は content_block_start の input をそのまま使う。
    if (buffer !== "") block.input = parseToolInputJson(buffer);
  }

  /** 最終メッセージ。未完了ブロックもここで確定させる。 */
  finalMessage(): AnyRecord {
    if (!this.snapshot) throw new Error("Stream ended without a message");
    for (const block of this.snapshot.content) this.finalizeBlock(block);
    return this.snapshot;
  }
}

/**
 * 生イベントを消費して最終メッセージを返す。text は到着順に onText へ渡す。
 */
export async function accumulateMessage(
  events: AsyncIterable<AnyRecord>,
  onText?: (text: string) => void
): Promise<AnyRecord> {
  const accumulator = new MessageAccumulator();
  for await (const event of events) {
    const text = accumulator.add(event);
    if (text && onText) onText(text);
  }
  return accumulator.finalMessage();
}
