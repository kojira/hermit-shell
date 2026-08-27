import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * OpenAI Codex (ChatGPT サブスクリプション) の OAuth 認証。
 *
 * プロトコルの出典（すべて実機で動いている実装から抽出）:
 * - pi-ai `dist/utils/oauth/openai-codex.js` — PKCE 認可フロー・トークン交換・リフレッシュ
 * - opencrab `/srv/opencrab/src/crates/llm/src/providers/chatgpt.rs` — リフレッシュの
 *   排他制御・原子的永続化・60 秒マージンの失効判定
 *
 * ⚠ 認証状態はこのプロキシ専用ファイル（.hermit-codex-auth.json）に保存する。
 * codex CLI や pi の auth.json（~/.codex/auth.json, ~/.pi/agent/auth.json）は
 * 絶対に読まない・書かない。refresh_token は使用のたびにローテーションされるため、
 * 複数のプロセスで共有すると invalid_grant（refresh_token_reused）で両方が死ぬ。
 */

// pi-ai openai-codex.js:21-25 / opencrab chatgpt.rs:17-20 と同一の公開クライアント。
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
// redirect_uri はクライアント登録に紐づく固定値（pi-ai openai-codex.js:24）。変更不可。
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

// 失効 60 秒前からリフレッシュ対象にする（opencrab chatgpt.rs:336-349 と同じマージン）。
const EXPIRY_MARGIN_MS = 60 * 1000;

/** テスト時に差し替えられるようにする（opencrab の with_oauth_token_url と同じ発想）。 */
export function getTokenUrl(): string {
  return process.env.HERMIT_CODEX_TOKEN_URL || DEFAULT_TOKEN_URL;
}

/** .hermit-auth と同じ流儀: リポジトリ直下・env で上書き可能。 */
export function getCodexAuthFilePath(): string {
  return (
    process.env.HERMIT_CODEX_AUTH_FILE ||
    path.join(process.cwd(), ".hermit-codex-auth.json")
  );
}

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  account_id: string;
  /** epoch ms。expires_in から計算。 */
  expires_at: number;
  last_refresh: string;
}

export function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/** access_token の JWT クレームから ChatGPT アカウント ID を取り出す
 *  （pi-ai openai-codex-responses.js:1025-1039。リクエストヘッダに必須）。 */
export function extractAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

export function loadCodexTokens(): CodexTokens | null {
  try {
    const raw = fs.readFileSync(getCodexAuthFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.access_token === "string" &&
      typeof parsed?.refresh_token === "string" &&
      typeof parsed?.account_id === "string"
    ) {
      return parsed as CodexTokens;
    }
    return null;
  } catch {
    return null;
  }
}

/** temp→rename の原子的書き込み・0600（applyAuthToken / opencrab chatgpt.rs:432-459 と同じ流儀）。 */
export function saveCodexTokens(tokens: CodexTokens): void {
  const filePath = getCodexAuthFilePath();
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.hermit-codex-auth.tmp.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function isExpired(tokens: CodexTokens): boolean {
  return Date.now() >= tokens.expires_at - EXPIRY_MARGIN_MS;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function tokensFromEndpointResponse(
  json: TokenEndpointResponse,
  fallbackRefresh?: string
): CodexTokens {
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("codex token endpoint response missing fields");
  }
  const accountId = extractAccountId(json.access_token);
  if (!accountId) {
    throw new Error("failed to extract chatgpt_account_id from access token");
  }
  const refresh = json.refresh_token || fallbackRefresh;
  if (!refresh) {
    throw new Error("codex token endpoint response missing refresh_token");
  }
  return {
    access_token: json.access_token,
    refresh_token: refresh,
    account_id: accountId,
    expires_at: Date.now() + json.expires_in * 1000,
    last_refresh: new Date().toISOString(),
  };
}

/** 認可コードをトークンへ交換する（pi-ai openai-codex.js:73-106）。 */
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string
): Promise<CodexTokens> {
  const response = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // トークンはレスポンスに含まれ得ないが、念のため本文は 200 文字で切ってから伝える。
    throw new Error(
      `codex token exchange failed (${response.status}): ${text.slice(0, 200)}`
    );
  }
  return tokensFromEndpointResponse((await response.json()) as TokenEndpointResponse);
}

// 同時リクエストが同じ refresh_token を二重に使うと invalid_grant で死ぬため、
// リフレッシュはプロセス内で直列化する（opencrab chatgpt.rs:361-373 の REFRESH_LOCK 相当）。
let refreshInFlight: Promise<CodexTokens> | null = null;

async function doRefresh(stale: CodexTokens): Promise<CodexTokens> {
  // ロック待ちの間に別リクエストがリフレッシュ済みかもしれない — 再読して確認。
  const current = loadCodexTokens();
  if (current && !isExpired(current) && current.access_token !== stale.access_token) {
    return current;
  }
  const refreshToken = current?.refresh_token ?? stale.refresh_token;
  // urlencoded の grant_type=refresh_token（pi-ai openai-codex.js:107-146 と同形）。
  const response = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `codex token refresh failed (${response.status}): ${text.slice(0, 200)} — ` +
        "/setup から再ログインしてください"
    );
  }
  const tokens = tokensFromEndpointResponse(
    (await response.json()) as TokenEndpointResponse,
    refreshToken
  );
  saveCodexTokens(tokens);
  console.log("[hermit-shell] codex access token refreshed");
  return tokens;
}

/**
 * 有効な access_token / account_id を返す。失効間際ならリフレッシュして永続化する。
 * 未ログインなら null（呼び出し側が 503 を返す）。
 */
export async function getFreshCodexTokens(): Promise<CodexTokens | null> {
  const tokens = loadCodexTokens();
  if (!tokens) return null;
  if (!isExpired(tokens)) return tokens;
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(tokens).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// --- PKCE 認可フロー（設定ページから使う） ---

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface AuthorizationFlow {
  verifier: string;
  state: string;
  url: string;
}

/** 認可 URL を組む（pi-ai openai-codex.js:147-162。追加クエリも同一に揃える）。 */
export function createAuthorizationFlow(): AuthorizationFlow {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return { verifier, state, url: url.toString() };
}

/** 貼り付けられた「リダイレクト URL 全体 or コード単体」を許容する
 *  （pi-ai openai-codex.js:33-59 と同じ寛容さ）。 */
export function parseAuthorizationInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // URL ではない
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

/** 表示用マスク（auth.ts maskToken と同じ流儀・アカウント ID 用）。 */
export function maskAccountId(accountId: string | undefined | null): string | null {
  if (!accountId) return null;
  if (accountId.length <= 12) return "(set)";
  return `${accountId.slice(0, 8)}…${accountId.slice(-4)}`;
}
