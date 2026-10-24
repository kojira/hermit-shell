# hermit-shell 🦀

> ヤドカリは自分の殻を持たない。外の殻を借りて生きる。  
> hermit-shell も同じ — 外の LLM（Anthropic）を借りて動く OpenAI 互換プロキシ。

**hermit-shell** は Anthropic Claude API への OpenAI 互換プロキシサーバーです。  
`ANTHROPIC_API_KEY` がなくても、macOS キーチェーンに保存された Claude Code の OAuth トークンを使って動作します。

> ⚠️ **現在 macOS 専用** — OAuth トークンの取得に macOS キーチェーン（`security` コマンド）を使用しています。Linux/Windows では `ANTHROPIC_API_KEY` 環境変数による API キー認証のみ利用可能です。

---

## 機能

- **OpenAI 互換 API** — `/v1/chat/completions` で OpenAI クライアントをそのまま接続可能
- **macOS キーチェーン認証** — Claude Code がキーチェーンに保存した OAuth トークン（`Claude Code-credentials`）を自動取得
- **モデル名はそのまま Anthropic へ渡す** — モデル変換なし。`claude-sonnet-4-5` と指定したらそのまま Anthropic に送信される
- **Tool calling 対応** — OpenAI の `tool_calls` ↔ Anthropic の `tool_use` を相互変換
- **ストリーミング対応** — `stream: true` で SSE レスポンスを転送

---

## セットアップ

[mise](https://mise.jdx.dev/) をインストールしてから、固定 Node **22.23.4** を使います。
既存の pnpm と lockfile は変更しません。

```bash
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile --ignore-scripts
mise exec -- node --test scripts/node.integration.mjs
```

### 認証の優先順位

以下の順で認証情報を解決します:

1. `ANTHROPIC_API_KEY` 環境変数 → `x-api-key` ヘッダー
2. `ANTHROPIC_AUTH_TOKEN` 環境変数 → `Bearer` ヘッダー
3. OpenClaw の `auth-profiles.json` — OAT トークン（`sk-ant-oat01-*`）は Bearer、API キーは `x-api-key`
4. macOS キーチェーン — Claude Code が保存した OAuth トークン（`Claude Code-credentials`）

Claude Code をインストール済みであれば、追加設定なしで動作します。

---

## 起動

```bash
# 開発（ts-node）
mise exec -- pnpm run dev

# ビルド後に実行
mise exec -- pnpm run build
mise exec -- pnpm start
```

バックグラウンド起動は `./start.sh`。認証・HOST/PORT・ログ/PID の扱いは従来のままです。
`start.sh` と `pnpm start` は `scripts/node.sh` でリポジトリの Node を選択し、子プロセスの
PATH にも適用します。`mise` はサービスの明示 PATH に必要です。先に `mise install` を行い、
未導入時は環境内の別 Node にフォールバックしません。

pin の変更だけでは既存プロセスは更新されません。稼働環境の切替は別途承認された停止可能な
時間帯に実施し、設定・認証・待受 HOST/PORT と検証済み JS を保持してください。
この変更のためにアプリケーションの版まで同時更新する必要はありません。
起動設定・旧 Node・旧成果物を退避し、処理を drain した後に切替え、実際にロードされた
実行ファイルと `/health` を確認します。rollback は退避した設定・成果物へ戻しますが、
脆弱な旧 Node への復帰は一時復旧でありセキュリティ更新の完了ではありません。

デフォルトポートは `8765`。`PORT` 環境変数で変更可能。

---

## エンドポイント

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/health` | GET | ヘルスチェック |
| `/v1/chat/completions` | POST | チャット補完（ストリーミング対応） |
| `/setup` | GET | 認証設定ページ（下記のアクセス制限あり） |

> ⚠️ `/v1/models` は実装されていますが、モデル一覧は静的です。

### 認証設定ページ（`/setup`）へのアクセス

`/setup` と配下の `/setup/*` は、ソケットの実接続元アドレスで制限します
（`X-Forwarded-For` / `req.ip` は詐称できるため使いません）。

- loopback（`127.0.0.1` / `::1`）は常に許可 — ローカル復旧経路を壊さないため。
- それ以外は `HERMIT_SETUP_ALLOW_CIDR` に入っている場合だけ許可。既定値は
  `100.64.0.0/10`（Tailscale の CGNAT 範囲）。IPv4 CIDR のみ解釈し、
  解釈できない値や範囲外は 403（`{"error":"forbidden"}`）で拒否します。

```bash
# tailnet からそのまま開ける（コードやトークンは不要）
open http://100.120.122.33:8765/setup

# 許可範囲を変える（IPv4 CIDR）
HERMIT_SETUP_ALLOW_CIDR=192.168.0.0/16 ./start.sh
```

トレードオフ: 許可 CIDR 内のピアは誰でも設定ページに到達できます。ページが出すのは
**マスク済み**のトークンだけで、トークンの置き換えには Claude の認可完了
（または Anthropic での検証成功）が必要です。Tailscale の端末には SSH 鍵も置かれて
いるため、tailnet 内の侵害はホスト侵害と同等であり、この公開範囲は既存の tailnet の
信頼境界を広げません。CIDR を tailnet より広げる場合はその前提が崩れる点に注意してください。

---

## 使用例

```bash
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20251001",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

モデル名は Anthropic のモデル名をそのまま指定してください。変換は行いません。

---

## opencrab との連携

[opencrab](https://github.com/kojira/opencrab) などの OpenAI 互換クライアントから hermit-shell に向けることで、Claude を OpenAI API として利用できます。

`config/default.toml` の例:

```toml
[api]
base_url = "http://localhost:8765/v1"
api_key = "dummy"  # hermit-shell は認証をキーチェーンから取得するので何でも可

[model]
default = "claude-sonnet-4-5-20251001"
```

---

## 開発メモ

- `src/utils/auth.ts` — 認証解決ロジック
- `src/handlers/` — リクエストハンドラ
- モデル名はそのまま Anthropic API に転送される
