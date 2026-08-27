# hermit-shell 🦀

> ヤドカリは自分の殻を持たない。外の殻を借りて生きる。  
> hermit-shell も同じ — 外の LLM を借りて動く OpenAI 互換プロキシ。

**hermit-shell** は OpenAI 互換の API を提供するプロキシサーバーです。
モデル名でバックエンドを振り分けます:

| モデル名 | バックエンド |
|---|---|
| `claude-*`（その他すべて） | Anthropic Claude API（モデル名はそのまま転送） |
| `gpt-*` | OpenAI Codex — ChatGPT サブスクリプションの `chatgpt.com/backend-api/codex/responses` |
| `bonsai` / `bonsai-8b` | ローカルの Bonsai サーバー（`BONSAI_URL`、既定 `http://localhost:8081`） |

---

## 機能

- **OpenAI 互換 API** — `/v1/chat/completions` で OpenAI クライアントをそのまま接続可能
- **Tool calling 対応** — OpenAI の `tool_calls` ↔ 各バックエンドのツール形式を相互変換
- **ストリーミング対応** — `stream: true` で SSE レスポンスを転送
- **ブラウザからの認証設定** — `/setup`（localhost 限定）で Claude トークンの検証・適用と
  OpenAI Codex の OAuth ログインができる
- **プロンプトキャッシュ既定付与** — Claude 経路はリクエストに `cache_control` が無ければ
  自動キャッシュ指定を付ける

---

## セットアップ

```bash
pnpm install   # npm install でも可
```

## 起動

```bash
# 開発（ts-node）
pnpm run dev

# ビルド後に実行
pnpm run build
pnpm start

# 常駐（nohup・.hermit.pid / .hermit.log を使う）
./start.sh
./stop.sh
```

デフォルトポートは `8765`。`PORT` 環境変数で変更可能。

> ⚠️ サーバーは全インターフェースで listen する。`/setup` 系だけは接続元アドレスで
> localhost 限定にしているが、`/v1/chat/completions` には認証が無いので、
> 信頼できないネットワークに露出させないこと。

## テスト

```bash
pnpm test   # node:test + ts-node。外部 API へは一切アクセスしない
```

---

## 認証

### Claude（Anthropic）

以下の順で解決する（`src/utils/auth.ts` `resolveAuth()`）:

1. `ANTHROPIC_API_KEY` 環境変数 → `x-api-key` ヘッダー
2. `ANTHROPIC_AUTH_TOKEN` 環境変数 → `Bearer` ヘッダー
3. どちらも無ければ認証なし（API 呼び出しは失敗する）

`./start.sh` はリポジトリ直下の `.hermit-auth`（トークン 1 行・chmod 600・git 管理外）を
読んで `ANTHROPIC_AUTH_TOKEN` に入れる。このファイルは `/setup` ページから
「検証して適用」した時に書き込まれる。

### OpenAI Codex（ChatGPT サブスクリプション）

`gpt-*` モデルは ChatGPT アカウントの OAuth（PKCE）でログインする。

1. プロキシと同じホストで `http://127.0.0.1:8765/setup` を開く
   （リモートなら `ssh -L 8765:127.0.0.1:8765 <host>`）
2. 「ログイン URL を発行」→ 表示された URL をブラウザで開いて ChatGPT にログイン
3. リダイレクト先 `http://localhost:1455/auth/callback` は通常「接続できません」になる
   （それで正常）。アドレスバーの URL 全体をページに貼り付けて「完了する」
   - `ssh -L 1455:127.0.0.1:1455` も張っている場合は貼り付け不要で自動完了する
4. トークンはリポジトリ直下の `.hermit-codex-auth.json`（chmod 600・git 管理外）に保存され、
   失効前に自動リフレッシュされる

> ⚠️ `.hermit-codex-auth.json` はこのプロキシ専用。codex CLI や pi の auth.json を
> 流用してはいけない（refresh_token が使用ごとにローテーションされるため、
> 共有すると双方のログインが壊れる）。

環境変数（すべて任意）:

| 変数 | 既定 | 説明 |
|---|---|---|
| `HERMIT_CODEX_AUTH_FILE` | `./.hermit-codex-auth.json` | 認証状態の保存先 |
| `HERMIT_CODEX_BASE_URL` | `https://chatgpt.com/backend-api` | バックエンド URL（テスト用） |
| `HERMIT_CODEX_REASONING_EFFORT` | `low` | `reasoning.effort`。`none` で送らない |
| `HERMIT_CODEX_VERBOSITY` | `medium` | `text.verbosity` |
| `HERMIT_CODEX_FORWARD_TEMPERATURE` | (無効) | `1` で temperature を素通し（既定は除去） |

Codex 経路の変換仕様: `max_tokens` / `stop` / `temperature`（既定）はバックエンドが
受け付けないため送らない。`stop` は非ストリーミング応答の集約後にプロキシ側で切り詰める。
非ストリーミング要求もバックエンドへは常にストリーミングで送り、プロキシが集約する。

---

## エンドポイント

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/health` | GET | ヘルスチェック |
| `/v1/models` | GET | モデル一覧（静的。`gpt-*` は前方一致ルーティングなので未掲載 id も通る） |
| `/v1/chat/completions` | POST | チャット補完（ストリーミング対応） |
| `/setup` | GET | 認証設定ページ（localhost 限定） |
| `/setup/token` | POST | Claude トークンの検証・適用（localhost 限定） |
| `/setup/codex/start` | POST | Codex OAuth 開始（localhost 限定） |
| `/setup/codex/finish` | POST | Codex OAuth 完了・貼り付け経路（localhost 限定） |
| `/setup/codex/status` | GET | Codex 認証状態（localhost 限定） |

---

## 使用例

```bash
# Claude
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# OpenAI Codex（要 /setup でのログイン）
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

モデル名は変換されず、そのまま各バックエンドに渡る。

---

## opencrab との連携

[opencrab](https://github.com/kojira/opencrab) などの OpenAI 互換クライアントから hermit-shell に向けることで、Claude / Codex を OpenAI API として利用できる。

`config/default.toml` の例:

```toml
[api]
base_url = "http://localhost:8765/v1"
api_key = "dummy"  # /v1 側にはクライアント認証が無いので何でも可

[model]
default = "claude-sonnet-4-5"
```

---

## 開発メモ

- `src/utils/auth.ts` — Claude 認証解決・`/setup` 用のトークン検証と適用
- `src/utils/codex_auth.ts` — Codex OAuth（PKCE・リフレッシュ・状態保存）
- `src/utils/codex_convert.ts` — OpenAI ⇄ Codex Responses API の変換
- `src/handlers/` — リクエストハンドラ（`chat.ts` がモデル名でバックエンドに振り分ける）
- `test/` — `pnpm test`（偽バックエンドのみ。外部 API・実トークン不要）
