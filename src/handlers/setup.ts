import { Request, Response } from "express";
import * as fs from "fs";
import {
  resolveAuth,
  verifyAuthToken,
  applyAuthToken,
  looksLikeToken,
  maskToken,
  getAuthFilePath,
} from "../utils/auth";
import { resetClient } from "./chat";

/**
 * リクエスト元が loopback かどうかを、ソケットの実接続元アドレスだけで判定する。
 * X-Forwarded-For / req.ip は詐称できるので信用しない（サーバは全インターフェースで
 * listen しているため、この判定が設定ページの唯一の防壁になる）。
 */
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

/** 現在の認証状態（マスク済み）と最後にファイルへ適用した時刻を返す。 */
function currentStatus(): { masked: string | null; lastApplied: string | null } {
  const auth = resolveAuth();
  const token =
    "authToken" in auth ? auth.authToken : "apiKey" in auth ? auth.apiKey : null;
  let lastApplied: string | null = null;
  try {
    lastApplied = fs.statSync(getAuthFilePath()).mtime.toISOString();
  } catch {
    lastApplied = null;
  }
  return { masked: maskToken(token), lastApplied };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(): string {
  const { masked, lastApplied } = currentStatus();
  const maskedSafe = masked ? escapeHtml(masked) : "(未設定)";
  const lastSafe = lastApplied ? escapeHtml(lastApplied) : "(不明)";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hermit-shell 認証設定</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 1.3rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 16px 0; }
  code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px; font-family: monospace; font-size: 0.95rem; }
  button { margin-top: 12px; padding: 10px 18px; font-size: 1rem; cursor: pointer; }
  .muted { color: #666; font-size: 0.9rem; }
  #result { margin-top: 12px; padding: 10px; border-radius: 6px; display: none; white-space: pre-wrap; }
  #result.ok { display: block; background: #e7f6e7; border: 1px solid #86c586; }
  #result.err { display: block; background: #fdeaea; border: 1px solid #e0a3a3; }
</style>
</head>
<body>
<h1>hermit-shell 認証設定</h1>
<div class="card">
  <div>現在のトークン: <code>${maskedSafe}</code></div>
  <div class="muted">最終適用: ${lastSafe}</div>
</div>
<div class="card">
  <label for="token">Claude セットアップトークン（<code>sk-ant-oat01-…</code>）</label>
  <input id="token" type="password" autocomplete="off" placeholder="sk-ant-oat01-...">
  <button id="apply">検証して適用</button>
  <div id="result"></div>
  <p class="muted">入力トークンで Anthropic へ最小の検証呼び出しを行い、成功したときだけ保存・即適用します。失敗時は何も変更しません。</p>
</div>
<script>
  const btn = document.getElementById('apply');
  const result = document.getElementById('result');
  btn.addEventListener('click', async () => {
    const token = document.getElementById('token').value.trim();
    result.className = '';
    result.textContent = '';
    if (!token) { result.className = 'err'; result.textContent = 'トークンを入力してください'; return; }
    btn.disabled = true;
    result.className = ''; result.style.display = 'block'; result.textContent = '検証中...';
    try {
      const r = await fetch('/setup/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await r.json();
      if (r.ok) {
        result.className = 'ok';
        result.textContent = '適用しました: ' + (data.masked || '') + '\\n最終適用: ' + (data.lastApplied || '');
        document.getElementById('token').value = '';
      } else {
        result.className = 'err';
        result.textContent = 'エラー: ' + (data.error || r.status);
      }
    } catch (e) {
      result.className = 'err';
      result.textContent = '通信エラー';
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

export function handleSetupPage(req: Request, res: Response): void {
  if (!isLoopback(req)) return denyRemote(res);
  res.status(200).type("html").send(renderPage());
}

export async function handleSetupToken(
  req: Request,
  res: Response
): Promise<void> {
  if (!isLoopback(req)) return denyRemote(res);

  const token = (req.body && (req.body as any).token) as unknown;
  if (typeof token !== "string" || !looksLikeToken(token)) {
    // fail loud: 形式で明らかにおかしいものは検証呼び出しに進めず 400（トークンは返さない）。
    res.status(400).json({ error: "invalid token format (expected sk-ant-…)" });
    return;
  }

  const verified = await verifyAuthToken(token);
  if (!verified.ok) {
    // 検証失敗: ファイルも env も共有クライアントも一切触らない（既存経路は無傷のまま）。
    const status =
      verified.status === 401 || verified.status === 400 ? verified.status : 401;
    res.status(status).json({
      error: `token verification failed (${verified.status ?? "no response"})`,
    });
    return;
  }

  // 検証成功時のみ: 永続化 → env 反映 → 共有クライアント破棄、の順で原子的に切り替える。
  applyAuthToken(token);
  resetClient();

  const { masked, lastApplied } = currentStatus();
  res.status(200).json({ ok: true, masked, lastApplied });
}
