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
import {
  ClaudeSetupTokenFlow,
  publicSetupTokenStatus,
  spawnOfficialClaudeSetupToken,
} from "../utils/setup_token_flow";

const claudeSetupTokenFlow = new ClaudeSetupTokenFlow({
  spawn: spawnOfficialClaudeSetupToken,
  verify: verifyAuthToken,
  apply: applyAuthToken,
  resetClient,
});

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

export function renderPage(): string {
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
  input[type=password], input[type=text] { width: 100%; box-sizing: border-box; padding: 10px; font-family: monospace; font-size: 0.95rem; }
  button { margin-top: 12px; padding: 10px 18px; font-size: 1rem; cursor: pointer; }
  .muted { color: #666; font-size: 0.9rem; }
  #result { margin-top: 12px; padding: 10px; border-radius: 6px; display: none; white-space: pre-wrap; }
  #result.ok { display: block; background: #e7f6e7; border: 1px solid #86c586; }
  #result.err, #claude-result.err { display: block; background: #fdeaea; border: 1px solid #e0a3a3; }
  #claude-result { margin-top: 12px; padding: 10px; border-radius: 6px; display: none; white-space: pre-wrap; }
  #claude-result.ok { display: block; background: #e7f6e7; border: 1px solid #86c586; }
</style>
</head>
<body>
<h1>hermit-shell 認証設定</h1>
<div class="card">
  <div>現在のトークン: <code>${maskedSafe}</code></div>
  <div class="muted">最終適用: ${lastSafe}</div>
</div>
<div class="card">
  <h2>ブラウザで再認証</h2>
  <p>Claudeのログイン・同意・2段階認証は、開いたブラウザでご自身が行います。hermit-shellは認証完了後にClaude CLIが発行したセットアップトークンだけを内部で検証・適用し、画面やログには表示しません。</p>
  <button id="claude-login">Claudeで再認証</button>
  <div id="claude-code-area" style="display:none; margin-top:16px">
    <label for="claude-code">Claude認証コード（セットアップトークンではありません）</label>
    <input id="claude-code" type="password" autocomplete="off" placeholder="Claude公式ページの「コードをコピー」から貼り付け">
    <button id="claude-code-submit">Claudeへ続行</button>
  </div>
  <div id="claude-result"></div>
</div>
<div class="card">
  <h2>トークンを手動入力</h2>
  <label for="token">Claude セットアップトークン（<code>sk-ant-oat01-…</code>）</label>
  <input id="token" type="password" autocomplete="off" placeholder="sk-ant-oat01-...">
  <button id="apply">検証して適用</button>
  <div id="result"></div>
  <p class="muted">入力トークンで Anthropic へ最小の検証呼び出しを行い、成功したときだけ保存・即適用します。失敗時は何も変更しません。</p>
</div>
<script>
  const claudeBtn = document.getElementById('claude-login');
  const claudeCodeArea = document.getElementById('claude-code-area');
  const claudeCodeInput = document.getElementById('claude-code');
  const claudeCodeSubmit = document.getElementById('claude-code-submit');
  const claudeResult = document.getElementById('claude-result');
  let statusTimer = null;
  let claudeAuthWindow = null;

  async function pollClaudeStatus() {
    try {
      const r = await fetch('/setup/claude/status', { cache: 'no-store' });
      const data = await r.json();
      if (data.state === 'waiting_for_user') {
        claudeResult.className = '';
        claudeResult.style.display = 'block';
        claudeResult.textContent = 'ブラウザでClaudeのログインと認可を完了してください。';
        if (data.authUrl) {
          if (claudeAuthWindow) {
            claudeAuthWindow.location.replace(data.authUrl);
            claudeAuthWindow = null;
          }
          claudeCodeArea.style.display = 'block';
        }
      } else if (data.state === 'waiting_for_cli') {
        claudeResult.textContent = 'Claude CLIで認証を完了しています...';
        claudeCodeArea.style.display = 'none';
      } else if (data.state === 'verifying') {
        claudeResult.textContent = '認証結果を検証中...';
      } else if (data.state === 'success') {
        claudeResult.className = 'ok';
        claudeResult.textContent = 'Claudeの再認証を適用しました。';
        claudeBtn.disabled = false;
        claudeCodeSubmit.disabled = false;
        clearInterval(statusTimer);
      } else if (data.state === 'error') {
        if (claudeAuthWindow) claudeAuthWindow.close();
        claudeAuthWindow = null;
        claudeResult.className = 'err';
        claudeResult.textContent = data.message || 'Claudeの再認証に失敗しました。';
        claudeBtn.disabled = false;
        claudeCodeSubmit.disabled = false;
        clearInterval(statusTimer);
      }
    } catch (_) {
      claudeResult.className = 'err';
      claudeResult.textContent = '状態確認に失敗しました。';
      claudeBtn.disabled = false;
      clearInterval(statusTimer);
    }
  }

  claudeBtn.addEventListener('click', async () => {
    claudeAuthWindow = window.open('about:blank', '_blank');
    claudeBtn.disabled = true;
    claudeCodeSubmit.disabled = false;
    claudeResult.className = '';
    claudeResult.style.display = 'block';
    claudeResult.textContent = 'Claude認証を開始しています...';
    try {
      const r = await fetch('/setup/claude/start', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) {
        if (claudeAuthWindow) claudeAuthWindow.close();
        claudeAuthWindow = null;
        claudeResult.className = 'err';
        claudeResult.textContent = data.error || 'Claude認証を開始できませんでした。';
        claudeBtn.disabled = false;
        return;
      }
      claudeCodeArea.style.display = 'none';
      claudeCodeInput.value = '';
      await pollClaudeStatus();
      statusTimer = setInterval(pollClaudeStatus, 1000);
    } catch (_) {
      if (claudeAuthWindow) claudeAuthWindow.close();
      claudeAuthWindow = null;
      claudeResult.className = 'err';
      claudeResult.textContent = '通信エラー';
      claudeBtn.disabled = false;
    }
  });

  claudeCodeSubmit.addEventListener('click', async () => {
    const code = claudeCodeInput.value.trim();
    if (!code) {
      claudeResult.className = 'err';
      claudeResult.textContent = 'Claude認証コードを貼り付けてください。';
      return;
    }
    claudeCodeSubmit.disabled = true;
    try {
      const r = await fetch('/setup/claude/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      claudeCodeInput.value = '';
      const data = await r.json();
      if (!r.ok) {
        claudeResult.className = 'err';
        claudeResult.textContent = data.error || 'Claude認証コードを送信できませんでした。';
        claudeCodeSubmit.disabled = false;
        return;
      }
      claudeCodeArea.style.display = 'none';
      claudeResult.className = '';
      claudeResult.textContent = 'Claude CLIで認証を完了しています...';
    } catch (_) {
      claudeCodeInput.value = '';
      claudeResult.className = 'err';
      claudeResult.textContent = '通信エラー';
      claudeCodeSubmit.disabled = false;
    }
  });

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

export function handleClaudeSetupTokenStart(req: Request, res: Response): void {
  if (!isLoopback(req)) return denyRemote(res);

  const started = claudeSetupTokenFlow.start();
  if (!started.started) {
    res.status(409).json({ error: "Claude認証はすでに進行中です" });
    return;
  }
  const status = publicSetupTokenStatus(claudeSetupTokenFlow.status());
  if (status.state === "error") {
    res.status(503).json(status);
    return;
  }
  res.status(202).json(status);
}

export function handleClaudeSetupTokenStatus(req: Request, res: Response): void {
  if (!isLoopback(req)) return denyRemote(res);
  res
    .status(200)
    .set("Cache-Control", "no-store")
    .json(publicSetupTokenStatus(claudeSetupTokenFlow.status()));
}

export function handleClaudeSetupTokenCode(req: Request, res: Response): void {
  if (!isLoopback(req)) return denyRemote(res);

  const code = (req.body && (req.body as any).code) as unknown;
  if (typeof code !== "string") {
    res.status(400).json({ error: "Claude認証コードを入力してください" });
    return;
  }
  const submitted = claudeSetupTokenFlow.submitAuthorizationCode(code);
  if (!submitted.submitted) {
    const status = submitted.reason === "invalid_code" ? 400 : submitted.reason === "not_waiting" ? 409 : 503;
    res.status(status).json({ error: "Claude認証コードを送信できませんでした" });
    return;
  }
  res.status(202).json({ state: "waiting_for_cli" });
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
