# D-HERMIT-001 — Claudeの複数契約を優先順に使う

## 1. 目的

枠不足のため購入した別々のClaudeサブスクリプションを、1台のhermit-shellに可変長の優先リストとして登録する。優先先が明確に枠切れなら次へ切り替える。既存の`/setup`・認証処理・転送経路を拡張し、クライアントは今までの接続先・モデル・OpenAI互換形式・tools・キャッシュ指定をそのまま使う。

## 2. 利用者の操作

- `/setup`に認証モード、有効な認証源、可変長の優先一覧を表示する。名前・最後に観測した状態を並べ、追加・削除・上下移動・名前変更・トークン更新を操作できる。資格情報は「登録済み」と表示する。
- 最初は現在の単一Bearerを明示的に取り込み、必要な契約を追加して「優先切替を有効にする」（poolモード）。元の単一認証は残す。APIキーが環境変数にある場合はその優先を表示し、pool有効化を拒否する。
- 追加・更新は既存の公式`claude setup-token`フローか手動入力を使う。最小検証要求が枠を消費し得る旨を表示し、検証成功時だけ対象を保存する。失敗時は既存トークンを維持し、429は「現在検証できません」と表示する。同一トークンの重複登録は409。
- 保存後の新規要求から反映し、送信済み応答は続行する。削除確認には対象名と「提供元での失効ではない」を表示する。最後の1件も削除できるが、単一認証へ自動復帰しない。
- 状態は未確認・前回は利用成功・前回は枠切れ・再認証待ちを区別する。枠切れ表示でも次の通常要求で再試行する。曖昧な429を枠切れと表示しない。復帰は「従来の単一認証へ戻す」で明示的に行う。
- `GET/POST /setup/accounts`で一覧と構成操作（取込・名前変更・順序・削除・モード）を扱う。POSTは`expectedRevision`を受け、競合409、不正400、保存失敗503。並べ替えは現存IDの完全な順列とする。
- 既存`/setup/token`と`/setup/claude/{start,status,code,cancel}`を拡張し、poolでは追加先名または更新先ID/generation、revision、CLI試行IDを紐付ける。中止・削除・更新後に古い検証結果を適用しない。CLIは既存の1試行を維持し、URLが出なければ既存の手動手順へ案内する。
- 全入口で既存`isSetupRequestAllowed()`のloopback/許可CIDR制御を共有する。

## 3. 保存と通常の並行操作

- 新設`src/utils/accounts.ts`の`AccountStore`だけが構成・資格情報・観測状態を所有する。ファイルは絶対パスの`HERMIT_ACCOUNTS_FILE`、未指定なら`getAuthFilePath()`と同じディレクトリの`.hermit-accounts.json`。既存`.hermit-auth`は変更せず、新ファイルと一時ファイルをgitignoreへ追加する。
- 形式は`schemaVersion:1, revision, mode:legacy|pool, accounts:[]`。配列順だけを優先順位とし、各要素は`id, name, generation, authToken, appliedAt, observed`を持つ。`observed`は`state, reason, retryAt, retryBasis, failureCount`。retryAtはUnixミリ秒またはnull、retryBasisはprovider/local_probe/null。旧形式のlocal_probe・failureCountも読めるが選択には使わない。新規観測は提供元の時刻だけを記録し、不明ならnull、failureCountは0とする。
- 既存の0600・同一ディレクトリtemp→rename方式を再利用し、保存成功後だけ構成を公開する。失敗なら直前の構成を維持。ファイル破損は設定エラーとし、黙ってenvへ戻さない。最後の枠切れ観測・提供元の時刻・再認証待ちは再起動後も保持するが、枠切れや時刻で通常要求を抑止しない。
- 構成変更は直列化しrevisionを比較する。検証中はロックを保持せず、適用直前にrevision・対象generation・試行ID/中止を再確認する。トークン更新は対象generationだけを進め、対象clientと旧観測を破棄する。
- clientは`(id,generation)`の派生キャッシュとして、選択した資格情報を直接受け取る。削除済み/旧generationの応答は現在の状態へ反映せず、拒否前に送った要求の成功で後からの枠切れを解除しない。送信開始時の観測revisionと一致する成功だけが解除できる。
- 観測保存失敗でもプロセス内の拒否状態は保持し、`/setup`へ保存失敗を表示する。再起動で未保存の観測状態が失われ得る。表示用viewと通常エラーログにsecretを含めない。

## 4. 枠切れの判定と観測

`src/utils/rate_limit.ts`に分類を集約する。選択中のpool OAuth tokenの`APIError`で、HTTP429または構造化`error.error.type === "rate_limit_error"`、かつ次のいずれかだけを枠切れとする。

| 応答ヘッダーの完全一致 | 理由 |
|---|---|
| `anthropic-ratelimit-unified-7d-status: rejected` | weekly |
| `anthropic-ratelimit-unified-status: rejected`かつ`anthropic-ratelimit-unified-representative-claim`が`five_hour`または`seven_day` | sessionまたはweekly |

両方ならweekly。ヘッダー名は標準のcase-insensitive処理、値は完全一致で扱う。この条件以外の429は元のエラーを返す。

- reset候補は同じ枠拒否応答の`anthropic-ratelimit-unified-reset`だけ。整数Unix秒・安全整数・JS時刻に変換可能・`now < reset <= now + 8日`を満たす値をmsへ変換する。それ以外はreset不明として扱う。
- `rateLimitRetryAfter()`のdelta-seconds/HTTP-date解釈を共有し、安全な時刻へ変換する（過去は待機0、overflowは無効）。resetとRetry-Afterが両方有効なら遅い方を採用する。
- ユーザーの明示要件「毎回問い合わせる」に従い、保存された枠切れ・reset/Retry-Afterの期限に関係なく、通常要求ごとに優先順で問い合わせる。ローカル冷却・回復確認の占有・別途probeは設けない。
- 成功で利用成功の観測へ更新する。実際の枠拒否なら枠切れを観測して次へ進み、401は再認証待ち、曖昧429/通信失敗/403等は従来どおりその要求のエラーとして終了する。

## 5. 転送と終了条件

- 新設`src/utils/account_router.ts`は選択と試行制御だけを担当する。要求受付時の登録済み適格ID（再認証待ち以外）を優先順にsnapshotし、送信直前にも存在・generation・再認証待ちを確認する。保存された枠切れや未来のretryAtは除外条件にしない。途中追加は次要求から、未送信のトークン更新は新generationを使う。
- 各ID最大1回、snapshot件数以下の逐次送信で終了する。同じ要求の切替は**上流を開く前の明確な枠拒否だけ**。曖昧429は既存エラーと有効なRetry-Afterを即返し、後続要求は通常の優先選択を続ける。
- `auth.ts`のBearer builderを共有し、poolは明示token・`apiKey:null`・SDK `maxRetries:0`で作る。`chat.ts`の`convertRequest`/`buildAnthropicRequestWithTools`も同じ選択認証で作り、4経路（stream/nonstream×tools有無）を既存`streamMessage`と`accumulateMessage`へ合流させる。
- **上流HTTP200のstream取得成功、既存onOpen直前で使用契約を確定する**。以後の失敗はその要求のエラーとして終了する（下流未出力のnonstreamや直後のSSEエラーも同じ）。streamはエラーと`[DONE]`を各1回、nonstreamはエラーJSONを返す。
- 401は対象を再認証待ちとし、次の独立要求からskipする。403・要求不正・通信/timeout/5xxはその要求のエラーとして終了する。既存SDK timeoutと切断abortを維持し、poolのnonstreamにもabortを渡す。切断時は試行を終了する。
- 全枠切れは429 `rate_limit_exceeded`＋`reason:all_accounts_exhausted`と全件に提供元の時刻がある場合だけ最短時刻までのRetry-After。空/全再認証待ち/混在は503 `credentials_unavailable`、構成破損は503 `credential_config_error`。選べる登録がない理由を明示する。
- poolのpre-open失敗はstream要求でもHTTPエラー＋JSONで返す（通信/5xxは503、timeoutは504、上流401は503）。open後のSSEはstatusを変えず終了する。既存legacyのエラー形式・SDK retry、Bonsai、`/health`は維持する。

## 6. 互換性・復帰

ファイル無し/`mode=legacy`は従来の`resolveAuth()`（API key > env token > none）。有効なpoolでも環境APIキーを優先し、その状態を表示する。壊れたpoolファイルは設定エラーを優先する。
「従来の単一認証へ戻す」は`mode=legacy`を保存し、保持した元の認証へ次要求から戻す。元トークンが失効済みなら再認証が必要。ファイル破損時はpoolファイルを退避して旧成果物/起動設定へ戻せる。

## 7. 受入チェックリスト（未実施）

`/setup`登録→保存→chatをfake token・localhost上流で確認する。

| 条項 / production seam | 受入証拠 |
|---|---|
| §2 `setup.ts`, `server.ts`, `setup_token_flow.ts` | 1/2/4件の追加・順序・削除・更新がchatへ反映。失敗更新/中止/競合で誤適用なし。既存アクセス制御を維持 |
| §3 `accounts.ts`, `auth.ts` | 保存・再読込・保存失敗時の旧構成維持、並行選択の認証一致、古い応答が新状態を上書きしない |
| §4 `rate_limit.ts`, `account_router.ts` | 完全一致だけ切替。旧保存形式の未来retryAtがあってもA拒否→B拒否、次要求でA拒否→B成功。状態リセット・再認証・別probeなし |
| §5 `chat.ts`の`streamMessage` | 4経路で順次切替、各ID1回、全不可の明確なエラー。曖昧429/上流open後/切断後は次試行なし |
| §6 `resolveAuth()`, `chat.rate-limit.test.ts`, `/setup` | 単一トークン・APIキー優先・既存503 retryを維持し、同じ画面からlegacyへ復帰可能 |

## 根拠と未確認

現行seamは[調査基点ed081e0](https://github.com/kojira/hermit-shell/tree/ed081e0ee68bd1731050d41a5507329ae90fd828/src)で確認。判定根拠は[運用Issue #1](https://github.com/kojira/hermit-shell/issues/1)、[Claude Code #104690](https://github.com/anthropics/claude-code/issues/104690)・[#103820](https://github.com/anthropics/claude-code/issues/103820)の報告（参考: [公式APIの429](https://platform.claude.com/docs/en/api/rate-limits)）。実契約の生応答による切替・回復は未検証。未知ヘッダーの場合は元のエラーを返す。
[提供元の利用条件](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)には第三者アプリによるサブスク資格情報の仲介制限が記載されている。
