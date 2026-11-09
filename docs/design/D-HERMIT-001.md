# D-HERMIT-001 — 1台のhermit-shellで複数のClaude契約を優先順に使う

**状態: 設計承認待ち。実装・本番操作の承認ではない。**

- 対象: `kojira/hermit-shell`、調査基点 `ed081e0ee68bd1731050d41a5507329ae90fd828`。
- 正本: 専用ブランチ `design/D-HERMIT-001` の本書。Issue/PRは本書への参照のみを持つ。
- 今回の成果: ソース調査と具体設計。変更は本書のみ。本番、認証ファイル、トークン、CLIログイン、推論APIにはアクセスしていない。
- 承認単位: 以下のUX・データ所有権・切替条件・制約を一体で承認する。設計承認と実装指示によるoffline実装の開始と、提供元の利用条件を踏まえた実資格情報の利用・実推論・配備の判断は分離する（§11）。

## 1. 目的・非対象

元のhermit-shell **1インスタンス**へ、利用者が管理する別々のClaudeサブスクリプションを**可変長の登録リスト**として設定する。現在の登録予定は3件だが、固定枠数・固定試行数ではない。通常は優先順位1、**枠不足と特定できる拒否**なら同じ要求を後続の適格な登録へ順に試す。クライアントの接続先、OpenAI互換形式、モデル、tools、キャッシュ指定を変えない。

一般的な負荷分散、ラウンドロビン、モデル自動変更、API従量課金へのフォールバック、別サービスの認証収集、ブラウザセッション/Keychain読み取り、独自OAuth実装、利用量ポーリングは行わない。Bonsai経路、別ホストへの既存フェイルオーバー、セカンダリーホストの移行・停止・設定は対象外。RLMはPLAN.md上の案であり、今回実装しない。

これは提供元の上限を解除する仕組みではない。各契約の上限は尊重する。3件のトークンを登録しただけでは3件の契約であることを証明できず、同じ契約から複数発行したトークンは枠を共有する。

## 2. 確認済みの現状と根拠

ソース参照は上記commitに固定する。行番号は調査基点での番号。

| 根拠 | 現状・設計への含意 |
|---|---|
| `src/utils/auth.ts:10–26`, `:46–78` | `ANTHROPIC_API_KEY` > `ANTHROPIC_AUTH_TOKEN` > none。READMEのOpenClaw/Keychain自動取得記述は現行コードと不一致。外部認証へ戻さない（[Issue #2](https://github.com/kojira/hermit-shell/issues/2)）。Bearerのbeta/user-agent/x-appは単一builderを共有。 |
| `auth.ts:84–86`, `:112–154`; `start.sh:11–15` | setup検証はHaiku、max_tokens=1の**実推論**。成功時だけ`.hermit-auth`を0600/temp→renameで保存しenv更新。start.shは固定の`.hermit-auth`を読む一方、auth.tsは`HERMIT_AUTH_FILE`を受ける。起動スクリプトのこの既存差は本筋外として変更しない。 |
| `src/handlers/chat.ts:155–171`, `:226–313`, `:334–347` | envから共有SDK clientをキャッシュ。4経路（stream/nonstream × tools有無）が`streamMessage()`へ合流し、**nonstreamも上流はSSE**。認証依存のClaude Code system blockはconvertRequest/buildAnthropicRequestWithTools時に作られる。clientだけ替えて要求変換を旧認証のままにしてはいけない。 |
| `chat.ts:380–419`; `src/utils/message_accumulator.ts` | 上流HTTP200を取得した時点のonOpenで下流の初期SSE chunkを送る。toolsは最終時にまとめて送信する。途中のtext/tool/thinkingを受信した後の再試行は重複生成になる。既存の切断abortはSSEにあるがnonstreamにはない。 |
| `src/utils/rate_limit.ts`; `src/handlers/chat.rate-limit.test.ts` | 429だけSDK再試行を抑止し即時返却。構造化`rate_limit_error`はSSEでも検出。503等のSDK retryは保持しテストがある。429 fixtureは明示的にsyntheticで、サブスク枠判定の実証ではない。 |
| `src/handlers/setup.ts:18–23`, `:88–110`, `:423–514`; `src/server.ts:30–35` | `/setup`, `/setup/token`, `/setup/claude/{start,status,code,cancel}`が既存入口。socket peerのloopback/許可IPv4 CIDRだけ許可。現在は1トークン全置換、masked表示。API_KEYがあればAUTH_TOKENを適用しても有効認証は変わらない。 |
| `src/utils/setup_token_flow.ts:107–536`, `:538–615` | 1件の公式`claude setup-token`子プロセス、10分期限/256KiB出力上限。URLが出ないCLIには手動入力へ案内。HOME等だけの限定envで起動。トークンは内部検証/適用、ブラウザへ返さない。検証await後のcancel/新試行/対象削除を再チェックする仕組みは追加が必要。 |
| `src/index.ts`, `server.ts`, `package.json`, `pnpm-lock.yaml` | 単一Nodeプロセス、Express、SDK lockは0.80.0。`/health`は生存確認。ホストフェイルオーバーの実装/設定はこのrepoに無い。CIはbuildとoffline tests。 |

### 提供元根拠の強さを分ける

1. **公式仕様**: [API errors](https://platform.claude.com/docs/en/api/errors)、[rate limits](https://platform.claude.com/docs/en/api/rate-limits)。429は短時間のRPM/TPM/acceleration、API支出上限等でも起こる。`retry-after`は待機指示でありサブスク枠の証明ではない。標準`anthropic-ratelimit-*-reset`はAPI token-bucketの補充時刻で、週次契約枠のresetには転用しない。現行公式資料の`enforced_spend_limit_reached`もAPI支出上限であって、今回のサブスク切替判定には使わない。
2. **SDKの固定ソース**: [0.80.0 client.ts](https://github.com/anthropics/anthropic-sdk-typescript/blob/sdk-v0.80.0/src/client.ts#L836-L895) は標準2回retry、`x-should-retry`優先、429/408/409/5xx retry、Retry-After待機。[streaming.ts:82–84](https://github.com/anthropics/anthropic-sdk-typescript/blob/sdk-v0.80.0/src/core/streaming.ts#L82-L84) はSSE errorを`APIError(undefined, payload, undefined, response.headers)`にする。従ってSSE errorでも**当該HTTP応答のheaders**は残るが、HTTP statusはundefinedになる。
3. **このrepoの運用報告**: [Issue #1](https://github.com/kojira/hermit-shell/issues/1) に週次枠100%の429と`anthropic-ratelimit-unified-7d-status: rejected`の記録がある。生の応答を今回再取得した証拠ではない。即返却を求めた同Issueの原則（サーバー内でresetまで眠らない）を維持し、明確な枠拒否時のみ、その要求の適格な登録リストを上限とする切替を追加する。
4. **提供元repoの利用者報告（公式API契約ではない）**: [anthropics/claude-code #104690](https://github.com/anthropics/claude-code/issues/104690) は`unified-status: rejected`、`unified-representative-claim: five_hour`、`unified-reset`（epoch秒）を使った再現と本番事象を記載。[#103820](https://github.com/anthropics/claude-code/issues/103820) は週次拒否時に`unified-7d-status: rejected`、`unified-reset: 1792494000`、`retry-after: 56482`を報告。これを**限定allowlistの根拠**にするが、安定した公開サブスクAPIとは言わない。
5. **使わない推測**: 架空の`*-5h-reset`/`*-7d-reset`、エラー文中の「limit」「429」、ヘッダー無し429、過去のusage 100%だけからの推論。5時間/7日の境界をログイン時刻等から計算しない。`/api/oauth/usage`は本設計では呼ばない。

## 3. 利用者の入口から完了まで

### 3.1 /setupの表示

上部に「認証モード: 従来の単一認証 / 複数契約の優先切替」「有効な認証源」「登録件数」を表示。API_KEYがある場合は「環境変数のAPIキーが優先されています。複数契約モードの有効化には起動設定の変更が必要」と明示し、有効化ボタンを無効にする。APIキーを勝手に消したり従量課金へ切り替えない。

現在3件を登録した場合の一覧例（行は登録リストから生成し、固定3スロットではない。名称は利用者入力であり契約者情報を自動取得しない）:

| 優先 | 名前 | 状態 | 次に使える目安 | 操作 |
|---|---|---|---|---|
| 1 | メイン | 週次枠の拒否を検出 | 提供元の再試行可能時刻 / 不明なら次回確認時刻 | 上下移動・名前変更・再認証・削除 |
| 2 | 予備A | 次の要求で使用予定 | — | 同上 |
| 3 | 予備B | 利用可能 | — | 同上 |

「使用予定」は枠残量の保証ではない。表示状態は最後の観測。「通信失敗」「一時的なレート制限」「再認証が必要」「回復確認中」を枠切れと区別する。secretは「登録済み」だけ表示し、新しいpool一覧にはトークンの一部も返さない。最後の適用時刻、現在のpriority、mode、revisionを表示する。

### 3.2 初回導入と登録

1. `/setup`で「現在の単一トークンをメインとして取り込む」。名前入力、既存単一認証をバックアップとして保持する説明を確認。稼働中envのBearerだけを明示的にコピーする。外部ファイル探索なし。これは既存認証のコピーなので検証推論を追加しない。状態は未確認。
2. 「契約を追加」で名前（trim後1–40文字、制御文字なし、重複不可）を入力。登録件数を3に制限せず、追加/削除/並べ替えで可変長リストを設定する。公式CLIによるブラウザ再認証か、既存のpassword欄へのセットアップトークン入力を選ぶ。
3. ブラウザで**意図した別のアカウント**にログインしていることを本人が確認する。アカウント切替は公式サイト/利用者のブラウザプロフィールで行い、HermitがログアウトやCookie操作をしない。CLIがURLを出さない場合は、既存の`claude setup-token`手動手順へ切り替える。
4. 「最小の検証要求を1回送り、契約枠を消費する場合があります」を表示して「検証して追加」。OAuth setup tokenのみを受け付け、poolにはAPI keyを登録しない。同一tokenの重複はサーバー内比較で409。別tokenが同一契約かの自動検証はできない旨を表示する。
5. 成功した対象だけを保存。失敗（401/403/429/通信/保存失敗）は**追加も置換もしない**。429は「認証不正」ではなく「現在検証できません。時間をおいて再試行」と表示。既存の登録済み契約と単一認証を壊さない。
6. 必要な契約（現在は3件）を登録し、順序を確認して「優先切替を有効にする」。1件、2件、4件以上も同じ操作・schemaで保存/利用できる。最後に「再起動不要。次の要求から適用。進行中の応答はそのまま」と表示。`/v1/chat/completions`へ今まで通り送信するだけで使える。

有効化後の通常例: メインへのHTTP429＋認識済み枠拒否 → メインを停止状態に記録 → 同じ要求を予備Aへ → クライアントには予備Aの応答だけが届く。切替履歴は`/setup`に最後の状態として見え、一般のchat応答にアカウント名を漏らさない。

### 3.3 変更・削除・終了

- 順位変更は保存後の新規選択から有効。進行中要求のsnapshotを差し替えない。自動round-robinはない。
- 再認証は**対象IDに紐付ける**。検証成功でその1件だけ置換、generation更新、対象client/cooldownだけ破棄。refresh tokenを保持して自動更新する機能は作らない。発行期限を推測せず、401後は人間が再認証する。
- 削除は名前を含む確認画面、「新規要求から使用しません。送信済み要求は終了まで続行。提供元での失効とは別操作」を表示。最後の1件削除も可能だが、poolはenabledのままになり503。**黙って旧envへ復帰しない**。
- 元の認証をpoolから消しても、rollback用に残した従来`.hermit-auth`のtokenは削除/失効しない。このことを削除確認にも表示する。提供元で失効させた場合はrollbackにも使えない。
- CLIフローは常に1件。中止でその試行のみ終了し、未適用secretを破棄。他のアカウントの認証・chatは維持。

## 4. データ・所有権・保存

### 4.1 唯一のpool正本

新設`src/utils/accounts.ts`の`AccountStore`がpool構成、secret、generation、観測状態の唯一の所有者。ルーティング側やsetup側が別配列/envへコピーして正本を増やさない。保持するclientは`(id,generation)`単位の派生キャッシュ。

保存先: `HERMIT_ACCOUNTS_FILE`があればその絶対パス、無ければ`getAuthFilePath()`の親ディレクトリの`.hermit-accounts.json`。絶対パスでない指定は設定エラー。既存`.hermit-auth`をpool保存に流用しない。新ファイルと一時ファイルをgitignoreへ追加する。

非公開ファイルの形（以下はschema説明でありsecret例を含まない）:

```text
schemaVersion: 1
revision: integer                 # 利用者による構成変更時だけ増加
mode: legacy | pool
accounts: Account[]              # 可変長。配列順が優先順位の唯一の表現
  id: UUID                       # 表示名/順序から独立
  name: string
  generation: integer            # token置換時だけ増加
  authToken: secret string        # setup token。読み取りAPIでは絶対に返さない
  appliedAt: ISO8601
  observed:
    state: unverified | ready | exhausted | auth_required
    reason: weekly | session | auth | null
    retryAt: epoch milliseconds | null
    retryBasis: provider | local_probe | null
    failureCount: integer
```

`authToken`を含む内部型と、`AccountView`（id/name/priority/状態/時刻のみ）を分け、明示allowlist射影で返す。secretをpublic configやログに重複保存しない。ローカル同一OSユーザーに読まれた後の追加暗号化・外部vault導入は範囲外。

- 新規作成/temp fileを0600にし、同一ディレクトリでunique temp→rename。保存成功後だけメモリーsnapshotを公開する。既存方式を共通化し、書込失敗時は直前の有効構成を維持。fsync保証の拡張は本件で要求しない。
- 起動時にversion、型、ID/名前/secret重複を検証。登録数3などの固定上限は置かない。ファイルが存在して壊れていたら**pool設定エラー**としてchatを503にし、旧envへfallbackしない。`/health`は生存確認のまま、`/setup`で修復/rollback手順を表示。
- 構成mutationは単一プロセス内で直列化。`expectedRevision`不一致は409。検証中はロックを持たず、開始時のrevisionと対象generationを記録し、検証後に比較してからcommitする。検証中のdelete/replace/reorderに負けた試行は409、適用しない。
- cooldown/認証エラー観測の更新は構成revisionを増やさず、現在の(id,generation)へmergeする。古いgenerationの完了は新しい認証へ一切反映しない。過去に送信済みの成功が、後から観測したexhausted/auth_requiredを解除してはいけない。解除できるのはその状態のrevisionを取得した回復probe成功だけ。
- exhausted/retryAt/auth_requiredは再起動後も保持。probe中/in-flight/clientはメモリーのみ。起動後、期限経過したexhaustedは「次の通常要求で回復確認」に戻す。
- 観測の保存に失敗したら、そのプロセス内は拒否状態を保持し再使用を避ける（メモリーを旧readyへ戻さない）。setupに保存失敗を出し、ログには安全なエラー分類だけ。再起動で冷却が失われ得ることを明示。構成変更の成功としては報告しない。

### 4.2 従来との優先関係

1. `ANTHROPIC_API_KEY`あり: 現行の単一API key経路。pool有効化は拒否。poolファイルが既にあってもAPI key overrideをsetupに明示する（不正poolファイルの場合のchat 503は上記検証エラーを優先）。
2. 有効なpoolファイルが`mode=pool`: 登録したBearerだけを使う。空/全停止でもenvへ降りない。
3. ファイル無し、または`mode=legacy`: 従来の`resolveAuth()`。API key > env token > noneを保持。

起動ログも認証源の名称のみ。pool有効中に`process.env.ANTHROPIC_AUTH_TOKEN`を書き換えて選択を表現しない。start.sh、HOST/PORT、外側のfailover設定は変更不要。

## 5. 失敗の分類と回復規則

`src/utils/rate_limit.ts`へ純粋な`classifyUpstreamFailure(error, now)`を置く。返り値は`exhausted | rate_limited | auth | request | transient`と安全な理由/再試行時刻。raw error、headers、messageをそのまま保存・公開しない。

### 5.1 真の枠拒否として採用する限定条件

**選択中のpool OAuth tokenの応答**で、`APIError`かつHTTP429または構造化`error.error.type === rate_limit_error`、さらに次のどちらか:

- `anthropic-ratelimit-unified-7d-status`が完全一致`rejected` → `weekly`。
- `anthropic-ratelimit-unified-status`が完全一致`rejected` **かつ** `anthropic-ratelimit-unified-representative-claim`が`five_hour`または`seven_day` → `session`または`weekly`。

両方ならweeklyを表示理由に選ぶ。大文字小文字/別名を推測で広げず、HTTPヘッダー名の標準case-insensitive処理だけ利用する。`overage-status: rejected`だけ、`allowed_warning`、利用率100%、未知claim、API支出上限、エラーmessageの文字列一致では判定しない。HTTP200成功時の拒否風ヘッダーだけでは切替しない。これは観測済みシグナルを使うv1であり、未知形式を網羅した「絶対的な枠判定」ではない。

### 5.2 分類後の動作

| 分類 | 同じ要求で別契約へ | 次の要求・回復 |
|---|---|---|
| 枠拒否が確定、まだ上流を開いていない | 可、未試行の次順位だけ | 当該契約をexhausted。§5.3の期限まで選ばない |
| 同じ枠拒否、既に上流を開いた/出力した | **不可** | 当該契約をexhaustedにして次の別要求から切替 |
| その他429/構造化rate_limit_error | **不可**、従来の429型と有効なRetry-Afterを即返却 | exhausted認定も、新たな契約単位/pool全体のgateも行わない。後続の独立要求は通常の優先選択に従う。UIは「一時制限/種別未確定」で、枠切れとは呼ばない |
| HTTP401/構造化authentication_error | 不可 | 当該契約をauth_required。次の独立した要求は他のready契約を選べる。本人の再認証成功まで元へ戻さない |
| 403 permission_error | 不可 | 資源/modelの権限かもしれないため契約全体を無効化しない。要求を終え、setupに権限エラーを表示 |
| 400/404/413等の要求不正 | 不可 | pool状態を変更しない |
| network/timeout/408/409/5xx/529 | 不可 | poolではSDK含めretryしない。状態を枠切れにせず即エラー。外側の既存ホストfailoverに返す |
| 利用者の切断/abort | 不可 | 上流abort、lease解放。契約状態を変更しない |

同一要求での自動切替理由は枠拒否だけ。新しい独立要求が以前auth_requiredになった契約をskipすることと、auth失敗した要求を再送することは区別する。

### 5.3 cooldown/reset

- `anthropic-ratelimit-unified-reset`のみを契約reset候補として読む。上記枠判定に成功した応答に限り、整数の**Unix秒**、安全整数でJS時刻として表現可能、未来であることを検証してmsへ変換する。過去/不正/ミリ秒らしい範囲外値は捨てる。未来時刻の妥当性上限は`now + 8日`（認識対象が5時間/7日なので誤単位や異常値の誤採用を防ぐためのローカル検証値）。この上限は契約resetを生成するために使わない。
- 既存`rateLimitRetryAfter()`の厳密なdelta-seconds/HTTP-date検証を共有し、安全な時刻へ変換。期限が過去なら0秒として扱い、数値overflowは無効。reset候補とRetry-Afterの双方が有効なら**遅い方**。標準APIのrequests/tokens-resetは使用しない。
- provider期限無し/期限到達直後に再拒否なら、初回15分、再失敗30分、以降60分のローカルprobe間隔。Retry-After等がより遅ければ尊重する。これは「復旧予定」ではなく「次回確認可能時刻」と表示。期限が即時なら最低1秒を置いてloopを防ぐ。
- 期限到達で勝手にreadyへ戻さず、**次の通常ユーザー要求1件**だけをsingle-flight probeとしてその契約へ送る。background推論/usage pollingはゼロ。他の同時要求はprobe中をskipして次順位を利用、候補が無ければ503 busy。probe成功でready、失敗なら分類に従い再冷却/認証待ち。元の高順位が回復したら後続の要求から優先へ戻す。
- 枠拒否のprobeがnetwork/403等で終わる場合は従来のexhaustedを保持し、次回ローカルprobe時刻を設定して連続probeを防ぐ。曖昧429も既存のexhaustedを解除せず、当該契約の次回ローカルprobe時刻を設定するが、他契約を停止しない。
- ready状態の同時成功が古い枠拒否を打ち消さない。これは状態generation/観測revisionの比較で保証する。

## 6. 上流送信・並行性・出力開始の境界

新設`src/utils/account_router.ts`はアカウント選択と1要求のattempt制御のみを担当。変換ロジック、SSE生成、storageを重複実装しない。

1. Bonsai分岐は先に既存通り終了。legacyモードも既存経路・SDK retry方針を保持する。
2. poolは要求受付時に**その要求で適格なIDの優先順**をsnapshotし、その件数をNとする（ready/unverifiedと期限到達済みでprobe権を取得可能なexhaustedが対象。auth_required/冷却中は除外）。選択直前に現在の存在/generation/状態を再照合。途中で追加された契約や、受付時に不適格だった契約は次の要求から。削除済み/新たに冷却中となったものはskip。token置換は未送信なら新generationを利用し、送信済みならそのattemptの旧generationを維持する。snapshotへの追加/周回は禁止する。
3. 選んだ資格情報から**明示client**を作る。`buildAuthTokenClient`を唯一のbuilderとして再利用し、pool用は`apiKey: null`を明示してSDKのenv混入を防ぐ、`maxRetries: 0`、SDK raw loggerを無効化する。global envを書き替えない。legacyの503 retry testを壊さない。
4. `handleChatCompletions`からrequest-builder callbackを渡し、attemptのauthと対応する`convertRequest`/`buildAnthropicRequestWithTools`を呼ぶ。変換済み内容は同じbody/model/cache_controlを維持。clientとsystem blockが同じ認証から作られたことをassertする。
5. `streamMessage`の上流`messages.create({stream:true})`を共通実行seamとし、成功時の`accumulateMessage`を再利用。clientを引数注入し、poolでは共有getClientを呼ばない。
6. **保守的なcommit点は上流HTTP200のstream取得成功時**。既存onOpenの直前に`upstreamOpened=true`とし、以後はstream/nonstream/toolsいずれも再送不可。nonstreamでまだ下流に1byteも出していなくても、上流を開いていたら再送しない。これによりtool/thinkingを含む受信済み生成を重複しない。HTTP200直後のSSE枠エラーも次の要求にしか切り替えられない制約をUI/READMEに記す。
7. pre-openの枠拒否だけcatchして状態更新、次の未試行IDへ。**1入力要求あたり上流送信は適格snapshot件数N以下、各ID最大1回、同時送信1、待機sleepなし、SDK再試行0**。候補を使い切ったら終了する。3件というretry capや固定回数loopは置かない。retry budgetを各helperに二重実装しない。
8. chat要求のグローバル同時数上限・待ち行列は新設しない。通常は優先1へ同時要求が集中してよく、空いている契約へ負荷をばらまかない。各要求内の逐次attemptとprobeのsingle-flightを維持し、probe中で他に候補が無い場合だけ503 busyとする。セットアップ検証は別枠で全体1件のみ。
9. chatにはpre-open試行群や要求全体の共通打切り期限を新設せず、既存SDKのtimeout挙動と切断abortを維持する。timeout時は504、再送しない。cooldownを要求内で待たない。有限性は§6.7の適格snapshot件数N以下・各ID最大1回で保証する。外部host failoverの実際のtimeout値は調査していないため、本設計から変更しない。
10. `res.close`のabortはpoolのnonstreamにも適用。SSE前/後を問わずabort、finallyでlease/probe lockを必ず解放。切断後は次のattemptを出さない。予約後deleteされた送信済み要求は最後まで続け、完了時の観測は削除済み/旧generationには書き戻さない。

## 7. HTTP/SSE契約と秘密情報

- `/health`, `/v1/models`, Bonsai、正常なOpenAI応答/tool_calls/usage/[DONE]は変更しない。
- poolで上流未openのまま全候補がexhaustedならHTTP429、既存`rateLimitErrorBody()`のtype=`rate_limit_error`, code=`rate_limit_exceeded`を維持し、追加`reason=all_accounts_exhausted`。Retry-Afterは最も早い次回probe可能時刻までの切上げ秒。曖昧429は当該要求だけ従来bodyと有効なRetry-Afterを即返却し、枠全滅と表示せず後続要求をgateしない。
- 無設定、全auth_required、または枠拒否とauth_requiredの混在で使えるものが無い場合はHTTP503、type=`api_error`, code=`credentials_unavailable`。ID/名前/token/生provider messageを返さない。空候補でも制御が有限に終わる。
- probe中で他に候補が無い場合は503 `credential_pool_busy`、Retry-After:1。構成破損は503 `credential_config_error`。network/529/5xxは503 `upstream_unavailable`、timeoutは504 `upstream_timeout`。poolの401は503 `upstream_authentication_error`（client自身の認証エラーにしない）。403/400等は同じstatusの安全な固定文言。legacyは現在のHTTP/SSE契約を維持する。
- **poolのstream要求でもpre-openエラーは実HTTP error＋JSON**。現在の非429でHTTP200 SSEを返す挙動はlegacyに限定して保持。これで外側host failoverがpoolのpre-open障害を検出できる。
- open後はHTTP statusを変えずSSE `{error: {message: 固定文言, type, code, status}}`を1回、`[DONE]`を1回、end。成功finish、usage、完成tool_callsを追加しない。nonstreamの上流途中失敗はエラーJSONのみ、部分成功を返さない。
- logは`id`（ランダム内部ID）、generation、分類、HTTP status、attempt番号、時刻だけのallowlist。token、認証コード、Authorization、OAuth URL query、request body、SDK error全体やprovider error.messageを出さない。pool用のcatchで既存`console.error(error)`へraw errorが流れないようにする。SDK loggerも無効にし、invalid SSEを含め秘密文字列が出ないテストを行う。legacy全般のlogging修正へ拡大しない。
- setupレスポンスはno-store、入力はpassword、成功/失敗/中止のいずれもtoken/code欄をclear。名前はtextContent/escapeHtmlで出し、tokenをDOM/data属性/localStorage/URLに置かない。

## 8. Setup APIの確定案

全て既存の`isSetupRequestAllowed()`を共有。新規入口も同じsocket peer境界、プロキシヘッダーを信用しない。アカウント別の新たな利用者認証基盤は作らない。許可CIDR内は現在と同じ信頼主体。

| 操作 | 入力 | 成功/失敗 |
|---|---|---|
| `GET /setup/accounts`（追加） | なし | 200 `{revision,mode,effectiveAuth,accounts:AccountView[]}`。secret無し |
| `POST /setup/accounts`（追加） | JSON `{action,expectedRevision,...}`。action=`import_legacy`（name）/`rename`（id,name）/`reorder`（orderedIds）/`delete`（id）/`set_mode`（mode） | 200 新view、不正400、競合409、保存失敗503。reorderは現存ID集合と完全一致。pool有効化はAPI_KEYあり409、0件400。legacy復帰は元のenv認証源と警告を確認して明示実行 |
| `POST /setup/token`（拡張） | legacyの`{token}`はmode=legacy時のみ維持。pool対象は`{token,expectedRevision,target:{kind:add,name}|{kind:replace,id,generation}}` | 成功200 view、重複/競合409。検証失敗は401/403/429/503を区別し固定文言、Retry-Afterは有効な場合だけ。曖昧なtarget無しpool操作は409で拒否 |
| `POST /setup/claude/start`（拡張） | 上と同じtarget/expectedRevision、token無し。legacyは従来の意味 | 202 `{attemptId,targetId?,state}`。singleton進行中409。addは試行内部でIDを予約するが検証成功までstoreに追加しない |
| `/setup/claude/status,code,cancel`（拡張） | statusはattemptId query。code/cancelはJSON attemptId。codeのみ認証コード | 現在の試行ID一致だけ受理。不一致409。terminal stateもtargetを表示。cancel/期限切れ後にverifyが完了してもcommit不可 |

新規pool mutationとpool用CLI操作は`application/json`必須（415）、ブラウザOriginがある場合は同一originのみ（403）。既存単一認証のCLI入力互換は維持するがpoolモードで古いtarget-less start/code/cancelを許可しない。これにより新しい削除/順序変更をクロスサイトformで実行できない。CORSを開放しない。既存の許可CIDR外403テストを全追加ルートにも適用する。

`ClaudeSetupTokenFlow`はtarget/attempt generationを持ち、verify前後およびapply直前にcancel/試行ID/対象revisionをチェックする。verify自身もAbortSignal/30秒期限/maxRetries:0を受ける共通builder経由の1回呼出し。手動入力とCLIを合わせてsetup verificationは1件だけ、並行時は409。CLI操作は既存公式CLIだけであり、URLが出ない問題を独自OAuthで回避しない。

## 9. 実装seamと最小の縦切り順序（承認後）

| production seam | 最小変更 |
|---|---|
| `src/utils/accounts.ts`（新規） | 可変長登録リスト、store、atomic save、public view、revision/generation、観測状態。秘密正本はここだけ |
| `src/utils/auth.ts` | token指定のclient builderを共用可能にし、pool/verifyのexplicit auth・retry・logger option。legacy resolve/applyは保持 |
| `src/handlers/setup.ts`, `src/server.ts` | `/setup`一覧/対象選択、上記API、統一validation/store commit。別管理画面を作らない |
| `src/utils/setup_token_flow.ts` | 対象/attempt binding、cancel/verify競合ガード。公式CLIやfallback UXは再利用 |
| `src/utils/rate_limit.ts` | 根拠付き限定分類、共通Retry-After解釈。429という文字列判定は禁止 |
| `src/utils/account_router.ts`（新規） | 優先選択、bounded attempts、要求単位のlease、probe、abort。汎用LB/設定プラグインにはしない |
| `src/handlers/chat.ts` | 4経路の`streamMessage`へ明示client/attempt実行を注入。mode境界、pre-open HTTPとterminal SSE、pool safe logging |
| `src/index.ts`, `.gitignore`, `README.md` | 有効認証源名、秘密ファイルignore、現行auth記述の本件に必要な訂正/操作/限界/rollback |

順序は、(1) 既存を壊さず単一登録poolをsetupから保存して通常chat実応答までのoffline縦切り、(2) 可変件数登録・枠拒否切替・回復、(3) 競合/secret境界と既存互換、(4) 隔離環境の人間QC。helperだけ完成して本番入口を後回しにしない。ここでの「実応答」はlocalhost上流fixtureへの実HTTPであり、provider課金要求ではない。実契約によるQC/配備は別途認可を得て実行する。

## 10. 条項と受入チェックリスト（未実行）

以下は実装時の一対一のRED→minimal GREEN→保持証拠。**本調査でテストを追加・実行済みという意味ではない**。表の独立レビュー欄は実装の検証を対象とし、全て未実施。設計のみの独立レビュー結果と修正対応は§10.1に記録する。source-named testと既存HTTP harnessを使い、外部通信をlocalhost以外拒否してfake tokensだけ使う。

| ID/設計条項 | production seam / assertion-level RED | minimal GREEN / 保持する証拠 | 禁止・後続影響 / 独立レビュー |
|---|---|---|---|
| A1 §3/8 登録から利用 | `setup.accounts.test.ts`（新規）: 登録数1/2/4をparameterizeして`/setup`登録→有効化→chat、上流Bearerが優先1になる。4件目も追加成功、並べ替え/削除を反映。同token409、失敗置換で元token継続 | store＋既存setup入口連携。fake HTTP capture、viewにsecret無し、画面操作QC | 認証読取/本物推論禁止。A4の基礎 / 未実施 |
| A2 §4 正本と保存 | `accounts.test.ts`（新規）: 0600、再起動再読込、壊れたfileでenvfallback無し、rename失敗で変更未適用 | atomic store。temp fixture directory、モード/内容のassert結果 | 実認証ファイルを使わない。rollbackの前提 / 未実施 |
| A3 §3/8 lifecycle | `setup_token_flow.test.ts`拡張: Aのverify中cancel→B開始→A完了でBもAも誤適用しない。delete/reorder競合409 | attempt/revision guard、singleton検証。deferred PromiseのHTTP/flow証拠 | 旧成功で新資格情報上書き禁止。A2と連携 / 未実施 |
| A4 §5/6 枠切替4経路 | `chat.accounts.test.ts`（新規）: stream/nonstream×tools有無。登録数1/2/4で、順次429＋認識ヘッダー→末尾成功（4件時は4番目へ到達）。全拒否なら送信N回のみ、全体429。冷却中/削除済みはskip、途中追加は試さず各ID最大1回 | shared router/streamMessage。上流送信先順、auth header、model/body、SSE/JSONのassert | SDK hidden retry、API key混入、env書換禁止。A5へ / 未実施 |
| A5 §5 分類境界 | `rate_limit.test.ts`（新規）＋実HTTP: ヘッダー無し429、unknown claim、warning、overageだけ、文中429、401/403/529/networkで別契約へ再送しない。曖昧429は即返却し、exhausted認定も後続独立要求へのgateも追加しない | allowlist classifier。公式/issue由来とsyntheticをfixtureコメントで区別 | 429全件枠認定/架空header禁止。利用条件確認を代替しない / 未実施 |
| A6 §5.3 回復 | `chat.accounts.test.ts`: fake clockでreset/Retry-After/未知resetの15→30→60分。期限前0送信、期限後同時要求でもprobe1件、高順位復帰 | 持続cooldown＋観測revision。restart/旧成功との競合assert | background推論禁止、provider resetとlocal probe表示分離 / 未実施 |
| A7 §6/7 出力境界 | 実HTTP上流200直後error、text/tool/thinking後error、nonstream途中error、切断前後でattempt数1。SSE errorとDONE各1、成功finish/usageなし | upstream-open latch、terminal formatter、abort | 200後の再送禁止。既存message_accumulatorを重複させない / 未実施 |
| A8 §6 並行/abort/有限試行 | 並行要求でも各要求は逐次N回以下、SDK maxRetries0。probe single-flight、切断後は次attempt無し、delete中/replace中のold-generation結果は無効。既存SDK timeout/abortを維持し、新しい同時数上限・chat共通期限を追加しない | 要求単位のlease＋probe lock＋finally。上流送信順/abort/試行数/観測状態のassert | キュー/hedging/無限retry禁止。legacy retryへ影響させない / 未実施 |
| A9 §7/8 非漏洩/権限 | `setup.access.test.ts`拡張＋poolログcapture: 全routeでCIDR外403、Origin不一致403、form415、秘密canary入りprovider error/invalid SSEもDOM/JSON/logに無し | 共通peer guard/public projection/safe logger | tokenをmaskで返す新API禁止。OAuth URLは既存認証中の公式リンクに限る / 未実施 |
| A10 §4.2/7 互換 | 既存`chat.rate-limit.test.ts`、convert/tools/usage tests。file無しでenv順位/429即時/503 SDK retry/SSE非429互換、Bonsai素通し | 明確なlegacy/pool分岐。既存assertの保持、pool pre-open503を外側fixture clientが観測 | 既存host設定へ手を出さない。実ホストfailoverは未検証と報告 / 未実施 |
| A11 §7 全不可 | 全exhausted→429＋最短Retry-After、全auth/混在/空→503、probe中503、名前漏れなし | 即時集約エラー。HTTP status/body/上流送信0の証拠 | `/health`を契約枠でdownにしない / 未実施 |
| A12 §3/11 UX/rollback | localhost `/setup`を人間/許可されたbrowser QCで登録/順序/再認証/削除/legacy復帰。1契約故障時に選択対象が見える | 同じ画面の最後まで使える最小UX、保存失敗でも旧経路維持。fake fixture QC記録 | mock UIを本番完了と呼ばない。人間ログインは準備後に本人へ / 未実施 |

RED失敗ログとGREEN成功ログは分けて保持する。CIの成功は実契約受入や配備承認を意味しない。既存CIの`pnpm test`およびNode launcher checkを、実装candidateで規約どおり通す。設計のみの本PRにruntime testsを増やさない。

### 10.1 設計のみの独立レビューと修正記録

初版commit `8a3e478` に対する独立レビュー（artifact: `5480b444-76b4-4012-9c2c-364f25ccd965/hermit-multi-account-design-review.md`）は**設計のみ**を対象とし、判定はBLOCK（以下4件のP1）。監督が採用した最小修正を本改訂へ反映した。可変長リスト、既存seamの再利用、HTTP200後の再送禁止、generation/revisionとprobeの所有権は妥当との評価を維持する。

| 独立レビュー指摘 | 本改訂の対応箇所・内容 |
|---|---|
| 1: 曖昧429によるpool全体停止は未根拠 | §4.1/5.2/5.3/7/8/A5: 全体gateと公開フィールドを削除。当該要求の即時エラーのみとし、既にexhaustedのprobe回復規則は保持 |
| 2: 新設グローバル同時数制限は未根拠 | §6.8/7/A8/11.3: 容量制限とそのbusy条件・テストを削除。要求内逐次attemptとprobe single-flightは保持 |
| 3: 新設chat共通期限は未根拠 | §6.7–9/9/A8/11.3: 共通打切りを削除。既存SDK timeout/abortとN以下の試行上限は保持。§8のsetup検証期限は別用途であり変更しない |
| 4: 利用条件の警告とoffline実装禁止の混同 | 冒頭/§11.1/11.3: offline実装承認と実資格情報利用・実推論・配備の判断を分離。利用許諾を認定するものではない |

修正後の独立再レビューは未実施。本記録は実装証拠でも実装承認でもなく、A1–A12のRED/GREEN・実装独立レビュー・実契約受入はすべて未実施。独立レビューは外部Issue/公式資料/SDK外部ソースの内容自体を再取得しておらず、実契約の枠拒否検出成功も未検証である。

## 11. 導入・rollback・承認ゲート

### 11.1 利用条件と未確認事項

[公式Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)は、OAuthが通常のClaude Code/Anthropic native apps向けであり、第三者開発者による自アプリへのClaude.ai login提供、ユーザーのFree/Pro/Max/Ultra資格情報によるリクエスト仲介、資格情報/session tokenの収集・保存・仲介を認めない旨を記している。本方式は公式CLIを通常の推論経路として実行する構成ではなく、取得tokenをproxyからMessages APIへ送る既存方式の拡張である。**技術的に動くことは利用許諾の証拠にならない**。

本書から個人の具体契約への法的適否を断定しない。しかし「既存で動いている」「3件とも自分名義」だけで許可済みとも扱わない。利用者側でこの用途の提供元許諾/適用条件を確認する判断は、実資格情報の利用・実推論・配備の前に行う。fake tokenとlocalhost fixtureによるoffline実装は、設計承認と実装指示によって開始でき、この確認とは分離する。これは本方式が利用条件上許可されるとの認定ではない。許可されない場合は実資格情報を使った本案の運用へ進まず、正式に許可される認証/製品経路へ別設計で戻す（API課金へ黙って変更しない）。

未確認として残るもの:

- 実際の3契約それぞれの枠拒否ヘッダー、providerが今後同じシグナルを維持するか。認識不能なら429即返却となり、その要求での自動切替はしない。これをv1の明示制約として承認する。必要な追加形式は秘密を除いたresponse structural fixtureで設計を更新する。
- setup-tokenの正確な有効期限/refresh情報、別tokenが同じ契約かの照合。調査時にsecretを読まず、推測も採用しない。手動再認証と本人確認で扱う。
- 実ホストの外側failover設定、timeout、現在の起動方法。今回参照していない。既存を維持し、配備承認時に所有者が対象を確認する。新コードがHTTP429/503を返すことと、外側が実際に次ホストへ進むことは別の受入。

### 11.2 後日の導入とrollback（本作業では実施しない）

承認済みソースをビルドし、隔離した同じ入口でoffline QC→対象ホストと切替時間を別途確認→旧成果物/起動設定/単一認証を保持→drainして配備→`/setup`で明示import/add/enable→人間の実契約確認、の順。セカンダリーホストには触らない。追加2契約のログインが必要な時は、画面・起動健全性を用意してから本人に依頼する。

通常rollbackは`/setup`の「従来の単一認証へ戻す」で`mode=legacy`に保存し、新しい要求から旧envへ戻す。利用対象は登録時から保持した元のtoken/API keyであり、pool最上位を勝手に`.hermit-auth`へexportしない。事前に有効認証源と「再認証/失効後は旧tokenが使えない場合がある」を表示する。

ファイル破損でUI mutation不可の場合は、配備権限のある人が新poolファイルを非公開に退避して旧成果物/起動設定/元認証へ戻す。現行版はpoolファイルを読まないため互換性がある。認証の削除/失効は復元できないことを明記。旧成果物への切替やrestartは別の運用承認に従う。

### 11.3 利用者へ求める判断（実装者へ持ち越さない）

1. **D-HERMIT-001本文を承認しoffline実装を開始するか**: `/setup`で可変長の契約リスト（現在3件、1/2/4件以上も可能）、優先順、枠拒否だけ自動切替、曖昧429は当該要求へ即返却して全体停止なし、HTTP200後は再送なし、各要求N以下の逐次試行、既存SDK timeout/abort維持、回復probe間隔、legacy rollbackという一案。新たなchat同時数上限・共通打切り期限は設けない。
2. **実資格情報を使う前に、このサブスク資格情報利用方法の許諾・適用条件を確認する**。実資格情報の利用・実推論・配備は別途判断・認可を要し、1のoffline実装承認に含めない。利用条件上の許可を本設計が認定するものではない。
3. 承認後の初回登録時に、本人が別々の3契約の表示名/優先順位を入力し、公式画面でそれぞれログインする。秘密をDiscord/Issueへ送る必要はない。名前やtokenの事前収集は不要。

1への文脈上明確なOKは、設計承認とoffline実装開始指示として扱う。同じ実装承認を再度求めない。ただし実資格情報の利用/main merge/配備/本番実推論の承認を兼ねず、2の利用条件判断も代替しない。独立レビューの結果は本書のチェックリストへ記録し、未承認の仕様追加は行わない。
