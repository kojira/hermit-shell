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
import { codexStatus } from "./codex_setup";

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
  const codex = codexStatus();
  const codexAccountSafe = codex.maskedAccountId
    ? escapeHtml(codex.maskedAccountId)
    : "(未設定)";
  const codexLastSafe = codex.lastApplied ? escapeHtml(codex.lastApplied) : "(不明)";
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
  #result, #codex-result { margin-top: 12px; padding: 10px; border-radius: 6px; display: none; white-space: pre-wrap; }
  #result.ok, #codex-result.ok { display: block; background: #e7f6e7; border: 1px solid #86c586; }
  #result.err, #codex-result.err { display: block; background: #fdeaea; border: 1px solid #e0a3a3; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 10px; font-family: monospace; font-size: 0.95rem; }
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
<h1>OpenAI Codex (ChatGPT サブスク) 認証設定</h1>
<div class="card">
  <div>アカウント: <code>${codexAccountSafe}</code></div>
  <div class="muted">最終適用: ${codexLastSafe}</div>
</div>
<div class="card">
  <button id="codex-start">ログイン URL を発行</button>
  <div id="codex-url" class="muted" style="display:none; margin-top:12px; word-break:break-all;"></div>
  <div id="codex-paste" style="display:none; margin-top:12px;">
    <label for="codex-input">リダイレクト先 URL（アドレスバーの <code>http://localhost:1455/auth/callback?code=…</code> 全体）を貼り付け</label>
    <input id="codex-input" type="text" autocomplete="off" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
    <button id="codex-finish">完了する</button>
  </div>
  <div id="codex-result"></div>
  <p class="muted">上のリンクをブラウザで開いて ChatGPT アカウントでログインしてください。
  リダイレクト先（localhost:1455）は通常「接続できません」になります — それで正常です。
  そのページの URL 全体をコピーしてここに貼り付けてください。
  <code>ssh -L 1455:127.0.0.1:1455</code> を張っている場合は貼り付け不要で自動完了します。</p>
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

  // --- OpenAI Codex ログイン ---
  const codexStart = document.getElementById('codex-start');
  const codexFinish = document.getElementById('codex-finish');
  const codexResult = document.getElementById('codex-result');
  let codexPoll = null;

  function codexShow(cls, text) {
    codexResult.className = cls;
    codexResult.textContent = text;
  }

  codexStart.addEventListener('click', async () => {
    codexStart.disabled = true;
    try {
      const r = await fetch('/setup/codex/start', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) { codexShow('err', 'エラー: ' + (data.error || r.status)); return; }
      const urlDiv = document.getElementById('codex-url');
      urlDiv.style.display = 'block';
      urlDiv.innerHTML = '';
      const a = document.createElement('a');
      a.href = data.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = data.url;
      urlDiv.appendChild(a);
      document.getElementById('codex-paste').style.display = 'block';
      codexShow('', '');
      // コールバック（ssh -L 1455 経由）での自動完了をポーリングで検知する
      if (codexPoll) clearInterval(codexPoll);
      codexPoll = setInterval(async () => {
        try {
          const s = await fetch('/setup/codex/status');
          const sd = await s.json();
          if (sd.lastResult) {
            clearInterval(codexPoll); codexPoll = null;
            codexShow(sd.lastResult.ok ? 'ok' : 'err', sd.lastResult.message);
            if (sd.lastResult.ok) setTimeout(() => location.reload(), 1500);
          }
        } catch (e) { /* 一時的な通信エラーは無視 */ }
      }, 2000);
    } catch (e) {
      codexShow('err', '通信エラー');
    } finally {
      codexStart.disabled = false;
    }
  });

  codexFinish.addEventListener('click', async () => {
    const input = document.getElementById('codex-input').value.trim();
    if (!input) { codexShow('err', 'リダイレクト URL を貼り付けてください'); return; }
    codexFinish.disabled = true;
    codexShow('', '');
    codexResult.style.display = 'block';
    codexResult.textContent = 'トークン交換中...';
    try {
      const r = await fetch('/setup/codex/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const data = await r.json();
      if (r.ok) {
        if (codexPoll) { clearInterval(codexPoll); codexPoll = null; }
        codexShow('ok', data.message || 'ログイン完了');
        setTimeout(() => location.reload(), 1500);
      } else {
        codexShow('err', 'エラー: ' + (data.error || r.status));
      }
    } catch (e) {
      codexShow('err', '通信エラー');
    } finally {
      codexFinish.disabled = false;
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
