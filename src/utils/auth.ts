import * as fs from "fs";
import * as path from "path";

export type AuthResult =
  | { method: "env-api-key"; apiKey: string }
  | { method: "env-auth-token"; authToken: string }
  | { method: "none" };

export function resolveAuth(): AuthResult {
  // 1. ANTHROPIC_API_KEY env var → x-api-key header
  if (process.env.ANTHROPIC_API_KEY) {
    return { method: "env-api-key", apiKey: process.env.ANTHROPIC_API_KEY };
  }

  // 2. ANTHROPIC_AUTH_TOKEN env var → Bearer header
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return {
      method: "env-auth-token",
      authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    };
  }

  // 環境変数が無ければ認証なし（fail loud）。外部プロジェクトのファイルは読まない。
  return { method: "none" };
}

/** @deprecated Use resolveAuth() instead */
export function getAnthropicAuthToken(): string | null {
  const auth = resolveAuth();
  if ("authToken" in auth) return auth.authToken;
  return null;
}

const BASE_BETA = "fine-grained-tool-streaming-2025-05-14";
const OAUTH_BETA = `claude-code-20250219,oauth-2025-04-20,${BASE_BETA},interleaved-thinking-2025-05-14`;

/**
 * OAuth（sk-ant-oat…）トークンで Bearer 認証するクライアントを組む。
 * env-auth-token の本番経路と、設定ページのトークン検証がこの 1 箇所を共有する
 * ——検証で通した組み立てと本番の組み立てがズレて「検証は通ったのに本番で失敗」を
 * 起こさないため。
 */
function buildAuthTokenClient(authToken: string) {
  const Anthropic = require("@anthropic-ai/sdk");
  return new Anthropic.default({
    authToken,
    defaultHeaders: {
      "anthropic-beta": OAUTH_BETA,
      "user-agent": "claude-cli/2.1.62",
      "x-app": "cli",
    },
  });
}

export function createAnthropicClient() {
  const Anthropic = require("@anthropic-ai/sdk");
  const auth = resolveAuth();

  switch (auth.method) {
    case "env-api-key":
      return new Anthropic.default({
        apiKey: auth.apiKey,
        defaultHeaders: { "anthropic-beta": BASE_BETA },
      });
    case "env-auth-token":
      return buildAuthTokenClient(auth.authToken);
    case "none":
    default:
      return new Anthropic.default({
        defaultHeaders: { "anthropic-beta": BASE_BETA },
      });
  }
}

// --- 設定ページ（GET/POST /setup）が使う認証トークンの検証・適用・表示 ---

/** start.sh が読む認証ファイル。start.sh は cwd=リポジトリ直下で node を起動する。 */
export function getAuthFilePath(): string {
  return process.env.HERMIT_AUTH_FILE || path.join(process.cwd(), ".hermit-auth");
}

/**
 * トークンの緩い形式チェック。実体の可否は verifyAuthToken の実呼び出しが担うので、
 * ここでは将来の形式変更で壊れない最小限（sk-ant- 前置き）だけ見る。
 */
export function looksLikeToken(token: string): boolean {
  return typeof token === "string" && token.startsWith("sk-ant-");
}

/** 表示用のマスク。先頭のプレフィックスと末尾数文字だけ残し、乱数部はほぼ伏せる。 */
export function maskToken(token: string | undefined | null): string | null {
  if (!token) return null;
  if (token.length <= 20) return "(set)";
  return `${token.slice(0, 16)}…${token.slice(-4)}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; status?: number };

/**
 * 渡されたトークンで最小の messages 呼び出しを行い、認証が通るかだけを確かめる。
 * 共有クライアントには一切触れないので、失敗しても既存の推論経路は無傷。
 * OAuth トークンは Claude Code の system prompt を要求するため本番と同じ形で送る。
 */
export async function verifyAuthToken(token: string): Promise<VerifyResult> {
  const client = buildAuthTokenClient(token);
  try {
    await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    return { ok: true };
  } catch (error: any) {
    // トークンはログにもレスポンスにも出さない。ステータスコードだけ拾う。
    const status: number | undefined = error?.status ?? error?.statusCode;
    return { ok: false, status };
  }
}

/**
 * 検証済みトークンを永続化（.hermit-auth・0600・末尾改行付きで現行形式に一致）し、
 * 実行中プロセスの環境変数へも反映する。ファイルは temp→rename で原子的に差し替える。
 * env の更新は resolveAuth() の結果を即座に変える——呼び出し側で共有クライアントの
 * キャッシュを破棄すれば全経路が新トークンに切り替わる。
 */
export function applyAuthToken(token: string): void {
  const filePath = getAuthFilePath();
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.hermit-auth.tmp.${process.pid}`);
  // 現行ファイルは「トークン + 末尾 \n」。start.sh の $(cat) が改行を落として env に入れる。
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);

  process.env.ANTHROPIC_AUTH_TOKEN = token;
}
