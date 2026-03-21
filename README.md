# hermit-shell 🦀

> ヤドカリは自分の殻を持たない。外の殻を借りて生きる。  
> hermit-shell も同じ — 外の LLM（Anthropic）を借りて動く OpenAI 互換プロキシ。

**hermit-shell** は Anthropic Claude API への OpenAI 互換プロキシサーバーです。  
`ANTHROPIC_API_KEY` がなくても、macOS キーチェーンに保存された Claude Code の OAuth トークンを使って動作します。

---

## 機能

- **OpenAI 互換 API** — `/v1/chat/completions` で OpenAI クライアントをそのまま接続可能
- **macOS キーチェーン認証** — Claude Code がキーチェーンに保存した OAuth トークン（`Claude Code-credentials`）を自動取得
- **モデル名はそのまま Anthropic へ渡す** — モデル変換なし。`claude-sonnet-4-5` と指定したらそのまま Anthropic に送信される
- **Tool calling 対応** — OpenAI の `tool_calls` ↔ Anthropic の `tool_use` を相互変換
- **ストリーミング対応** — `stream: true` で SSE レスポンスを転送

---

## セットアップ

```bash
pnpm install
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
pnpm run dev

# ビルド後に実行
pnpm run build
pnpm start
```

デフォルトポートは `8765`。`PORT` 環境変数で変更可能。

---

## エンドポイント

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/health` | GET | ヘルスチェック |
| `/v1/chat/completions` | POST | チャット補完（ストリーミング対応） |

> ⚠️ `/v1/models` は実装されていますが、モデル一覧は静的です。

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
- モデル変換（MODEL_MAP）は削除済み。モデル名はそのまま Anthropic API に転送される
