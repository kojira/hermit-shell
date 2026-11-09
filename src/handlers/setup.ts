import { Request, Response } from "express";
import * as fs from "fs";
import { AccountError, getAccountStore, TokenTarget } from "../utils/accounts";
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

let poolClaudeAttempt = false;

/** tailnet (CGNAT) を既定の許可範囲にする。 */
export const DEFAULT_SETUP_ALLOW_CIDR = "100.64.0.0/10";

/**
 * 設定ページへの接続を許可する CIDR。HERMIT_SETUP_ALLOW_CIDR で上書きできる。
 * IPv4 の CIDR のみを解釈し、それ以外（IPv6 など）は拒否側に倒す。
 */
export function setupAllowCidr(): string {
  const raw = process.env.HERMIT_SETUP_ALLOW_CIDR;
  return raw && raw.trim() ? raw.trim() : DEFAULT_SETUP_ALLOW_CIDR;
}

function isLoopbackAddr(addr: string): boolean {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

/** "a.b.c.d" を 32bit 整数へ。IPv4 でなければ null。 */
function ipv4ToInt(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d) は IPv4 として扱う。 */
function normalizePeerAddress(addr: string): string {
  const prefix = "::ffff:";
  return addr.startsWith(prefix) ? addr.slice(prefix.length) : addr;
}

export function isAddressInCidr(addr: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  if (prefixRaw === undefined) return false;
  if (!/^\d{1,2}$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  if (prefix > 32) return false;
  const ip = ipv4ToInt(normalizePeerAddress(addr));
  const base = ipv4ToInt(network);
  if (ip === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

/**
 * リクエスト元が設定ページを開けるかを、ソケットの実接続元アドレスだけで判定する。
 * X-Forwarded-For / req.ip は詐称できるので信用しない。
 *
 * loopback は常に許可（ローカル復旧経路を壊さない）。非 loopback は
 * HERMIT_SETUP_ALLOW_CIDR（既定 100.64.0.0/10 = tailnet）内だけ許可する。
 * この範囲は tailnet の信頼境界そのもので、SSH 鍵も同じ端末群にあるため、
 * 範囲内のピアはホスト侵害と同等とみなす（README の tradeoff を参照）。
 */
export function isSetupRequestAllowed(req: Request): boolean {
  const addr = req.socket.remoteAddress || "";
  if (isLoopbackAddr(addr)) return true;
  return isAddressInCidr(addr, setupAllowCidr());
}

function denyRemote(res: Response): void {
  // CIDR 外かどうか・コードの正誤などは明かさない。
  res.status(403).json({ error: "forbidden" });
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
  #claude-manual-hint { margin-top: 16px; padding: 12px; border: 1px solid #e0c98a; background: #fdf7e3; border-radius: 6px; display: none; }
  #claude-manual-hint ol { margin: 8px 0 0; padding-left: 20px; }
  #claude-manual-hint li { margin: 4px 0; }
</style>
</head>
<body>
<h1>hermit-shell 認証設定</h1>
<div class="card">
  <div>現在のトークン: <code>${maskedSafe}</code></div>
  <div class="muted">最終適用: ${lastSafe}</div>
</div>
<div class="card">
  <h2>契約一覧と自動切替</h2>
  <p id="account-status">構成を読み込み中...</p>
  <ol id="accounts"></ol>
  <button id="import-account">現在の契約を一覧に追加</button>
  <button id="enable-pool">一覧の順に自動で切り替える</button>
  <button id="disable-pool">自動切替をやめて従来の契約を使う</button>
  <p id="account-result" role="status"></p>
  <label for="account-target">追加・更新先（下のブラウザ認証／手動入力で共通）</label>
  <select id="account-target"><option value="legacy">従来の契約の認証情報を更新</option><option value="add">新しい契約を追加</option></select>
  <input id="account-name" type="text" placeholder="追加する契約の名前">
  <p class="muted">検証要求は利用枠を消費する場合があります。検証成功時だけ保存します。元の単一認証は取り込み後も保持します。保存は新規要求から反映し、進行中の応答は続行します。</p>
</div>
<div class="card">
  <h2>ブラウザで再認証</h2>
  <p>Claudeのログイン・同意・2段階認証は、開いたブラウザでご自身が行います。hermit-shellは認証完了後にClaude CLIが発行したセットアップトークンだけを内部で検証・適用し、画面やログには表示しません。</p>
  <button id="claude-login">Claudeで再認証</button>
  <button id="claude-cancel" style="display:none">認証を中止してやり直す</button>
  <div id="claude-code-area" style="display:none; margin-top:16px">
    <p><a id="claude-auth-link" target="_blank" rel="noopener" style="display:none">Claude公式認証ページを開く</a></p>
    <label for="claude-code">Claude認証コード（セットアップトークンではありません）</label>
    <input id="claude-code" type="password" autocomplete="off" placeholder="Claude公式ページの「コードをコピー」から貼り付け">
    <button id="claude-code-submit">Claudeへ続行</button>
  </div>
  <div id="claude-manual-hint">
    <strong>この画面からブラウザ認証を続けられませんでした。</strong>
    <p class="muted">Claude CLI 2.1系はブラウザ用のURLを表示しないため、ホストのターミナルで直接トークンを発行してください。</p>
    <ol>
      <li>ホスト（この hermit-shell が動いているマシン）のターミナルで <code>claude setup-token</code> を実行する</li>
      <li>開いたブラウザで Claude にログインし、認可を完了する</li>
      <li>ターミナルに表示される <code>sk-ant-oat01-…</code> トークンをコピーする</li>
      <li>下の「トークンを手動入力」欄に貼り付け、「検証して適用」を押す</li>
    </ol>
    <p class="muted" id="claude-manual-hint-detail"></p>
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
  let accountView = null;
  let attemptId;
  const targetSelect = document.getElementById('account-target');
  const accountResult = document.getElementById('account-result');
  const accountErrors = {
    configuration_changed: '構成が変更されました。一覧を確認して再試行してください。',
    account_changed: '対象の契約が更新・削除されました。一覧を確認してください。',
    duplicate_token: 'このトークンは既に別の契約へ登録済みです。',
    api_key_has_priority: 'APIキーが優先されています。契約の自動切替は有効にできません。',
    credential_save_failed: '保存できませんでした。保存先の権限・空き容量を確認してください。',
    credential_config_error: '契約ファイルが破損しています。ファイルを退避し、再起動して復旧してください。',
    legacy_bearer_unavailable: '取り込み可能な単一Bearerがありません。',
    account_name_required: '追加する契約の名前を入力してください。',
    account_target_required: '追加・更新する契約を選択してください。'
  };
  function explain(error) { return accountErrors[error] || error; }
  function tokenTarget() {
    if (!accountView) throw new Error('構成の読み込みを待ってください。');
    const id = targetSelect.value;
    if (id === 'legacy') return {};
    if (id === 'add') {
      const name = document.getElementById('account-name').value.trim();
      if (!name) throw new Error('追加する契約の名前を入力してください。');
      return { name, expectedRevision: accountView.revision };
    }
    const account = accountView.accounts.find(a => a.id === id);
    if (!account) throw new Error('更新対象を選び直してください。');
    return { id, generation: account.generation, expectedRevision: accountView.revision };
  }
  async function refreshAccounts() {
    const r = await fetch('/setup/accounts', { cache: 'no-store' });
    const data = await r.json();
    if (!r.ok) throw new Error(explain(data.error));
    accountView = data;
    const usage = {
      'env-auth-token': '現在は従来の契約を使用しています。契約の自動切替は無効です。',
      pool: '契約の自動切替が有効です。一覧の上から順に、利用できる契約を使います。',
      'env-api-key': '現在はAPIキーを使用しています。一覧の契約への自動切替は行いません。',
      none: '認証情報が設定されていません。契約の自動切替は無効です。',
      credential_config_error: '契約ファイルの設定エラーにより、契約を使用できません。'
    };
    document.getElementById('account-status').textContent = usage[data.effectiveSource] + (data.observationSaveFailed ? ' — 状態の保存に失敗。再起動すると未保存の冷却状態が失われる場合があります。' : '');
    document.getElementById('enable-pool').disabled = data.effectiveSource === 'env-api-key' || data.configError;
    const selected = targetSelect.value;
    targetSelect.replaceChildren();
    function option(value, text) { const o = document.createElement('option'); o.value = value; o.textContent = text; targetSelect.append(o); }
    if (data.mode !== 'pool') option('legacy', '従来の契約の認証情報を更新');
    option('add', '新しい契約を追加');
    const list = document.getElementById('accounts'); list.replaceChildren();
    const states = { unknown: '追加・更新後の接続成功は未確認（接続失敗を示すものではありません）', available: '利用可能', exhausted: '枠切れ', reauth: '再認証待ち', recovering: '回復確認中' };
    data.accounts.forEach((a, index) => {
      option(a.id, a.name + 'の認証情報を更新');
      const item = document.createElement('li');
      item.textContent = a.name + ' — 一覧に追加済み / ' + states[a.observed.state] + (a.observed.retryAt ? ' / ' + (a.observed.retryBasis === 'provider' ? '次回利用可能時刻: ' : '次回確認可能時刻: ') + new Date(a.observed.retryAt).toLocaleString() : '');
      function button(text, action, disabled = false) { const b = document.createElement('button'); b.textContent = text; b.disabled = disabled; b.onclick = action; item.append(b); }
      button('認証情報を更新', () => { targetSelect.value = a.id; document.getElementById('token').focus(); });
      button('名前変更', () => { const name = prompt('契約の名前', a.name); if (name) mutateAccounts({ action: 'rename', id: a.id, name }); });
      for (const [label, delta] of [['↑', -1], ['↓', 1]]) button(label, () => { const ids = data.accounts.map(a => a.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]; mutateAccounts({ action: 'reorder', ids }); }, index + delta < 0 || index + delta >= data.accounts.length);
      button('削除', () => { if (confirm(a.name + 'をこの一覧から削除します。提供元での失効ではありません。最後の1件を削除しても単一認証には戻りません。')) mutateAccounts({ action: 'delete', id: a.id }); });
      list.append(item);
    });
    if ([...targetSelect.options].some(o => o.value === selected)) targetSelect.value = selected;
  }
  async function mutateAccounts(operation) {
    try {
      const r = await fetch('/setup/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...operation, expectedRevision: accountView.revision }) });
      const data = await r.json();
      if (!r.ok) throw new Error(explain(data.error));
      accountResult.textContent = '保存しました。次の要求から反映されます。';
    } catch (error) { accountResult.textContent = error.message; }
    await refreshAccounts().catch(error => { accountResult.textContent = error.message; });
  }
  document.getElementById('import-account').onclick = () => { const name = prompt('取り込む契約の名前', '元の契約'); if (name) mutateAccounts({ action: 'import', name }); };
  document.getElementById('enable-pool').onclick = () => mutateAccounts({ action: 'mode', mode: 'pool' });
  document.getElementById('disable-pool').onclick = () => mutateAccounts({ action: 'mode', mode: 'legacy' });
  refreshAccounts().catch(error => { accountResult.textContent = error.message; });
  const claudeBtn = document.getElementById('claude-login');
  const claudeCancelBtn = document.getElementById('claude-cancel');
  const claudeCodeArea = document.getElementById('claude-code-area');
  const claudeAuthLink = document.getElementById('claude-auth-link');
  const claudeCodeInput = document.getElementById('claude-code');
  const claudeCodeSubmit = document.getElementById('claude-code-submit');
  const claudeManualHint = document.getElementById('claude-manual-hint');
  const claudeManualHintDetail = document.getElementById('claude-manual-hint-detail');
  const claudeResult = document.getElementById('claude-result');
  let statusTimer = null;
  let claudeAuthWindow = null;

  // The auth link points at a URL only the CLI can produce; never leave a
  // clickable link with no href behind.
  function hideAuthLink() {
    claudeAuthLink.removeAttribute('href');
    claudeAuthLink.style.display = 'none';
  }

  function showManualHint(detail) {
    claudeManualHintDetail.textContent = detail || '';
    claudeManualHint.style.display = 'block';
    hideAuthLink();
    claudeCodeArea.style.display = 'none';
  }

  function hideManualHint() {
    claudeManualHint.style.display = 'none';
    claudeManualHintDetail.textContent = '';
  }

  async function pollClaudeStatus() {
    try {
      const r = await fetch('/setup/claude/status', { cache: 'no-store' });
      const data = await r.json();
      attemptId = data.attemptId;
      if (data.state === 'waiting_for_user') {
        claudeBtn.disabled = true;
        claudeCancelBtn.style.display = 'inline-block';
        claudeResult.className = '';
        claudeResult.style.display = 'block';
        claudeResult.textContent = 'ブラウザでClaudeのログインと認可を完了してください。';
        if (data.authUrl) {
          if (claudeAuthWindow) {
            claudeAuthWindow.location.replace(data.authUrl);
            claudeAuthWindow = null;
          }
          hideManualHint();
          claudeAuthLink.href = data.authUrl;
          claudeAuthLink.style.display = 'inline-block';
          claudeCodeSubmit.disabled = false;
          claudeCodeArea.style.display = 'block';
        }
      } else if (data.state === 'waiting_for_cli') {
        claudeBtn.disabled = true;
        claudeCancelBtn.style.display = 'inline-block';
        claudeResult.style.display = 'block';
        claudeResult.textContent = 'Claude CLIで認証を完了しています...';
        hideAuthLink();
        claudeCodeArea.style.display = 'none';
      } else if (data.state === 'manual_token_required') {
        // Claude CLI no longer prints the OAuth URL, so the page cannot host the
        // browser login. Hand over to the manual token field instead of waiting.
        if (claudeAuthWindow) claudeAuthWindow.close();
        claudeAuthWindow = null;
        claudeResult.className = '';
        claudeResult.textContent = 'この画面からはブラウザ認証を続けられません。手動トークン入力へ切り替えてください。';
        claudeResult.style.display = 'block';
        showManualHint(data.message);
        claudeBtn.disabled = false;
        claudeCancelBtn.style.display = 'none';
        claudeCodeSubmit.disabled = false;
        clearInterval(statusTimer);
      } else if (data.state === 'verifying') {
        claudeBtn.disabled = true;
        claudeCancelBtn.style.display = 'inline-block';
        claudeResult.style.display = 'block';
        claudeResult.textContent = '認証結果を検証中...';
      } else if (data.state === 'success') {
        hideManualHint();
        claudeResult.className = 'ok';
        claudeResult.textContent = '検証・保存が完了しました。次の要求から反映されます。';
        await refreshAccounts();
        claudeBtn.disabled = false;
        claudeCancelBtn.style.display = 'none';
        claudeCodeSubmit.disabled = false;
        clearInterval(statusTimer);
      } else if (data.state === 'error') {
        if (claudeAuthWindow) claudeAuthWindow.close();
        claudeAuthWindow = null;
        hideAuthLink();
        claudeResult.className = 'err';
        claudeResult.textContent = data.message || 'Claudeの再認証に失敗しました。';
        claudeBtn.disabled = false;
        claudeCancelBtn.style.display = 'none';
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
    hideAuthLink();
    hideManualHint();
    claudeResult.className = '';
    claudeResult.style.display = 'block';
    claudeResult.textContent = 'Claude認証を開始しています...';
    try {
      const r = await fetch('/setup/claude/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tokenTarget()) });
      const data = await r.json();
      if (!r.ok) {
        if (claudeAuthWindow) claudeAuthWindow.close();
        claudeAuthWindow = null;
        claudeResult.className = 'err';
        claudeResult.textContent = explain(data.error) || 'Claude認証を開始できませんでした。';
        claudeBtn.disabled = false;
        return;
      }
      claudeCodeArea.style.display = 'none';
      claudeCodeInput.value = '';
      await pollClaudeStatus();
      statusTimer = setInterval(pollClaudeStatus, 1000);
    } catch (error) {
      if (claudeAuthWindow) claudeAuthWindow.close();
      claudeAuthWindow = null;
      claudeResult.className = 'err';
      claudeResult.textContent = error.message || '通信エラー';
      claudeBtn.disabled = false;
    }
  });

  claudeCancelBtn.addEventListener('click', async () => {
    claudeCancelBtn.disabled = true;
    try {
      const r = await fetch('/setup/claude/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attemptId }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'cancel failed');
      if (claudeAuthWindow) claudeAuthWindow.close();
      claudeAuthWindow = null;
      claudeCodeInput.value = '';
      claudeCodeArea.style.display = 'none';
      hideAuthLink();
      hideManualHint();
      claudeResult.style.display = 'none';
      claudeResult.className = '';
      claudeBtn.disabled = false;
      claudeCancelBtn.style.display = 'none';
      clearInterval(statusTimer);
    } catch (_) {
      claudeResult.className = 'err';
      claudeResult.style.display = 'block';
      claudeResult.textContent = '認証の中止に失敗しました。';
    } finally {
      claudeCancelBtn.disabled = false;
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
        body: JSON.stringify({ code, attemptId }),
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

  pollClaudeStatus();
  statusTimer = setInterval(pollClaudeStatus, 1000);

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
        body: JSON.stringify({ token, ...tokenTarget() }),
      });
      const data = await r.json();
      if (r.ok) {
        result.className = 'ok';
        result.textContent = '検証・保存が完了しました。次の要求から反映されます。';
        document.getElementById('token').value = '';
        await refreshAccounts();
      } else {
        result.className = 'err';
        result.textContent = 'エラー: ' + (explain(data.error) || r.status);
        await refreshAccounts();
      }
    } catch (e) {
      result.className = 'err';
      result.textContent = e.message || '通信エラー';
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

export function handleSetupPage(req: Request, res: Response): void {
  if (!isSetupRequestAllowed(req)) return denyRemote(res);
  res.status(200).type("html").send(renderPage());
}

export function handleClaudeSetupTokenStart(req: Request, res: Response): void {
  if (!isSetupRequestAllowed(req)) return denyRemote(res);

  let target: TokenTarget | undefined;
  try { target = tokenTarget(req.body); } catch (error) { return setupError(res, error); }
  const store = getAccountStore();
  const revision = store.view().revision;
  const started = claudeSetupTokenFlow.start(target ? token => store.saveToken(target!, token) : token => {
    if (store.view().revision !== revision || store.isPool()) throw new AccountError(409, "configuration_changed");
    applyAuthToken(token);
  });
  if (!started.started) {
    res.status(409).json({ error: "Claude認証はすでに進行中です" });
    return;
  }
  poolClaudeAttempt = Boolean(target);
  const status = publicSetupTokenStatus({ ...claudeSetupTokenFlow.status(), attemptId: claudeSetupTokenFlow.getAttemptId() });
  if (status.state === "error") {
    res.status(503).json(status);
    return;
  }
  res.status(202).json(status);
}

export function handleClaudeSetupTokenStatus(req: Request, res: Response): void {
  if (!isSetupRequestAllowed(req)) return denyRemote(res);
  res
    .status(200)
    .set("Cache-Control", "no-store")
    .json(publicSetupTokenStatus({ ...claudeSetupTokenFlow.status(), attemptId: claudeSetupTokenFlow.getAttemptId() }));
}

export function handleClaudeSetupTokenCancel(req: Request, res: Response): void {
  if (!isSetupRequestAllowed(req)) return denyRemote(res);
  if (!matchesAttempt(req, res)) return;
  const result = claudeSetupTokenFlow.cancel();
  res.status(200).json({ state: "idle", ...result });
}

export function handleClaudeSetupTokenCode(req: Request, res: Response): void {
  if (!isSetupRequestAllowed(req)) return denyRemote(res);

  if (!matchesAttempt(req, res)) return;
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
  if (!isSetupRequestAllowed(req)) return denyRemote(res);

  const token = (req.body && (req.body as any).token) as unknown;
  if (typeof token !== "string" || !looksLikeToken(token)) {
    // fail loud: 形式で明らかにおかしいものは検証呼び出しに進めず 400（トークンは返さない）。
    res.status(400).json({ error: "invalid token format (expected sk-ant-…)" });
    return;
  }

  let target: TokenTarget | undefined;
  try { target = tokenTarget(req.body); } catch (error) { return setupError(res, error); }
  const store = getAccountStore();
  const revision = store.view().revision;
  const verified = await verifyAuthToken(token);
  if (!verified.ok) {
    // 検証失敗: ファイルも env も共有クライアントも一切触らない（既存経路は無傷のまま）。
    const status =
      verified.status === 429 ? 429 : verified.status === 401 || verified.status === 400 ? verified.status : 503;
    res.status(status).json({
      error: verified.status === 429 ? "現在検証できません（429）。後で再試行してください。" : `token verification failed (${verified.status ?? "no response"})`,
    });
    return;
  }

  // 検証成功時のみ: 永続化 → env 反映 → 共有クライアント破棄、の順で原子的に切り替える。
  try {
    if (target) store.saveToken(target, token);
    else {
      if (store.view().revision !== revision || store.isPool()) throw new AccountError(409, "configuration_changed");
      applyAuthToken(token);
      resetClient();
    }
  } catch (error) { return setupError(res, error); }

  const { masked, lastApplied } = currentStatus();
  res.status(200).json(target ? { ok: true, ...store.view() } : { ok: true, masked, lastApplied });
}


function setupError(res: Response, error: unknown): void {
  res.status(error instanceof AccountError ? error.status : 503).json({ error: error instanceof AccountError ? error.code : "credential_save_failed" });
}
function tokenTarget(body: any): TokenTarget | undefined {
  const store = getAccountStore();
  store.assertValid();
  if (body?.id !== undefined || body?.name !== undefined) {
    const target = { id: body.id, name: body.name, generation: body.generation, expectedRevision: body.expectedRevision };
    store.checkTarget(target); return target;
  }
  if (store.view().mode === "pool") throw new AccountError(400, "account_target_required");
  return undefined;
}
function matchesAttempt(req: Request, res: Response): boolean {
  if ((poolClaudeAttempt || req.body?.attemptId !== undefined) && req.body?.attemptId !== claudeSetupTokenFlow.getAttemptId()) {
    res.status(409).json({ error: "authentication_attempt_changed" }); return false;
  }
  return true;
}
export function handleSetupAccounts(req: Request, res: Response): void {
  if (!isSetupRequestAllowed(req)) return denyRemote(res);
  try {
    const store = getAccountStore();
    if (req.method === "POST") store.mutate(req.body);
    res.set("Cache-Control", "no-store").json(store.view());
  } catch (error) { setupError(res, error); }
}
