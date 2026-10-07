# tools/pms — 進行役(操作の記録・タスクキュー・カード・提出の検査)

手順版 proc-v017 で入れた(`docs/94_改訂指示/01_共通の土台.md`、段1)。手順書側の規約は `procedure/00_common.md` ■進行役と記録の道具 と `procedure/stages.md` §10 フェーズA にある。本書は、段2以降の改訂を行うセッションが読む**仕様書**である(内部の構成・データの形・判断の根拠)。

- Node.js 18 以上だけで動く(外部パッケージなし)。playwright-cli を呼ぶのは `pms act` だけ
- テスト: `node --test tools/pms/test/`(playwright-cli と環境情報は偽物に差し替える。`test-support/`)
- 入口: `node tools/pms/pms.mjs <サブコマンド>`。使い方は `--help`(ファイル先頭のコメント)

## 1. サブコマンド

| コマンド | すること | 標準出力 | 終了コード |
|---|---|---|---|
| `queue build --flow F --phase A [--scenarios SC-…,…]` | 対象シナリオの `requires` からフェーズAのカードを作る(3章)。初期状態セット外の状態と `S-CLEAN-ENV` は、その場で setup-log(と申し送り台帳)に書く | `{ok, flow, phase, cards[], auto[], warnings[], next}` | 0 / 2(キューが既にある・対象シナリオがない など) |
| `next --flow F` | 次のカードを出す(4章) | `{state: "card", card, kind, state_id, issued_count, card_file, out_file, now, body, next}` / `{state: "done", passed, stopped[], message, next: null}` / `{state: "STOP", card, reason, message, remaining, next}` | 0(カード・done)/ 3(STOP)/ 2 |
| `act --flow F --card C [--intent "…"] <操作> [引数…]` | 画面操作を1回実行し、act-log に1行書く(2章) | `{ok, seq, action, locator, locator_class, unique, url_after, error, warnings[], now, next, hint}`。`snapshot` は画面の内容のあとに `--- pms ---` の行と同じ JSON | 0 / 1(操作の失敗・assert の不成立)/ 2 |
| `submit --flow F --card C [--file …]` | 出力を検査し、合格なら記録を書く(5章) | 合格 `{ok: true, card, result, status, wrote[], next, hint}` / 不合格 `{ok: false, card, attempt, rejections, stopped, failures[{category, message, fix}], next, hint}` | 0(合格。`cannot_proceed` の受け付けを含む)/ 1(不合格)/ 2 |
| `status --flow F [--json]` | 現在のカード・枚数・STOP の理由・pms が記録した状態・警告 | `--json` なら JSON、なければ人間向けの文 | 0 / 2 |
| `reopen --flow F --card C` | (人間が使う)STOP のカードを `pending` に戻し、出した回数・不合格の回数を 0 にする | `{ok, flow, card, status, next}` | 0 / 2 |

- 共通: `--root <dir>`(既定はこのスクリプトの2階層上)。時刻は環境変数 `PMS_NOW` で固定できる(テスト用)
- 使い方・設定の誤りは、標準出力に `{ok: false, error}`、標準エラー出力に `ERROR: …`、終了コード 2
- **`process.exit` を使わない**(`process.exitCode` を使う)。大きな出力(カードの本文)をパイプに書いた直後に `exit` すると、出力が途中で切れるため

## 2. `pms act`

### 2.1 操作

操作の名前は `vocab.pms_act_action` が正(vocab にない操作は終了コード 2)。呼び出し方は `config/pms.json` の `ops`(既定は `lib/config.mjs` の `DEFAULT_OPS`)。

| 操作 | 引数 | playwright-cli の呼び出し(既定) | setup-log の step |
|---|---|---|---|
| `open` | `<URL|<env:キー>>` | `-s=F open <URL> --idle-timeout=0`(`open_args`)。初回に `--version` も呼び、記録に `cli_version` を残す | `goto`(`detail`) |
| `goto` | 同上 | `-s=F goto <URL>` | `goto`(`detail`) |
| `snapshot` | なし | `-s=F snapshot` | なし |
| `click` `dblclick` `check` `uncheck` `hover` | `<ref>` | `-s=F <操作> <ref>` | 同名(`locator`) |
| `fill` `select` | `<ref> <値|<env:キー>>` | `-s=F <操作> <ref> <値>` | 同名(`locator`・`value`) |
| `type` `press` `upload` | `<ref> <値|<env:キー>>` | `-s=F run-code "async page => { await page.<ロケータ>.<pressSequentially|press|setInputFiles>(<値>); }"`(playwright-cli の画面操作が要素参照を取らないため。ロケータを記録に残せる) | 同名(`locator`・`value`) |
| `assert` | `<ref> visible|hidden|text "<文言>"` | `run-code` で `isVisible()` / `textContent()` を評価 | なし(`established_check` の元) |
| `ext` | `--op <操作ID> -- <実行体の呼び出し…>` | 実行体を直接起動(playwright-cli は呼ばない) | `external`(`operation_id`) |

要素の操作と `assert` は、**操作の前に** `generate-locator <ref>` でロケータを取り(操作のあとは画面が変わり ref が無効になることがある)、`run-code` の `count()` で一意かを確かめる。ロケータの区分(`vocab.locator_class`)は `lib/cli.mjs` の `classifyLocator`: 呼び出しの連なりが `getByRole`・`getByLabel`・`getByPlaceholder`・`getByText`・`getByTestId` だけなら `stable`、それ以外(`locator(…)`・`nth`・`first` など)は `css`。

`css` または `unique: false` のときは、`warnings` に「別の要素で操作し直すか、00 ■ロケータ規約の6(CSS の暫定使用と testid-requests への記録)に従う」を返す(操作そのものは実行する)。

### 2.2 記録(`work/<feature_code>/exploration/act-log.jsonl`、1操作1行)

```json
{"flow":"F-003","seq":5,"card":"C-0001","state_id":"S-ADMIN-LOGIN","action":"click","ref":"e7",
 "locator":"getByRole('button', { name: 'ログイン' })","locator_class":"stable","unique":true,"value":null,
 "intent":"ログインする","code":"await page.getByRole('button', { name: 'ログイン' }).click();",
 "url_before":"https://…/login","url_after":"https://…/menu",
 "started_at":"2026-10-07T10:00:00+09:00","ended_at":"2026-10-07T10:00:01+09:00","ok":true,"error":null}
```

- `seq` はフロー内の連番(キューの `features` の全 act-log の、そのフローの行の最大 + 1)。`snapshot` と失敗した操作にも振る
- `code` は playwright-cli の出力の「Ran Playwright code」があればそれ、なければ pms がロケータと操作から作る(値は伏せた形)。`setup.code` のカードの下書きに使う
- `url_before` は同じフローの直前の記録の `url_after`。`url_after` は出力の `Page URL:`、なければ `run-code` の `page.url()`
- `assert` は `assert: {condition, text}`、`ext` は `operation_id`・`exit_code`・`output`(JSON なら解析したもの)、`open` は `cli_version` を足す
- 操作に失敗しても記録する(`ok: false`・`error`)

### 2.3 値を伏せる

`<env:キー>` は `node tools/env/env.mjs get <キー> --reveal`(pms と同じ `tools/` の下の env.mjs を `--root` 付きで呼ぶ。`config/pms.json` の `env_cli` で差し替えられる)で取り出して操作に使い、**記録・標準出力では `<env:キー>` と書く。** 伏せる値は、その操作で取り出した値と、環境情報の全環境の秘密情報(kind `secret`。`tools/env/lib/environments.mjs` で読む)。playwright-cli の出力(fill の値がそのまま出る)と snapshot(入力済みの欄の値が出る)も伏せてから返す。3文字未満の値はほかの文字列と取り違えるため伏せず、警告を返す(`store.mjs` の `MIN_MASK_LENGTH`)。

### 2.4 `now` と `next`

`act` と `next` の出力には毎回 `now`(`flow`・`card`・`kind`・`state_id`・`todo`)と `next`(次に実行すべきコマンド1つ)を付ける。会話が長くなったり要約されたりしても、AIが道具の出力から現在地を取り戻せるようにするためである(docs/004 7章の④)。`next` は、失敗のあと・操作のあとは `snapshot`、`assert` の成功のあとは `submit`。

## 3. タスクキュー(`work/_flows/F-<番号>/queue.json`)

```json
{
  "flow_id": "F-003", "phase": "A", "procedure_version": "proc-v017", "created_at": "…",
  "features": ["PRT"],
  "scenarios": [{"id": "SC-PRT-01", "feature": "PRT", "requires": ["S-ADMIN-LOGIN"]}],
  "cards": [
    {"id": "C-0001", "kind": "setup.build", "state_id": "S-ADMIN-LOGIN", "feature": "PRT", "scenarios": ["SC-PRT-01"],
     "status": "issued", "issued_count": 1, "rejections": 0, "submits": 0, "created_at": "…", "issued_at": "…",
     "rebuild": null, "reuse": null}
  ],
  "auto": [{"state_id": "S-JOBLOG-EXISTS", "classification": "blocked", "reason": "初期状態外", "handoff": "HO-PRT-001"}],
  "warnings": ["…"],
  "history": [{"at": "…", "card": "C-0001", "event": "issued"}]
}
```

- カードの状態は `vocab.pms_card_status`(`pending` / `issued` / `passed` / `stopped`)。起動時に `lib/store.mjs` の `CARD_STATUS` と照合する
- `stopped` のカードは `stop: {reason, at, reported}` を持つ。`passed` は `passed_at`・`result`
- `setup.reuse` は `reuse: {flow_id, feature, setup_log}`(流用元)。作り直しの `setup.build`・`setup.code` は `rebuild: {reason: "broken" | "old_record", flow_id, fixture, flow, reuse_card?}`。`setup.code` は `build_card`

### 3.1 `queue build --phase A` の規則(AIに選ばせない)

1. 対象シナリオ: scenarios.md の「策定方式」の行にそのフローIDを書いたシナリオ(このフローで作ったもの)。`--scenarios` を渡したときはそのシナリオ(再探索フロー・パートPのように前のフローのシナリオを扱うとき)。`requires` を書いた順に重複を除く。**blocked になりそうなシナリオの requires も除かない**
2. 状態ごとに:
   - 初期状態セット(`vocab.initial_state_set` と、状態需要リストの `採用` / `整備済`)にない → カードにしない。setup-log に `classification: blocked`・`blocked_by: {reason: 初期状態外, handoff}` を書き、申し送り台帳に行を足し、`warnings` に残す
   - `S-CLEAN-ENV`(`queue.mjs` の `RESTORE_STATES`)→ カードにしない。工程0の復元そのものなので `classification: provided`・`provided_by` を書く(lint の `requires_covered` が fixture を求めないのと同じ扱い)
   - 過去のフローの setup-log に、同じ `state_id` の `built-by-ui`(または `reused_from` のある `provided`)で `verified: true`、fixture のファイルがあるエントリ → 最も新しいフローのものを流用元にする。流用元の `steps` がすべて揃い安定なら `setup.reuse`、そうでなければ `setup.build`(`rebuild.reason: old_record`)
   - それ以外 → `setup.build`
3. `setup.code` は、同じ状態の `setup.build` が `built` で合格したときにキューの最後に足す
4. `setup.reuse` が `broken` で合格したら、作り直しの `setup.build`(`rebuild.reason: broken`)をキューの最後に足す。その `setup.code` は既存の fixture・部品と同じ名前でなければ不合格(`code_mismatch`)

キューは作り直さない(`queue build` を2回呼ぶと終了コード 2)。

## 4. `next` の規則

1. 出したままのカード(`issued`)があれば、同じカードをもう一度出す。本文の先頭に「前回は提出されなかった(n 回目)」と、そのカードで記録済みの操作の連番を添える。ただし出した回数が `max_issues`(既定 3)に達していれば、出さずに `stopped` にする
2. まだ伝えていない `stopped` のカードがあれば、`STOP`(終了コード 3)を返す。1回伝えたら `reported: true` にし、次の `next` からは残りのカードを続ける(人間が続けてよいと答えたあと、残りを止めないため)
3. `pending` のカードがあれば、作った順に1枚出す(本文を `cards/C-<番号>.md` に保存)
4. どれもなければ `done`(`stopped` の一覧を添える)

## 5. `submit` の検査と記録

検査の区分は `vocab.pms_reject_kind`。不合格の理由には区分ごとの直し方1行(`lib/checks.mjs` の `FIX`)を付ける。合否は毎回 `submit-log.jsonl` に書く(`{at, card, kind, state_id, attempt, issued_count, ok, result, categories[]}`。段2の計測に使う)。不合格が `max_rejections`(既定 3)に達したらカードを `stopped` にする。

| 区分 | 検査 | カード |
|---|---|---|
| `schema` | ファイルがある・JSON・`procedure/schemas/<種類>.out.json`(`lib/schema.mjs`。`x-vocab` は vocab のキーの値) | 全部 |
| `red_flag` | あいまい語(`vocab.pms_vague_words`。コマンド・所在・時刻の欄は見ない)、schema の長さの違反、`禁止操作` なのに禁止IDがない、`操作手段なし` なのに `ext_demand` がない、実行の時刻がカードを出す前 | 全部 |
| `seq_missing` | 連番が act-log にある・このカードの記録・`ok: true`・step のある操作・増える順。`established_check_seq` は同じカードの成功した `assert` で、最後の操作より後。`fragile` の連番は `seqs` の中 | build |
| `unstable_locator` | `seqs` と established check のロケータが `unique: true`。`css` は `fragile` に挙げ、`work/_common/testid-requests.md` にロケータ(または `locator('…')` の中のセレクタ)があるときだけ認める | build |
| `lint` | 書く予定のエントリに、lint の規則 `setup_steps_recorded`・`no_temp_locator` を当てる(規則の関数を直接呼ぶ)。秘密情報の値がない(`env_value_leak` と同じ基準)。ほかの区分に違反がないときだけ当てる | build |
| `code_mismatch` | `flow`・`fixture` のファイルが `tests/` にあり名前が現れる。setup-log の各 step のロケータと established check のロケータが、部品・fixture と、そこから相対 import したファイル(1段。ページオブジェクト)のコードに現れる(空白・引用符・先頭の `page.` をそろえて比べる)。ログイン状態なら起動確認テストがある。作り直しなら名前が同じ | code |
| `runs` | `setup.code` は2回、`setup.reuse` は1回。時刻の形。`reused` は終了コード 0、`broken` は 0 以外 | code・reuse |
| `reuse_source` | 流用元のエントリと fixture のファイルが今もある | reuse |

部品のファイルの中の順序は確かめていない(部品がページオブジェクトを呼ぶ形では、部品のファイルに操作の順にロケータが並ばないため)。

### 5.1 合格したら書くもの

| カード・結果 | 書くもの |
|---|---|
| build `built` | setup-log に `built-by-ui`: `steps`(記録から。`fragile` の連番は step に `fragile: <理由>`)・`established_check`(assert の記録から「<ロケータ> が表示される」など)・`act: {card, seqs, established_check_seq}`・`flow: ''`・`fixture: ''`・`verified: false`。作り直しなら `notes` に記す。キューに `setup.code` を足す |
| build `blocked` | 申し送り台帳に1行(対象「前提状態 <状態ID> の整備: <内容>」・理由コード・引き継ぎ先は `vocab.reason_code` の `default_dest`・想定手段は需要IDか禁止ID・発生元「<フローID> / 作業10 / <状態ID>(<シナリオID>)」)。`操作手段なし` なら外部操作需要リストに1行、または同じ外部操作と操作対象の行の要求元に追記。setup-log に `blocked` と `blocked_by` |
| `cannot_proceed`(全種類) | 記録しない。カードを `stopped` にする(次の `next` が STOP を返す) |
| reuse `reused` | setup-log に `provided`: `steps`・`flow`・`fixture`・`established_check`・`cleanup` を流用元からそのまま写し、`reused_from: {flow_id, feature_code}`・`verified: true` |
| reuse `broken` | setup-log には書かない。作り直しの `setup.build` を足す |
| code `coded` | setup-log の同じエントリの `flow`・`fixture`・`cleanup`・`verified`(2回とも終了コード 0 のときだけ true)。`verified: true` で状態需要リストの行が `採用` なら `整備済` にし fixture を書く |

### 5.2 台帳の部品(`lib/ledgers.mjs`。段2以降も使う)

- `appendHandoff` / `peekHandoffId` / `recordExtDemand` / `stateDemandRow` / `adoptedStates` / `markStateProvisioned`
- 表は記入用テンプレートの「## 台帳」の表(列の名前で書く)。ファイルがなければテンプレート(`procedure/templates/91_`・`93_`・`96_`)を写して作り、テンプレートの空の行は最初の行を足すときに外す
- 採番は「## 台帳」の表の中の最大 + 1(`HO-<機能コード>-<3桁>`・`EXT-<3桁>`)。記入例の節は数えない
- 書くのは事実の欄だけ(優先度・採否・整備記録など人間の欄には書かない)

### 5.3 setup-log の書き方(`lib/setup-log.mjs`)

1つのファイルに複数のフローの文書(`---` 区切り)があってよい。対象のフローの文書だけを書き直し(なければ末尾に足す)、文書の中では `state_id` ごとにエントリを置き換える。ほかのフローの文書の内容は変えない。YAML の出力は `lib/yaml-write.mjs`(二重引用符のスカラー・`|` のブロックスカラー。`tools/lint/lib/yaml-lite.mjs` で読み戻せる範囲)。

## 6. カード(`procedure/cards/<種類>.md`)と規則の差し込み(`lib/procedure.mjs`)

| 差し込み | 中身 |
|---|---|
| `{{名前}}` | pms が埋める入力(状態ID・定義・状態需要リストの行・established check の案・KB の該当ページ(`kb/00_索引.md` と状態IDを含む `kb/` のファイル)・現在の画面の URL(直前の記録の `url_after`)・環境情報のキー(`env.mjs list` のキーと種類。値は出さない)・作り直しの説明・出し直しの説明・提出のコマンドなど。`lib/queue.mjs` の `cardVars`) |
| `{{rule:R-XXX-n}}` | `procedure/00_common.md`・`procedure/stages.md` で `**[R-XXX-n]**` を付けた行(箇条書きの記号と目印を外し `- [R-XXX-n] …` にする。表の行は「1列目: 残りの列」)。同じ規則IDが2箇所にあれば終了コード 2 |
| `{{protected:ID}}` | 保護ブロックの本文を、文言を変えずにブロックごと(00 → stages の順に探す) |
| `{{vocab:キー}}` | 統制語彙の一覧(値の意味つき) |
| `{{schema}}` | 出力の schema の各欄の表(必須・許される値・内容) |

埋められない差し込みは終了コード 2(テンプレートの誤り)。この段で規則IDを付けたのは、3種類のカードが使う規則だけである(R-PMS・R-SETB・R-SETC・R-SETR・R-LOC・R-STA・R-PRT・R-PO・R-DAT・R-ENV)。

カードの種類を足すとき: `vocab.pms_card_kind` に足し、`procedure/cards/<種類>.md` と `procedure/schemas/<種類>.out.json` を置き、`lib/submit.mjs` に検査と記録を、`lib/queue.mjs` に `TODO` と入力を足す。

## 7. 設定(`config/pms.json`。見本 `config/pms.sample.json`。git に入れない)

| キー | 既定 | 内容 |
|---|---|---|
| `playwright_cli` | `["playwright-cli"]` | playwright-cli の呼び出し方(コマンドの配列) |
| `playwright_cli_version` | null | 想定する版。`open` のときに `--version` と比べ、違えば警告 |
| `session_arg` | `-s={session}` | セッション名の引数(`{session}` はフローID) |
| `open_args` | `["--idle-timeout=0"]` | `open` に足す引数 |
| `env_cli` | null | 環境情報の実行体(`get <キー> --reveal` を足して呼ぶ)。null なら `node tools/env/env.mjs --root <root>` |
| `max_issues` | 3 | 同じカードを出す回数の上限 |
| `max_rejections` | 3 | 同じカードの不合格の回数の上限 |
| `ops` | `{}` | 操作ごとの呼び出しの上書き(`{"press": {"cli": ["press", "{value}"]}}` など。`{ref}` `{value}` `{js_value}` `{locator}` を置き換える。`cli` か `run_code` のどちらか) |

ファイルがなければ既定の値で動く。知らないキーは終了コード 2。

## 8. 実物の playwright-cli で確かめていないこと

テストは偽物の playwright-cli(`test-support/stub-playwright-cli.mjs`)で行っている。次の前提は docs/94 §9(`@playwright/cli 0.1.22`)に基づくが、実物で確かめていない。違っていたら `config/pms.json` で直せるようにしてある(直せないものは `lib/cli.mjs` を直す)。

- `generate-locator <ref>` の出力の行にロケータがある(`page.` があってもよい)
- `run-code "async page => { … }"` の結果が「### Result」の次の行、または最後の行に出る
- 操作の出力に `Page URL: …` と「Ran Playwright code」のコードブロックが出る(なければ `page.url()` を評価し、コードは pms が作る)
- `open` が `--idle-timeout=0` を受け付ける
