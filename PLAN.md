# hermit-shell RLM機能 実装計画

## 概要

hermit-shell に **RLM（Recursive Language Models）** モードを追加する。

モデル名に `rlm-` prefix を付けると（例: `rlm-claude-sonnet-4-6`）、自動的に RLM モードで処理される。
RLM モードでは、ユーザープロンプトを直接 LLM コンテキストウィンドウに流し込む代わりに、
Node.js `vm` モジュールの REPL 環境に変数として格納し、LLM が自分自身を再帰的に呼び出す
コードを書きながら処理を進める。

### 論文との対応

- 論文: **Recursive Language Models** (Zhang et al., arXiv:2512.24601v2, ICML 2026)
- 実装参考: https://github.com/alexzhang13/rlm

#### RLMの本質的な設計原則（論文 §2 より）

1. **プロンプトを環境変数として扱う**  
   ユーザープロンプト `P` をコンテキストウィンドウに入れず、REPL 環境 `ℰ` の変数に格納する。
   LLM にはメタデータ（文字列長、先頭プレビュー）だけを渡す。

2. **出力を環境変数に蓄積する**  
   中間結果も REPL の変数として保持し、`Final` 変数がセットされたら終了する。
   LLM のコンテキストには stdout のメタデータ（短いプレフィックス＋長さ）だけを追加する。
   これにより O(1) ターンあたりのコンテキスト増加に抑え、K/c ターン以内に収束させる。

3. **象徴的再帰（Symbolic Recursion）**  
   REPL 内のコードから `sub_RLM(prompt)` を呼び出せる。
   これにより任意の長さのループで Ω(|P|) 〜 Ω(|P|²) の意味論的作業が可能になる。

#### Algorithm 1 の完全な対応

```
Input: prompt P
Output: response Y

state ← InitREPL(prompt=P)            # vm.Contextにpromptを変数として注入
state ← AddFunction(state, sub_RLM_M) # sub_RLM関数をコンテキストに追加
hist  ← [Metadata(state)]              # 長さ・プレフィックスのみ

while True do:
  code           ← LLM_M(hist)        # Anthropic APIにhistを渡してコード生成
  (state, stdout) ← REPL(state, code) # vm.runInContextで実行
  hist           ← hist || code || Metadata(stdout)  # stdoutはメタデータのみ追加
  if state["Final"] is set:
    return state["Final"]             # Final変数がセットされたら返す
```

---

## アーキテクチャ設計

### 1. モデル名検出（`rlm-` prefix → RLMモード）

`src/handlers/chat.ts` の `handleChatCompletions` の冒頭で判定する。

```typescript
// 例: "rlm-claude-sonnet-4-6" → { isRlm: true, baseModel: "claude-sonnet-4-6" }
function parseRlmModel(model: string): { isRlm: boolean; baseModel: string } {
  if (model.startsWith("rlm-")) {
    return { isRlm: true, baseModel: model.slice(4) };
  }
  return { isRlm: false, baseModel: model };
}
```

検出後は RLM 専用ハンドラー（`handleRlmRequest`）に分岐し、通常パスには手を加えない。

`sub_RLM` の「子モデル」は同じ `baseModel` を使用する（将来的に `rlm-root-X+sub-Y` 形式に拡張可能）。

### 2. REPL環境（Node.js `vm` モジュール）の設計

#### コンテキスト構造

```typescript
interface ReplState {
  prompt: string;          // 元のユーザープロンプト（全体、変数としてREPLに格納）
  Final?: string;          // セットされたら終了
  [key: string]: unknown;  // LLMが自由に変数を定義できる領域
}
```

#### `vm.Context` の初期化

```typescript
import vm from "node:vm";

function initREPL(prompt: string, subRlmFn: SubRlmFn): vm.Context {
  const sandbox: ReplState = {
    prompt,
    sub_RLM: subRlmFn,   // 再帰呼び出し関数
    console: safeConsole, // stdout をキャプチャするためラップ
    // JSON, Array等の安全なグローバルは許可
    JSON,
    Array,
    Object,
    String,
    Number,
    Math,
  };
  return vm.createContext(sandbox);
}
```

#### コード実行とstdoutキャプチャ

```typescript
interface ExecResult {
  stdout: string;
  error?: string;
}

function execInREPL(ctx: vm.Context, code: string): ExecResult {
  const lines: string[] = [];
  // console.log を横取り
  (ctx as any).console = {
    log: (...args: unknown[]) => lines.push(args.join(" ")),
    error: (...args: unknown[]) => lines.push("[err] " + args.join(" ")),
  };
  try {
    vm.runInContext(code, ctx, { timeout: 30_000 });
  } catch (e: any) {
    return { stdout: lines.join("\n"), error: e.message };
  }
  return { stdout: lines.join("\n") };
}
```

#### Metadata関数（Algorithm 1 の `Metadata(state)` に対応）

コンテキストウィンドウへの追加を O(1) に抑えるため、
stdout の全文ではなく「長さ＋先頭 200 文字のプレビュー」だけを返す。

```typescript
function metadataOf(text: string): string {
  const preview = text.slice(0, 200);
  return `[stdout: ${text.length} chars] ${preview}${text.length > 200 ? "..." : ""}`;
}
```

### 3. RLMループの実装方針（Algorithm 1 の対応）

```typescript
async function runRlmLoop(params: {
  prompt: string;
  baseModel: string;
  maxIterations: number;
  onProgress?: (event: RlmProgressEvent) => void;
}): Promise<string> {
  const { prompt, baseModel, maxIterations, onProgress } = params;

  // sub_RLM: 再帰呼び出し（同じRLMループを深さ+1で起動）
  const subRlm = makeSubRlm(baseModel, maxIterations, onProgress);

  const ctx = initREPL(prompt, subRlm);
  const hist: HistoryMessage[] = [
    { role: "system", content: RLM_SYSTEM_PROMPT },
    { role: "user",   content: metadataOf(prompt) },  // プロンプトのメタデータのみ
  ];

  for (let iter = 0; iter < maxIterations; iter++) {
    // LLMにコード生成を依頼
    const code = await callLlm(baseModel, hist);
    onProgress?.({ type: "code", iteration: iter, code });

    hist.push({ role: "assistant", content: code });

    // REPLで実行
    const { stdout, error } = execInREPL(ctx, code);
    onProgress?.({ type: "exec", iteration: iter, stdout, error });

    // stdoutのメタデータだけをhistに追加（Algorithm 1 の重要な制約）
    const stdoutMeta = error
      ? `[error: ${error}] ${metadataOf(stdout)}`
      : metadataOf(stdout);
    hist.push({ role: "user", content: stdoutMeta });

    // Final変数がセットされたら終了
    if ((ctx as any).Final !== undefined) {
      return String((ctx as any).Final);
    }
  }

  throw new Error(`RLM: max iterations (${maxIterations}) exceeded`);
}
```

### 4. `sub_RLM` の再帰呼び出し設計

```typescript
type SubRlmFn = (subPrompt: string) => Promise<string>;

function makeSubRlm(
  baseModel: string,
  parentMaxIter: number,
  onProgress?: (event: RlmProgressEvent) => void,
  depth: number = 0
): SubRlmFn {
  return async (subPrompt: string): Promise<string> => {
    if (depth >= MAX_RECURSION_DEPTH) {
      throw new Error(`RLM: max recursion depth (${MAX_RECURSION_DEPTH}) reached`);
    }
    // 子ループは反復上限を半分に（コスト爆発防止）
    const childMaxIter = Math.max(4, Math.floor(parentMaxIter / 2));
    return runRlmLoop({
      prompt: subPrompt,
      baseModel,
      maxIterations: childMaxIter,
      onProgress,
    });
  };
}
```

- `sub_RLM` は REPL のコード（LLM が生成した JavaScript）から `await sub_RLM("...")` として呼ばれる
- `vm.runInContext` は同期実行だが、`sub_RLM` は async なので、コード内で `await` を使えるよう
  `vm.runInContext` に渡すコードを async IIFE に包むか、`vm.Script` + `runInNewContext` で工夫する
  → **解決策**: LLM に生成させるコードは常に top-level await を前提とし、
  `vm.runInContext` でなく `new AsyncFunction(code)(ctx)` パターンを使う

#### async実行の具体案

```typescript
async function execInREPLAsync(ctx: vm.Context, code: string): Promise<ExecResult> {
  const lines: string[] = [];
  const localConsole = { log: (...a: unknown[]) => lines.push(a.join(" ")) };
  // コードを async 関数として包んで実行
  const wrapped = `(async () => { ${code} })()`;
  try {
    await vm.runInNewContext(wrapped, { ...ctx, console: localConsole }, { timeout: 60_000 });
  } catch (e: any) {
    return { stdout: lines.join("\n"), error: e.message };
  }
  return { stdout: lines.join("\n") };
}
```

### 5. Streaming対応方針（SSEで中間進捗を返す）

RLM は複数ターンかかるため、クライアントに進捗をリアルタイムで見せることが重要。

#### イベント種別

| イベント       | 内容                              | SSEチャンク内容例                            |
|--------------|-----------------------------------|---------------------------------------------|
| `rlm_iter`   | ループ開始（何ターン目か）         | `[RLM iter 1/10]`                           |
| `rlm_code`   | LLMが生成したコード               | コード本文（オプション、デバッグ用）          |
| `rlm_exec`   | REPL実行結果のメタデータ          | `[stdout: 342 chars] first 200 chars...`    |
| `rlm_error`  | REPL実行エラー                    | `[error: ReferenceError: x is not defined]` |
| `rlm_sub`    | sub_RLM 呼び出し開始              | `[sub_RLM depth=1]`                         |
| `rlm_done`   | Final変数セット、ループ終了       | ファイナル出力                               |

#### SSE実装方針

- 既存の `createStreamChunk` でテキストとして流す（特別な SSE イベント型は使わない）
- 各イベントを `\n---[rlm:iter N]---\n` のようなセパレータ付きでテキストストリームに乗せる
- ファイナル応答は通常の assistant メッセージとして最後に送信する
- `stream: false` の場合は全ループを実行してから一括返却（進捗は捨てる）

```typescript
// streaming時: progressイベントをSSEチャンクとして流す
const onProgress = (event: RlmProgressEvent) => {
  const text = formatProgressEvent(event);
  res.write(createStreamChunk(ctx.id, ctx.model, ctx.created, text));
};
```

---

## ファイル構成案

### 追加するファイル

```
src/
  rlm/
    index.ts          # RLMエントリポイント (runRlmLoop, parseRlmModel)
    repl.ts           # vm.Context管理 (initREPL, execInREPLAsync, metadataOf)
    sub_rlm.ts        # sub_RLM再帰ファクトリ (makeSubRlm, MAX_RECURSION_DEPTH)
    prompt.ts         # RLM_SYSTEM_PROMPT (論文付録Cのプロンプト参照)
    types.ts          # 型定義 (ReplState, RlmProgressEvent, HistoryMessage等)
```

### 変更するファイル

| ファイル                        | 変更内容                                                   |
|---------------------------------|------------------------------------------------------------|
| `src/handlers/chat.ts`          | `parseRlmModel` で分岐、`handleRlmRequest` に委譲          |
| `src/handlers/models.ts`        | RLMモデル名（`rlm-*`）を `/v1/models` に追加               |

### 変更しないファイル

- `src/utils/convert.ts` — RLMは内部でAnthropicClientを直接使うため不要
- `src/utils/stream.ts` — 既存のSSEユーティリティをそのまま流用
- `src/utils/auth.ts` — 変更不要
- `src/utils/tool_convert.ts` — 変更不要（RLMはtools非対応、初版）

---

## TODO（実装ステップ）

### Phase 1: 基盤

- [ ] `src/rlm/types.ts` — 型定義を書く
- [ ] `src/rlm/repl.ts` — `initREPL`, `execInREPLAsync`, `metadataOf` を実装
- [ ] `src/rlm/prompt.ts` — システムプロンプトを定義（論文付録C参照）
- [ ] `src/rlm/sub_rlm.ts` — `makeSubRlm`, `MAX_RECURSION_DEPTH` 定数を実装

### Phase 2: RLMループ

- [ ] `src/rlm/index.ts` — `runRlmLoop` の実装
- [ ] `src/rlm/index.ts` — `parseRlmModel` の実装
- [ ] `src/handlers/chat.ts` — RLM分岐を追加（`handleRlmRequest`）

### Phase 3: Streaming対応

- [ ] `src/rlm/index.ts` — `onProgress` コールバックを実装
- [ ] `src/handlers/chat.ts` — `handleRlmStreaming` を実装（SSEで進捗を流す）

### Phase 4: Models対応

- [ ] `src/handlers/models.ts` — RLMモデルのリストを返す（`rlm-{baseModel}` の形で全モデル分）

### Phase 5: テスト・調整

- [ ] 簡単なE2Eテスト: `rlm-claude-haiku-4-5` でNIAH的なプロンプトを処理できるか確認
- [ ] `MAX_ITERATIONS` のデフォルト値チューニング（初期値: 20）
- [ ] `MAX_RECURSION_DEPTH` のデフォルト値チューニング（初期値: 5）
- [ ] コスト計測（何ターンでいくらかかるか）

---

## 懸念点・制約

### セキュリティ（vm sandbox）

- Node.js `vm` モジュールは **完全なサンドボックスではない**  
  `vm.runInContext` でもプロトタイプチェーン経由でホストオブジェクトにアクセス可能
- 対策:
  - `require` / `process` / `__dirname` などをコンテキストに渡さない
  - タイムアウト（`timeout: 60_000` ms）を設定して無限ループを防ぐ
  - コード長の上限を設ける（例: 8KB）
  - ファイルシステム・ネットワークへのアクセスは `sub_RLM` 経由のみ（初版では禁止）
- **本番環境では Docker/VM 等での隔離を強く推奨**（vm だけでは不十分）

### コスト管理

- 1回のRLMリクエスト = (maxIterations × ルートLLM呼び出し) + (sub_RLM呼び出し数 × 深さ)
- 最悪ケース: 20ターン × 5階層の深さ = O(20⁵) 呼び出し（現実的には起きないが上限設定が必須）
- 対策:
  - `MAX_ITERATIONS`: デフォルト 20、リクエストヘッダで上書き可能（`x-rlm-max-iter`）
  - `MAX_RECURSION_DEPTH`: デフォルト 5、超えたら例外
  - 子ループの `maxIterations` を親の半分に制限（`makeSubRlm` 内）
  - トータルLLM呼び出し数カウンター（グローバル上限: 200回/リクエスト）
  - レスポンスに `x-rlm-total-calls` ヘッダで使用量を返す

### 最大再帰深度

- Node.js の call stack 制限（約10,000フレーム）よりは余裕があるが、
  async/await のスタックで深くなりすぎると問題になる可能性
- `MAX_RECURSION_DEPTH = 5` を固定上限とし、超えたら `Error` をスロー
- 深さは `sub_RLM` ファクトリの引数で追跡（スタックトレースではなく明示的カウント）

### async実行と vm の相性

- `vm.runInContext` は同期APIだが、LLMが生成するコードは `await sub_RLM(...)` を含む
- `vm.runInNewContext` に async IIFE で包んで渡せば動くが、
  コンテキストの共有（変数の永続化）に注意が必要
- **解決案**: `vm.Script` ではなく `new AsyncFunction(...code)(sandbox)` パターンを使い、
  サンドボックスオブジェクトを手動で受け渡す（REPLの状態を `sandbox` オブジェクトに保持）

### streaming と RLMループの並行性

- 現行の hermit-shell は 1リクエスト = 1 LLM呼び出し のシンプルな構造
- RLMは複数ターンの LLM 呼び出しを直列に行うため、レスポンス完了まで数十秒〜数分かかる
- Express のデフォルトタイムアウト（Node.js は無制限だが、リバースプロキシが60秒でタイムアウトする場合あり）
  → SSE streaming を使えばコネクションを維持できる（`stream: true` での使用を推奨）
- `stream: false` の場合の長時間待機はクライアント側でタイムアウトしやすいため、
  ドキュメントで `stream: true` を強く推奨する

### 初版スコープ外（将来の拡張）

- tools + RLM の組み合わせ（初版は tools 非対応）
- ルートモデルと子モデルを別々に指定（例: `rlm-sonnet-4-6+haiku-4-5`）
- Fine-tuned RLM モデルへの対応（論文の RLM-Qwen3-8B 相当）
- RLM trajectory のロギング・可視化

---

## システムプロンプト設計メモ

論文付録C のプロンプト設計に基づく。以下が重要な要素:

1. **REPL変数の案内**: `prompt` 変数に全プロンプトが入っている旨を伝える
2. **Final変数の使い方**: `Final = "答え"` をセットすることで終了することを指示
3. **sub_RLM の使い方**: `await sub_RLM("サブプロンプト")` で再帰的に自分を呼べることを指示
4. **コンテキスト節約**: 長い文字列は変数に格納し、stdout に大量のテキストを流さないよう指示
5. **コード実行前提**: 応答はすべてコードブロック（```js ... ```）で返すよう指示

```
You are operating inside a REPL environment (JavaScript/Node.js).
A variable `prompt` contains the user's full input as a string.
You have access to `sub_RLM(text: string): Promise<string>` to recursively process sub-tasks.
Set `Final = "your response"` to return the final answer.

Rules:
- Always respond with executable JavaScript code.
- Do NOT copy large text into your response; use variables and sub_RLM calls instead.
- The output of each code block is captured; only metadata (length + prefix) is shown to you.
- Use sub_RLM for semantic processing of sub-strings (summarizing, classifying, etc.).
- Set Final when done. Do not set Final until the answer is complete.
```
