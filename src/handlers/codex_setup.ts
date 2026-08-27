import { Request, Response } from "express";
import * as fs from "fs";
import * as http from "http";
import {
  AuthorizationFlow,
  createAuthorizationFlow,
  exchangeAuthorizationCode,
  getCodexAuthFilePath,
  loadCodexTokens,
  maskAccountId,
  parseAuthorizationInput,
  saveCodexTokens,
} from "../utils/codex_auth";

/**
 * 設定ページ（/setup）から使う OpenAI Codex ログインの裏側。
 *
 * Claude トークンの「フロントエンドから設定する」流儀（setup.ts）に合わせて、
 * OAuth も設定ページ主導にする:
 *   1. POST /setup/codex/start  → PKCE を生成し認可 URL を返す（ページが表示）
 *   2. ユーザーがブラウザで OpenAI にログイン
 *   3. リダイレクト先 http://localhost:1455/auth/callback は
 *      a) `ssh -L 1455:127.0.0.1:1455` を張っていれば下の一時リスナーが受けて完了
 *      b) 張っていなければブラウザにエラーが出るので、アドレスバーの URL 全体を
 *         ページに貼り付けて POST /setup/codex/finish で完了
 * どちらの経路も同じ finishLogin() に合流する。
 *
 * フローの形は pi-ai `dist/utils/oauth/openai-codex.js` loginOpenAICodex
 * （コールバック待ちと手動貼り付けの並走）をそのまま踏襲している。
 */

interface PendingLogin {
  flow: AuthorizationFlow;
  createdAt: number;
  server: http.Server | null;
}

let pending: PendingLogin | null = null;
/** 直近のログイン試行の結果。コールバック経由の完了をページのポーリングへ伝える。 */
let lastResult: { ok: boolean; message: string } | null = null;

const PENDING_TTL_MS = 10 * 60 * 1000;

// setup.ts と同じ loopback 判定（詐称可能なヘッダは見ない）。
function isLoopback(req: Request): boolean {
  const addr = req.socket.remoteAddress || "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

function denyRemote(res: Response): void {
  res.status(403).json({ error: "forbidden: localhost only" });
}

export interface CodexStatus {
  configured: boolean;
  maskedAccountId: string | null;
  expiresAt: string | null;
  lastApplied: string | null;
}

/** /setup ページの表示用ステータス。トークン本体は決して返さない。 */
export function codexStatus(): CodexStatus {
  const tokens = loadCodexTokens();
  let lastApplied: string | null = null;
  try {
    lastApplied = fs.statSync(getCodexAuthFilePath()).mtime.toISOString();
  } catch {
    lastApplied = null;
  }
  return {
    configured: tokens !== null,
    maskedAccountId: maskAccountId(tokens?.account_id),
    expiresAt: tokens ? new Date(tokens.expires_at).toISOString() : null,
    lastApplied,
  };
}

function closePendingServer(): void {
  if (pending?.server) {
    try {
      pending.server.close();
    } catch {
      // すでに閉じている
    }
    pending.server = null;
  }
}

async function finishLogin(code: string): Promise<{ ok: boolean; message: string }> {
  if (!pending) {
    return { ok: false, message: "ログインが開始されていません" };
  }
  try {
    const tokens = await exchangeAuthorizationCode(code, pending.flow.verifier);
    // 構造検証（accountId 抽出）は exchangeAuthorizationCode 内で通過済み。
    // 実呼び出しでの検証はトークン消費を伴うため行わない。
    saveCodexTokens(tokens);
    const masked = maskAccountId(tokens.account_id);
    closePendingServer();
    pending = null;
    lastResult = { ok: true, message: `ログイン完了 (account: ${masked})` };
    return lastResult;
  } catch (error: any) {
    lastResult = { ok: false, message: error?.message || "token exchange failed" };
    return lastResult;
  }
}

/**
 * リダイレクト（http://localhost:1455/auth/callback）を受ける一時リスナー。
 * pi-ai openai-codex.js:163-237 startLocalOAuthServer と同じ役割。
 * ポートが塞がっていても致命ではない（貼り付け経路が常に使える）ので、
 * エラー時は静かに諦める。127.0.0.1 のみに bind する。
 */
function startCallbackListener(login: PendingLogin): void {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        if (url.pathname !== "/auth/callback") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        if (url.searchParams.get("state") !== login.flow.state) {
          res.statusCode = 400;
          res.end("state mismatch");
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.statusCode = 400;
          res.end("missing authorization code");
          return;
        }
        const result = await finishLogin(code);
        res.statusCode = result.ok ? 200 : 500;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          result.ok
            ? "<html><body>OpenAI Codex login completed. You can close this window.</body></html>"
            : `<html><body>Login failed: ${result.message}</body></html>`
        );
      } catch {
        res.statusCode = 500;
        res.end("internal error");
      }
    })();
  });
  server.on("error", () => {
    // 1455 が使用中など。貼り付け経路にフォールバック。
    login.server = null;
  });
  server.listen(1455, "127.0.0.1", () => {
    login.server = server;
  });
}

/** 進行中のログインを破棄して 1455 のリスナーを閉じる（テストからも使う）。 */
export function cancelCodexLogin(): void {
  closePendingServer();
  pending = null;
}

/** POST /setup/codex/start — PKCE を生成して認可 URL を返す。 */
export function handleCodexSetupStart(req: Request, res: Response): void {
  if (!isLoopback(req)) return denyRemote(res);

  closePendingServer();
  pending = {
    flow: createAuthorizationFlow(),
    createdAt: Date.now(),
    server: null,
  };
  lastResult = null;
  startCallbackListener(pending);
  res.status(200).json({ url: pending.flow.url });
}

/** POST /setup/codex/finish — 貼り付けられたリダイレクト URL（または code）で完了。 */
export async function handleCodexSetupFinish(
  req: Request,
  res: Response
): Promise<void> {
  if (!isLoopback(req)) return denyRemote(res);

  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    closePendingServer();
    pending = null;
    res.status(400).json({ error: "ログインが開始されていないか期限切れです。やり直してください" });
    return;
  }

  const input = (req.body && (req.body as any).input) as unknown;
  if (typeof input !== "string" || !input.trim()) {
    res.status(400).json({ error: "リダイレクト URL または認可コードを貼り付けてください" });
    return;
  }

  const parsed = parseAuthorizationInput(input);
  if (parsed.state && parsed.state !== pending.flow.state) {
    res.status(400).json({ error: "state が一致しません。最初からやり直してください" });
    return;
  }
  if (!parsed.code) {
    res.status(400).json({ error: "認可コードを取り出せませんでした" });
    return;
  }

  const result = await finishLogin(parsed.code);
  if (!result.ok) {
    res.status(401).json({ error: result.message });
    return;
  }
  res.status(200).json({ ok: true, message: result.message, status: codexStatus() });
}

/** GET /setup/codex/status — ページのポーリング用（コールバック完了の検知にも使う）。 */
export function handleCodexSetupStatus(req: Request, res: Response): void {
  if (!isLoopback(req)) return denyRemote(res);
  res.status(200).json({
    status: codexStatus(),
    lastResult,
    pendingActive: pending !== null,
  });
}
