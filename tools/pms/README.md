# tools/pms — 進行役(操作の記録・タスクキュー・カード・提出の検査・セッションの起動・報告書の生成)

手順版 proc-v017 で入れ(`docs/94_改訂指示/01_共通の土台.md`、段1)、proc-v018 でパートCのカード・`pms run`・`pms report`・`pms stats` を加えた(`02_スクリプト実行.md`、段2)。proc-v019 で IDE 内のループ(B1。入口のエージェント `pms-runner`)のために `next` の出力にエージェントの名前と依頼文を足した(`03_IDE内ループ.md`、段3。14章)。proc-v021 でカードを使わない作業の画面操作のために `pms pwcli` を足した(2.5)。proc-v024 で DB への SELECT のために `pms db` を足した(2.7)。手順書側の規約は `procedure/00_common.md` ■進行役と記録の道具 と `procedure/stages.md` §10 フェーズA・パートC にある。本書は、後の段の改訂を行うセッションが読む**仕様書**である(内部の構成・データの形・判断の根拠)。

- Node.js 18 以上だけで動く(外部パッケージなし)。playwright-cli を呼ぶのは `pms act` と `pms pwcli` だけ、sqlcmd を呼ぶのは `pms db` だけ、AI の CLI を呼ぶのは `pms run` だけ
- テスト: `node --test tools/pms/test/`(playwright-cli・AI の CLI・環境情報は偽物に差し替える。`test-support/`。カードを行うAIの代わりは `test-support/explore-agent.mjs`)
- 入口: `node tools/pms/pms.mjs <サブコマンド>`。使い方は `--help`(ファイル先頭のコメント)

## 1. サブコマンド

| コマンド | すること | 標準出力 | 終了コード |
|---|---|---|---|
| `queue build --flow F --phase A\|C\|all [--scenarios SC-…,…]` | A: 対象シナリオの `requires` からフェーズAのカードを作る(3章)。初期状態セット外の状態と `S-CLEAN-ENV` は、その場で setup-log(と申し送り台帳)に書く。C: パートCのカードを1ラウンド分作る(9章)。`stage10-context.json` が要る | `{ok, flow, phase, cards[](今回足したカード), auto[], warnings[], next}` | 0 / 2(フェーズAが既にある・パートCのカードが残っている・対象シナリオがない・stage10-context.json がない など) |
| `next --flow F [--phase A\|C] [--brief]` | 次のカードを出す(4章)。`--brief` は本文(`body`)を出さない(14章) | `{state: "card", card, kind, state_id, target, issued_count, card_file, out_file, agent, prompt, now, body, next}` / `{state: "done", passed, skipped, stopped[], message, next}` / `{state: "STOP", card, kind, target, code, reason, message, remaining, next}` | 0(カード・done)/ 3(STOP)/ 2 |
| `run --flow F [--phase A\|C\|all] [--runner 名前] [--max-cards N] [--dry-run]` | カードを1枚ずつ新しいAIのセッションで行わせる(10章) | `{state: "done", sessions[], report, lint}` / `{state: "STOP", card, code, reason, message, sessions[]}` / `{state: "paused"}` / `{state: "error", error}` / `{state: "dry-run", card, command[], stdin, timeoutSec}` | 0(全部終わった)/ 3(STOP。lint 止まりを含む)/ 1(実行の失敗)/ 4(`--max-cards` で止めた)/ 2 |
| `report --flow F [--dod-unmet "<理由>"]` | 報告書と status.yaml を記録から作る(11章) | `{ok, flow, wrote[], summary[], next}` | 0 / 2(カードが終わっていない) |
| `stats [--flow F \| --since YYYY-MM-DD] [--json]` | カードの合格率などを集計する(12章) | `--json` なら `{flows, since, by_kind[], records}`、なければ表 | 0 / 2 |
| `act --flow F --card C [--intent "…"] <操作> [引数…]` | 画面操作を1回実行し、act-log に1行書く(2章) | `{ok, seq, action, locator, locator_class, unique, url_after, error, warnings[], now, next, hint}`。`snapshot` は画面の内容のあとに `--- pms ---` の行と同じ JSON | 0 / 1(操作の失敗・assert の不成立)/ 2 |
| `pwcli [--session 名前] -- <playwright-cli の引数…>` | カードを使わない作業の画面操作。`<env:キー>` を値に置き換えて playwright-cli に渡し、値を伏せた出力を返す。`--flow` は要らず、記録は書かない(2.5) | playwright-cli の出力(値を伏せたもの)。標準エラー出力があれば `--- stderr ---` の行のあとに続ける | 0 / 1(playwright-cli が 0 以外で終わった)/ 2(`--` がない・環境情報がない など) |
| `db [--flow F --card C --intent "…"] -- "<SELECT 文>"` / `db --check [--flow F]` | DB に SELECT を1つ実行する。接続先・ログイン・証明書は環境情報から決め、実行の前に接続先を確かめる。カードを付ければ db-log に1行書く(2.7) | `{ok, settings, target, sql, rows, output, truncated, reason, error}`(カードを付ければ `now, next, hint` も)/ `--check` は `{ok, check, settings, target, reason, error}` | 0 / 1(環境情報の不足・接続の失敗・接続先の違い・SELECT の失敗。`reason`)/ 2(SELECT 以外の文・使い方の誤り) |
| `submit --flow F --card C [--file …]` | 出力を検査し、合格なら記録を書く(5章) | 合格 `{ok: true, card, result, status, wrote[], next, hint}` / 不合格 `{ok: false, card, attempt, rejections, stopped, failures[{category, message, fix}], next, hint}` | 0(合格。`cannot_proceed` の受け付けを含む)/ 1(不合格)/ 2 |
| `status --flow F [--json]` | 現在のカード・枚数・STOP の理由・pms が記録した状態・警告・`complete`・`report_pending`(パートCのカードが全部終わったのに、そのあとで `pms report` をしていない。14章) | `--json` なら JSON、なければ人間向けの文 | 0 / 2 |
| `reopen --flow F --card C` | (人間が使う)STOP のカードを `pending` に戻し、出した回数・不合格の回数を 0 にする。続けて止めた後続のステップ(`chained_from`)も戻す | `{ok, flow, card, reopened[], status, next}` | 0 / 2 |

- 共通: `--root <dir>`(既定はこのスクリプトの2階層上)。時刻は環境変数 `PMS_NOW` で固定できる(テスト用)。環境変数 `PMS_RUNNER`(`vocab.pms_runner`。未設定は `b1`。IDE のチャットの端末では設定されない)を提出の記録と出したカードの履歴に残す
- 使い方・設定の誤りは、標準出力に `{ok: false, error}`、標準エラー出力に `ERROR: …`、終了コード 2
- **`process.exit` を使わない**(`process.exitCode` を使う)。大きな出力(カードの本文)をパイプに書いた直後に `exit` すると、出力が途中で切れるため

## 2. `pms act`

### 2.1 操作

操作の名前は `vocab.pms_act_action` が正(vocab にない操作は終了コード 2)。呼び出し方は `config/pms.json` の `ops`(既定は `lib/config.mjs` の `DEFAULT_OPS`)。

| 操作 | 引数 | playwright-cli の呼び出し(既定) | setup-log の step |
|---|---|---|---|
| `open` | `<URL|<env:キー>>` | `-s=F open <URL> --idle-timeout=0 --config=<config/playwright-cli.json の絶対パス>`(`open_args` と `browser_config`。2.6)。初回に `--version` も呼び、記録に `cli_version` を残す | `goto`(`detail`) |
| `goto` | 同上 | `-s=F goto <URL>` | `goto`(`detail`) |
| `snapshot` | なし | `-s=F snapshot` | なし |
| `click` `dblclick` `check` `uncheck` `hover` | `<ref>` | `-s=F <操作> <ref>` | 同名(`locator`) |
| `fill` `select` | `<ref> <値|<env:キー>>` | `-s=F <操作> <ref> <値>` | 同名(`locator`・`value`) |
| `type` `press` `upload` | `<ref> <値|<env:キー>>` | `-s=F run-code "async page => { await page.<ロケータ>.<pressSequentially|press|setInputFiles>(<値>); }"`(playwright-cli の画面操作が要素参照を取らないため。ロケータを記録に残せる) | 同名(`locator`・`value`) |
| `assert` | `<ref> visible|hidden|text "<文言>"` | `run-code` で `isVisible()` / `textContent()` を評価 | なし(`established_check` の元) |
| `ext` | `--op <操作ID> -- <実行体の呼び出し…>` | 実行体を直接起動(playwright-cli は呼ばない) | `external`(`operation_id`) |
| `screenshot` | `[ref]` | `-s=F screenshot [ref] --filename=<絶対パス>`(`screenshot_args`)。保存先は `work/<機能>/exploration/evidence/<ステップID か 状態ID>_<連番>.png`。ファイルができなければ失敗 | なし(探索記録の `evidence` の元) |

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
- `assert` は `assert: {condition, text}`、`ext` は `operation_id`・`exit_code`・`output`(JSON なら解析したもの)、`open` は `cli_version`、`screenshot` は `evidence`(`evidence/<名前>.png`)を足す。探索のカードの記録には `step_id` を足す
- `pms act` を使えるのは `setup.build` と `explore.step` のカード(`lib/queue.mjs` の `ACT_KINDS`)
- 操作に失敗しても記録する(`ok: false`・`error`)

### 2.3 値を伏せる

`<env:キー>` は `node tools/env/env.mjs get <キー> --reveal`(pms と同じ `tools/` の下の env.mjs を `--root` 付きで呼ぶ。`config/pms.json` の `env_cli` で差し替えられる)で取り出して操作に使い、**記録・標準出力では `<env:キー>` と書く。** 伏せる値は、その操作で取り出した値と、環境情報の全環境の秘密情報(kind `secret`。`tools/env/lib/environments.mjs` で読む)。playwright-cli の出力(fill の値がそのまま出る)と snapshot(入力済みの欄の値が出る)も伏せてから返す。3文字未満の値はほかの文字列と取り違えるため伏せず、警告を返す(`store.mjs` の `MIN_MASK_LENGTH`)。

### 2.4 `now` と `next`

`act` と `next` の出力には毎回 `now`(`flow`・`card`・`kind`・`state_id`・`todo`)と `next`(次に実行すべきコマンド1つ)を付ける。会話が長くなったり要約されたりしても、AIが道具の出力から現在地を取り戻せるようにするためである(docs/004 7章の④)。`next` は、失敗のあと・操作のあとは `snapshot`、`assert` の成功のあとは `submit`。

### 2.5 `pms pwcli`(カードを使わない作業の画面操作。`lib/pwcli.mjs`)

作業01・02・15・20・30 と作業10のカード以外の工程(00 ■進行役と記録の道具)は、カードがないため `pms act` を使えない。proc-v020 までは playwright-cli を直接呼ぶとしていたが、それではログインのパスワードを入力するのに、AIが値を `env.mjs get --reveal` で取り出してコマンドに書くしかなく、値が会話・コマンドの履歴・playwright-cli の出力に残る(作業02のAIが fill を使えず止まった。proc-v021)。`pms pwcli` は、`pms act` の値の扱い(2.3)だけを取り出したものである。値の置き換えは `pms act` と同じ `lib/cli.mjs` の `resolveEnvArg`、伏せるのは同じ `lib/store.mjs` の `secretsToMask`・`mask`、playwright-cli の呼び出しは同じ `PlaywrightCli` を使う(伏せ方を片方だけ直すことがないように、部品を分けない)。

- 引数は `--` の後ろをそのまま playwright-cli に渡す。`<env:キー>` だけの引数を `env.mjs get --reveal` の値に置き換える(`act` と同じく引数の一部だけの置き換えはしない)
- 出力(標準出力と標準エラー出力)から、置き換えた値と全環境の秘密情報を伏せる(2.3 と同じ `mask`)
- `--session <名前>` があれば `session_arg` の形で渡す。なければセッションを指定しない(playwright-cli の既定のセッション。AIが直接呼んだ playwright-cli と同じブラウザを使える)
- カード・フロー・act-log・キューに触らない。ロケータの記録もしない(カードを使わない作業は、KB や報告書に自分で書く。KB に書く操作列では値を `<env:キー>` と書く。00 R-ENV-1)
- 先頭の引数が `open` なら、`pms act` と同じく `browser_config`(locale の既定値は `ja-JP`)を `--config=<絶対パス>` で足す(2.6)。`--config` を自分で書いたときは足さない
- `pms run` が起こすカードのセッションでは使用禁止にする(`procedure/cards/agents.yaml` の `deny_shell`、`config/pms.sample.json` の `runner.copilot.deny`)。カードの画面操作は記録の残る `pms act` に限るため

### 2.7 `pms db`(DB への SELECT。`lib/db.mjs`)

F-001 の `pms run` で `explore.close` のカードが「DB不変条件の検査に必要な認証確認とSELECTを実行できなかった」として `cannot_proceed` で止まった。カードの AI が DB の接続先を知るために `node tools/env/env.mjs get db.server` を実行し、`pms run` の使用禁止 `shell(node tools/env/env.mjs get:*)` に当たって拒否された。カードの「DB の接続」の行(9.4)は proc-v023 までサーバ証明書の扱いしか書いておらず、接続先とログインを知る手段がカードになかった(proc-v024)。`pms db` は、DB への SELECT を `pms act` と同じ「道具が値を扱い、AI は値を知らない」形にしたものである。

- 文は `--` の後ろの1つの引数(`selectOnly`)。コメント・文字列・区切った識別子(`[…]`・`"…"`)を除いてから調べ、`SELECT` か `WITH` で始まる文を1つだけ受け付ける。`;` で文をつなぐもの・`INSERT`・`UPDATE`・`DELETE`・`MERGE`・DDL・`EXEC`・`INTO`(SELECT INTO)・`DECLARE`・`SET`・トランザクションの操作・`OPENROWSET` など(`FORBIDDEN`)・`xp_` / `sp_` の手続き・sqlcmd のコマンド(行頭の `:`・`!!`)・`GO`・sqlcmd の変数 `$(…)` は終了コード 2。列名がこれらの語と同じなら `[ ]` で囲む
- 設定(`dbSettings`)は、フローの環境(最後のラウンドの `stage10-context.json` の `environment`。なければ env.mjs と同じ選び方)の環境情報から読む。`db.trust_server_certificate`・`db.auth` は `vocab.env_optional_keys` の既定値で補う。`db.server`・`db.name`(と `db.auth` が `sql` なら `db.user`・`db.password`)がなければ実行せず `reason: env_missing`(`error` に `env.mjs require --keys …` の形を書く)
- sqlcmd の呼び出し: `<db_cli> -S <db.server> -d <db.name> (-E | -U <db.user>) [-C] -b -X1 -l 15 -t 60 -W -s <TAB> -w 65535 -Q <文>`。パスワードは**標準入力**で渡す(引数に書かない。プロセスの一覧にも出ない)。proc-v024 では環境変数 `SQLCMDPASSWORD` で渡していたが、`-X` は `ED`・`!!` を止めるのと同時に**環境変数を sqlcmd に渡さなくする**ため、SQL Server 認証のログインが失敗した(F-001 の発生環境の `pms db --check`。proc-v025)。`-X1` は、止めたコマンドが現れたら警告で続けずにエラーで終わる。標準入力から読むときに sqlcmd が標準出力に出すことのある `Password:` の促しは、出力の先頭から外す(`stripPrompt`)。偽物 `stub-sqlcmd.mjs` も、`-X` があれば `SQLCMDPASSWORD` を読まない`-C` は `db.trust_server_certificate` が true のとき(R-DB-1)
- 実行の前に、別の呼び出しで `SELECT @@SERVERNAME, DB_NAME(), SUSER_SNAME()` を実行し、`target`(`server_name`・`db_name`・`login`)として返す。`DB_NAME()` が `db.name` と違えば(大文字・小文字は区別しない)実行せず `reason: target_mismatch`。接続できなければ `connect_failed`。`@@SERVERNAME` は `db.server`(別名・ポート付きのことがある)と比べず、記録だけにする
- 受け付けた文は `SET NOCOUNT ON; BEGIN TRAN; <文>; ROLLBACK TRAN;` で実行する(SELECT のみの検査の取りこぼしに備えた二重の守り)。失敗は `reason: query_failed`
- 出力の `output` は sqlcmd の表(見出し・区切り線・行)を 200 行・2 万文字まで(超えたら `truncated: true`)。`rows` は見出しと区切り線のあとの行の数。出力・記録の秘密情報(全環境の kind `secret` と `db.password`)は伏せる(2.3 と同じ `mask`)
- `--card` を付けたら、出ているカード(`issued`)でなければ終了コード 2。`--intent` が要る。記録 `work/<feature_code>/exploration/db-log.jsonl` に1行(`flow`・`card`・`step_id`・`intent`・`sql`・`env`・`server`・`name`・`target`・`started_at`・`ended_at`・`ok`・`rows`・`reason`・`error`)を書く。act-log とは分ける(act-log の `seq` は画面操作の連番として探索記録と lint `explore_act_linked` が使うため)
- カードなしでも使える(作業01・02・15 の DB の観測。記録は書かない)。`--check` は接続先の確認だけをする(作業10の工程0。stages §10)
- `pms run` のカードのセッションでは、`sqlcmd` の直接の呼び出しを使用禁止にする(`procedure/cards/agents.yaml` の `deny_shell`、`config/pms.sample.json` の `runner.copilot.deny`)。`pms db` は使用禁止にしない

実物の sqlcmd で確かめていないこと(テストは偽物 `test-support/stub-sqlcmd.mjs`。違っていたら `db_cli` か `lib/db.mjs` を直す):

- `-C`・`-s <TAB>`・`-w 65535` を、使う sqlcmd(ODBC 版・Go 版 `go-sqlcmd`)が受け付けるか。`-X1` と標準入力のパスワードの組み合わせでログインできることは、発生環境の調べで確かめられた(2026-10-09。版は報告されていない)
- Go 版 `go-sqlcmd` が標準入力のパスワードを読むか(読まなければ、Go 版のときだけ `-X1` を外して環境変数で渡す形を考える)
- `-h -1 -W -s <TAB>` で、接続先の確認の結果が1行のタブ区切りで出るか

### 2.6 ブラウザの locale(`config/playwright-cli.json`)

テスト対象の画面は、ブラウザが伝える言語(`navigator.language`・`Accept-Language`)で日本語と英語が変わる。playwright-cli は locale を指定しないと OS やブラウザの既定の言語で開くため、端末や起動のしかたで表示が変わる。これを揃えるため、`pms act open` と `pms pwcli -- open` は playwright-cli の設定ファイルを `--config=<絶対パス>` で渡す(`lib/cli.mjs` の `browserConfigArgs`)。

- 設定ファイルは `config/pms.json` の `browser_config`(既定 `config/playwright-cli.json`)。書式は playwright-cli の設定ファイルそのもの(`browser.contextOptions` に Playwright のコンテキストの設定)。全員で同じ値を使うので git に入れる
- 中身は `{"browser": {"contextOptions": {"locale": "ja-JP"}}}`。タイムゾーンなどを揃えたいときも同じ `contextOptions` に足す(`timezoneId` など)
- **locale の既定値は `ja-JP`**(`lib/cli.mjs` の `DEFAULT_LOCALE`)。設定ファイルに `browser.contextOptions.locale` がないとき・`browser_config` が null のとき・ファイルがないときは、`ja-JP` を足した写しを一時ディレクトリ(`pms-playwright-cli-<中身のハッシュ>.json`)に作って渡す。ファイルがないときは警告も返す。英語など別の言語で開くときは、設定ファイルの `locale` に書く
- JSON として読めない・オブジェクトでないときは終了コード 2
- locale はブラウザを開くときに決まる。開いたままのセッションには効かないため、変えたら `close` してから開き直す
- `@playwright/cli 0.1.22` で、`--config` の locale が `navigator.languages` に効くこと、`browser_config` が null のときに `pms pwcli -- open` が `ja-JP` で開くことを確かめた(2026-10-08。locale の指定なしでは OS の言語 `ja,en-US,en` だった)

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

- カードの状態は `vocab.pms_card_status`(`pending` / `issued` / `passed` / `stopped` / `skipped`)。起動時に `lib/store.mjs` の `CARD_STATUS` と照合する
- `stopped` のカードは `stop: {code, reason, at, reported, chained_from?}` を持つ(`code` は `vocab.pms_stop_reason`)。`passed` は `passed_at`・`result`。`skipped` は `skipped: {reason, at}`
- カードは `phase`(`A` / `C`。段1のキューのカードは持たず A として扱う)を持つ。パートCのカードは `round`(9章)を持つ
- 合格時に pms が書いた台帳のIDは `track: {handoffs, signals, discrepancies, disc[], ext_added, ext_appended, ops_registered}`、`explore.close`・`explore.session_close`・`report.findings` の出力は `output` に写す(`pms report` が使う。AI があとで `out/` を書き換えても報告書は変わらない)。状態需要リストを `整備済` にしたら `provisioned`
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

1. 出したままのカード(`issued`)があれば、同じカードをもう一度出す。本文の先頭に「このカードを出すのは n 回目」と、前回の提出が不合格ならその区分、そのカードで記録済みの操作の連番を添える。ただし出した回数が `max_issues`(既定 3)に達していれば、出さずに `stopped`(`issue_limit`)にする
2. まだ伝えていない `stopped` のカードがあれば、`STOP`(終了コード 3)を返す。1回伝えたら `reported: true` にし、次の `next` からは残りのカードを続ける(人間が続けてよいと答えたあと、残りを止めないため)
3. `pending` のカードがあれば、フェーズ(A → C)、次に作った順(`lib/queue.mjs` の `cardOrder`)で1枚出す(本文を `cards/C-<番号>.md` に保存)。探索のカードは出す前に `prepareExplore`(9章)を通し、`skipped`・`stopped` になったら次を見る
4. どれもなければ `done`(`stopped` の一覧を添える)
5. `--phase` を渡すと、そのフェーズのカードだけを扱う(前のフェーズのカードが残っていれば終了コード 2)

探索のステップのカードが STOP になったら、同じシナリオ・同じラウンドの後続のステップも `stopped`(`chained_from`。伝え済み)にする(ステップは前の結果を引き継ぐため)。

## 5. `submit` の検査と記録

検査の区分は `vocab.pms_reject_kind`。不合格の理由には区分ごとの直し方1行(`lib/checks.mjs` の `FIX`)を付ける。合否は毎回 `submit-log.jsonl` に書く(`{at, card, kind, state_id, attempt, issued_count, ok, result, categories[]}`。段2の計測に使う)。不合格が `max_rejections`(既定 3)に達したらカードを `stopped` にする。

| 区分 | 検査 | カード |
|---|---|---|
| `schema` | ファイルがある・JSON・`procedure/schemas/<種類>.out.json`(`lib/schema.mjs`。`x-vocab` は vocab のキーの値) | 全部 |
| `red_flag` | あいまい語(`vocab.pms_vague_words`。コマンド・所在・時刻の欄は見ない)、schema の長さの違反、`禁止操作` なのに禁止IDがない、`操作手段なし` なのに `ext_demand` がない、実行の時刻がカードを出す前 | 全部 |
| `seq_missing` | 連番が act-log にある・このカードの記録・`ok: true`・step のある操作・増える順。`established_check_seq` は同じカードの成功した `assert` で、最後の操作より後。`fragile` の連番は `seqs` の中 | build |
| `unstable_locator` | `seqs` と established check のロケータが `unique: true`。`css` は `fragile` に挙げ、`work/_common/testid-requests.md` にロケータ(または `locator('…')` の中のセレクタ)があるときだけ認める | build |
| `lint` | 書く予定のエントリに、lint の規則 `setup_steps_recorded`・`no_temp_locator` を当てる(規則の関数を直接呼ぶ)。秘密情報の値がない(`env_value_leak` と同じ基準)。ほかの区分に違反がないときだけ当てる。explore.step は `no_temp_locator` と、DB の確認が SELECT だけか | build・step |
| `expected_changed` | scenarios.md のステップの行(確認内容・期待結果)が、キューを作ったときの `digest` と同じ。出力の文字列が「期待結果・判定基準を変更した」と述べていない | step |
| `verdict_evidence` | `failed`・`human-check` に `evidence`(screenshot の連番)がある | step |
| `health_time` | `health_signal.observed_at` が時刻の形で、そのカードの操作の記録の時刻の範囲に入る | step |
| `blocked_refs` | 理由コードが `vocab.reason_code`、禁止IDが禁止操作リストの表にある、需要ID・申し送りIDが台帳にある、`resume_from` がこのステップかそれより後 | step |

explore.step はほかに、`seq_missing`(seqs・`verification.screen_seqs`(assert)・`evidence`(screenshot)・DISC の `evidence_seq` がこのカードの成功した記録)、`unstable_locator`(seqs と assert のロケータ。setup.build と同じ)、`red_flag`(検証手段と画面・DB の確認の対応、DB 単独の理由、検証手段を変えた理由、`assertion_hint`、健全性シグナルがあるのに passed、非決定値のIDがカタログにある、`ops_registered` が KB T05 にある)を見る。explore.close・session_close は INV の全キー(`schema`)・fail と violations の対応・反映先のファイルの実在(`red_flag`)、report.findings は INV を実行したのに優先レビューに挙げていない(`red_flag`)を見る。
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
| step(全判定) | exploration-log のこのフローの文書の、このラウンドのシナリオの記録に、ステップを書く(9.3)。DISC・申し送り・手順改善シグナルの行を足す。`blocked` なら、申し送り(パートBの行を参照しなければ新しく)と外部操作需要リストの行を書き、後続のステップを `skipped` にして `{reason: 前ステップが blocked}` と記録する |
| close | シナリオの記録に `invariants`・`manual_gap`・`requires_setup` を書く。出力を `output` に写す |
| session_close・findings | 出力を `output` に写す(記録には書かない。`pms report` が使う) |

### 5.2 台帳の部品(`lib/ledgers.mjs`)

- `appendHandoff` / `peekHandoffId` / `recordExtDemand` / `stateDemandRow` / `adoptedStates` / `markStateProvisioned`
- 段2で加えたもの: `appendSignal`(テンプレート94の「1. シグナル」の表。`SIG-<4桁>`。振り分け・IMP は空)/ `appendDiscrepancy`(`work/_common/discrepancies.md` に 00 ■不整合レポート(DISC)規約の書式で1件。`DISC-<機能>-<3桁>`。ファイルがなければレビューヘッダ付きで作る)/ `prohibitionLevels`(禁止操作表の禁止IDとレベル)/ `ledgerIds` / `handoffsOfFlow`
- 表は記入用テンプレートの「## 台帳」の表(列の名前で書く)。ファイルがなければテンプレート(`procedure/templates/91_`・`93_`・`96_`)を写して作り、テンプレートの空の行は最初の行を足すときに外す
- `ledgerFormatErrors`: 作業場所にある台帳(申し送り・外部操作需要・状態需要・手順改善)が、テンプレートの見出しの下に ID の列の表を持つかを確かめる。`queue build` がカードを作る前に呼び、読めない台帳があれば終了コード 2 で止まる(パートBで AI が手で作った台帳の形の崩れを、カードを行ったあとの報告書の作成で初めて見つけないため。proc-v022)
- 採番は「## 台帳」の表の中の最大 + 1(`HO-<機能コード>-<3桁>`・`EXT-<3桁>`)。記入例の節は数えない
- 書くのは事実の欄だけ(優先度・採否・整備記録など人間の欄には書かない)

### 5.3 setup-log の書き方(`lib/setup-log.mjs`)

1つのファイルに複数のフローの文書(`---` 区切り)があってよい。対象のフローの文書だけを書き直し(なければ末尾に足す)、文書の中では `state_id` ごとにエントリを置き換える。ほかのフローの文書の内容は変えない(`lib/flow-doc.mjs` の `writeFlowDoc`。exploration-log も同じ部品で書く)。YAML の出力は `lib/yaml-write.mjs`(二重引用符のスカラー・`|` のブロックスカラー。`tools/lint/lib/yaml-lite.mjs` で読み戻せる範囲)。

## 6. カード(`procedure/cards/<種類>.md`)と規則の差し込み(`lib/procedure.mjs`)

| 差し込み | 中身 |
|---|---|
| `{{名前}}` | pms が埋める入力(状態ID・定義・状態需要リストの行・established check の案・KB の該当ページ(`kb/00_索引.md` と状態IDを含む `kb/` のファイル)・現在の画面の URL(直前の記録の `url_after`)・環境情報のキー(`env.mjs list` のキーと種類。値は出さない)・作り直しの説明・出し直しの説明・提出のコマンドなど。`lib/queue.mjs` の `cardVars`) |
| `{{rule:R-XXX-n}}` | `procedure/00_common.md`・`procedure/stages.md` で `**[R-XXX-n]**` を付けた行(箇条書きの記号と目印を外し `- [R-XXX-n] …` にする。表の行は「1列目: 残りの列」)。同じ規則IDが2箇所にあれば終了コード 2 |
| `{{protected:ID}}` | 保護ブロックの本文を、文言を変えずにブロックごと(00 → stages の順に探す) |
| `{{vocab:キー}}` | 統制語彙の一覧(値の意味つき) |
| `{{schema}}` | 出力の schema の各欄の表(必須・許される値・内容) |

埋められない差し込みは終了コード 2(テンプレートの誤り)。規則IDを付けたのは、カードが使う規則だけである(段1: R-PMS・R-SETB・R-SETC・R-SETR・R-LOC・R-STA・R-PRT・R-PO・R-DAT・R-ENV。段2: R-EXP・R-RPT(stages §10 パートC)、R-JDG・R-HLT・R-INV・R-WAIT・R-DISC・R-HO・R-SIG(00。文言は変えていない)、R-PMS-5)。

カードの種類を足すとき: `vocab.pms_card_kind` に足し、`procedure/cards/<種類>.md` と `procedure/schemas/<種類>.out.json` を置き、`procedure/cards/agents.yaml` の `kinds` に足し(生成スクリプトが vocab と照合する)、`lib/submit.mjs`(または `lib/explore.mjs`)に検査と記録を、`lib/queue.mjs` に `TODO` と入力を足す。

## 7. 設定(`config/pms.json`。見本 `config/pms.sample.json`。git に入れない)

| キー | 既定 | 内容 |
|---|---|---|
| `playwright_cli` | `["playwright-cli"]` | playwright-cli の呼び出し方(コマンドの配列) |
| `playwright_cli_version` | null | 想定する版。`open` のときに `--version` と比べ、違えば警告 |
| `session_arg` | `-s={session}` | セッション名の引数(`{session}` はフローID) |
| `open_args` | `["--idle-timeout=0"]` | `open` に足す引数 |
| `browser_config` | `config/playwright-cli.json` | `open` に `--config=<絶対パス>` で渡す playwright-cli の設定ファイル(ルートからの相対パス。locale など。2.6)。null のとき・locale がないときは locale の既定値 `ja-JP` を渡す |
| `env_cli` | null | 環境情報の実行体(`get <キー> --reveal` を足して呼ぶ)。null なら `node tools/env/env.mjs --root <root>` |
| `db_cli` | `["sqlcmd"]` | `pms db` が呼ぶ sqlcmd(コマンドの配列)。接続の引数は pms が足す(2.7) |
| `max_issues` | 3 | 同じカードを出す回数の上限 |
| `max_rejections` | 3 | 同じカードの不合格の回数の上限 |
| `ops` | `{}` | 操作ごとの呼び出しの上書き(`{"press": {"cli": ["press", "{value}"]}}` など。`{ref}` `{value}` `{js_value}` `{locator}` を置き換える。`cli` か `run_code` のどちらか) |
| `screenshot_args` | `["screenshot", "{ref}", "--filename={file}"]` | `pms act screenshot` の呼び出し(要素 `{ref}` は ref がなければ外す) |
| `runner` | null | `pms run` が起こす AI の CLI(名前 → `{command, deny_arg, deny, stdin, timeoutSec, heartbeatSec, stallWarnSec, fatal_exit_codes}`。10章)。null なら `pms run` は終了コード 2 |
| `default_runner` | `copilot` | `--runner` を省いたときの CLI(見本の名前は `copilot`・`kiro`・`claude`) |
| `cardTypes` | `{}` | カードの種類ごとの `agent`・`model`(候補の配列。先頭を使う)・`deny`(その種類だけに足す使用禁止)。CLI ごとに変えるときは `runners.<CLI の名前>` に同じ形で書く(モデルの名前と使用禁止のパターンは CLI ごとに書き方が違うため)。書かなかったものは `procedure/cards/agents.yaml`(10章の2) |

ファイルがなければ既定の値で動く。知らないキーは終了コード 2。**CLI のフラグはコードに書かず、`runner` に書く**(CLI の仕様が変わっても設定だけで直せるように)。見本 `config/pms.sample.json` の Copilot CLI・Kiro CLI の雛形は 2026-10-08 に、Claude Code の CLI の雛形は 2026-10-10 に、公式のドキュメント(13章)で確かめたフラグで書いた。

## 8. 実物の playwright-cli で確かめていないこと

テストは偽物の playwright-cli(`test-support/stub-playwright-cli.mjs`)で行っている。次の前提は docs/94 §9(`@playwright/cli 0.1.22`)に基づくが、実物で確かめていない。違っていたら `config/pms.json` で直せるようにしてある(直せないものは `lib/cli.mjs` を直す)。

- `generate-locator <ref>` の出力の行にロケータがある(`page.` があってもよい)
- `run-code "async page => { … }"` の結果が「### Result」の次の行、または最後の行に出る
- 操作の出力に `Page URL: …` と「Ran Playwright code」のコードブロックが出る(なければ `page.url()` を評価し、コードは pms が作る)
- `open` が `--idle-timeout=0` を受け付ける
- (段2)`screenshot` が `screenshot [ref] --filename=<パス>` で保存先を受け付ける(違えば `screenshot_args` で直す)

## 9. パートCのカード(段2。`lib/explore.mjs`)

### 9.1 キューの作り方(`queue build --phase C` / `all`)

- 対象シナリオは3.1の1と同じ。シナリオごとに、scenarios.md のステップの表の行ごとに `explore.step`(順序の列の順)、最後に `explore.close`。対象のあとに `explore.session_close` と `report.findings` を1枚ずつ
- 1回の `queue build` で作るパートCのカードを**ラウンド**と呼ぶ(`q.rounds[]: {round, created_at, scenarios, context, recheck_of, reexplore_of}`)。パートCのカードが全部終わっていれば、同じフローに次のラウンドを足せる(パートPの探索し直し)。フェーズAは1回だけ作る(`--phase all` は、フェーズAがあれば足さない)
- `stage10-context.json`(書式 `procedure/schemas/stage10-context.json`)を schema で検査し、ラウンドに写す。`recheck_of`・`reexplore_of` を、そのラウンドの探索記録の印にする
- 各 `explore.step` に、そのときの確認内容・期待結果(`digest`)を控える(`expected_changed` の検査)

### 9.2 出す前の処理(`prepareExplore`)

シナリオの最初のステップのカードを出す前に、このフローの setup-log で `requires` の状態を確かめる。

| setup-log | 処理 |
|---|---|
| 記録のない状態がある(フェーズAのカードが STOP) | そのカードを `stopped`(`setup_unready`)にし、後続のステップも止める |
| `blocked` の状態がある | 全ステップを記録し(最初のステップの `blocked_by` は setup-log の `blocked_by` から写し、`resume_from` は最初のステップ。後続は `前ステップが blocked`)、`invariants` を全キー `未実施(前提状態が blocked …)`、ステップと `explore.close` のカードを `skipped` にする |
| それ以外 | 出す |

### 9.3 探索記録の書き方(`lib/exploration-log.mjs`)

- このフローの文書(`feature_code`・`flow_id`・`explored_at`・`environment`(stage10-context.json)・`scenarios`)の中で、シナリオの記録を `id` と印(`recheck_of`・`reexplore_of`)で探し、なければ足す。前のラウンドの記録は消さない
- ステップの記録: `step_id`・`verdict`・`started_at`/`ended_at`(このカードの全記録の最初と最後。記録がなく判定が blocked 以外ならカードを出した時刻と提出の時刻)・`actions`(seqs の記録から。`fragile`)・`verification`(`DB` 単独は `DB(理由: …)`)・`verified_by`(`screen` は assert の記録から、`db` は「SELECT → 結果」)・`verification_note`(検証手段を変えた理由)・`assertion_hint`・`nondeterministic`・`wait`・`health_signal`・`observed`・`evidence`(screenshot の記録の `evidence`)・`blocked_by`・`notes`・`act: {card, seqs, screen_seqs, evidence_seqs}`
- シナリオの記録: `verdict`(ステップから。failed > blocked > human-check > passed)・`requires_setup`(setup-log から1状態1行)・`carried_data`(ステップの出力を重ねる)・`steps`(scenarios.md の順)・`invariants`・`discrepancies`・`manual_gap`

### 9.4 カードの入力

| カード | 入力(pms が埋める) |
|---|---|
| explore.step | シナリオの目的・合格条件・持ち回るデータ・使用する外部操作、ステップの行(原文の表)、位置、前のステップまでの記録の抜粋(判定・操作・観測。記録から)、持ち回るデータの現在の値、前提状態の操作列(最初のステップのとき。setup-log から)、現在の URL、このステップ・シナリオの申し送り、KB の該当ページ(索引とシナリオID・ステップID・操作IDを含むページ)、非決定値カタログの所在、環境情報のキー、DB の接続 |
| explore.close | 目的、ステップの記録の抜粋、持ち回ったデータ、既存の部品・fixture・ページオブジェクト、INV の注記、DB の接続 |
| explore.session_close | ラウンドのシナリオ、シナリオ末尾の検査の結果、DB の接続 |
| report.findings | `pms report` と同じ作り方の報告書の下書き(所見の欄は空。`work/_flows/F/report-draft-<機能>.md` にも書く) |

「DB の接続」(`lib/db.mjs` の `dbConnection`)は、`pms db` の使い方(`pms db --flow F --card C --intent "<確かめること>" -- "<SELECT 文>"`)と、フローの環境(2.7 の `dbSettings`)の接続先(`db.server`・`db.name`)・ログインの方式(`db.auth`。`sql` ならログイン名も)・サーバ証明書の扱い(`db.trust_server_certificate`。`true` または未登録なら人間が承認済み、`false` なら検証する)を書く1行である。パスワードは書かない。必要な環境情報がなければ、そのことと「`pms db` が失敗したら `cannot_proceed` で提出する」を書く(00 ■DB への接続 [R-DB-1]・[R-DB-2]。proc-v023 で証明書、proc-v024 で接続先・ログイン・`pms db` を加えた)

## 10. `pms run`(段2。`lib/run.mjs`)

1. `nextCard`(4章。`--phase` のフェーズだけ)で次のカードを取る。STOP → `{state: STOP, code, reason, message}` で終了コード 3(`message` は利用者向けの文面)
2. カードの種類のエージェント・モデル(`cardType(ctx, 種類, CLI の名前)`。モデルは `cardTypes.<種類>.runners.<CLI>.model` → `agents.yaml` の `kinds.<種類>.<CLI>_model`(`kiro_model`・`claude_model`)→ `cardTypes.<種類>.model` → `kinds.<種類>.model` の順。エージェントの名前は `pms-card-<種類の . と _ を - に>`)と使用禁止(`runner.<名前>.deny` + `cardTypes.<種類>.runners.<CLI>.deny`(なければ `cardTypes.<種類>.deny`))で、`runner.<名前>.command` を展開する。依頼文(`{prompt}`)は短い固定の文で、**カードの本文はファイルのパス(`{card_file}`)で渡す**(コマンドラインの長さに頼らない)。`stdin: "prompt"` なら依頼文を標準入力でも渡す
3. 子プロセスを `cwd = root`、環境変数 `PMS_RUNNER=b2`・`PMS_FLOW`・`PMS_CARD`・`PMS_ACTIVITY` で起動する(非同期の `spawn`。`timeoutSec` を超えたら SIGKILL で止め、未提出として扱う)。`pms run` 自身も `PMS_RUNNER=b2` にして、出したカードの履歴に残す
   - 進み具合(`lib/progress.mjs`): セッションの間、標準エラー出力に `[pms run] C-0009 3分05秒: <キーワード>` の形で出す。キーワードは、CLI の出力の JSON の行の道具の呼び出し(`toolName`・`tool_name`・`tool`、または `type` に tool を含む行の `name` と、`command`・`path` など)と、セッションの中で実行された pms のコマンド(pms.mjs が `PMS_ACTIVITY` のファイル `runs/C-<番号>-<回>.activity` に書く。`pms act click`・`pms submit 不合格` など。終わったら消す)。キーワードが変わったら3秒以上あけて出し、何も出していなければ `heartbeatSec`(既定 30)ごとに経過と最後の動きを出す。出力も pms のコマンドもない時間が `stallWarnSec`(既定 180)を超えたら「止まっている可能性」を出す(長いテストの実行中もこうなる。最後のキーワードで見分ける)。CLI の出力の形は実物で確かめていないため、キーワードが取れなくても経過と最後の動きの時刻は出す
4. 出力(標準出力の JSONL)の後ろに `{"pms": {card, kind, runner, attempt, exit_code, signal, timed_out, started_at, ended_at, stderr}}` の1行を足し、秘密情報の値を伏せてから `runs/C-<番号>-<回>.jsonl` に保存する。キューの履歴に `session` を足す
5. キューで合否を確かめる。合格でなければ次の `nextCard` が同じカードを出し直す(出し直しの上限は `max_issues`、不合格の上限は `max_rejections`。段1の規則のまま)。終了コードが `fatal_exit_codes`(Copilot CLI の 2 = 引数の誤り)なら終了コード 1
6. `done` になったら、パートCがあれば `pms report` と `lint --stage 10 --skip skills_in_sync` を行う。lint の終了コード 0 → 0、1 → STOP(`lint_error`。指摘を `errors` に)、2 → 1。**lint の指摘を直すカードは作らない**(チャットの作業10の「lint の指摘による差し戻し」で直す)
7. CLI が起動しない(ENOENT)→ 終了コード 1。`--max-cards N` で N 枚行ったら終了コード 4(`paused`)。`--dry-run` はキューを変えずに、次のカードの呼び出し(展開したコマンド)だけを出す

## 11. `pms report`(段2。`lib/report.mjs`)

- パートCのカードがすべて終わってから(`passed`・`stopped`・`skipped`)、機能ごとに `report.md` と `status.yaml` を書く。数値・一覧はすべて記録から、所見だけを `report.findings` の `output` から
- status.yaml の最上位の `environment`・`env_restore`・`pre_stage`・`prohibited_ops` と、`flow_kind`・`flow_seq`・`scenario_source`・`env_keys_added`・パートA・B・R の台帳のIDは、最後のラウンドの `stage10-context.json` から写す
- `context_updates` の決め方: `verdicts`・`codeable_items`・`health_signal(_items)`・`assertion_gap_items`(`assertion_hint` に「決定的な検証手段が見つからない」)・`blocked_by_prohibition` はシナリオごとの最新の記録から。`escalation` は、`禁止操作` の blocked の参照が包括原則か `要許可` の禁止ID なら `permission_required`、所見が KB 不足なら `knowledge_gap`。`invariant_violation` は最新の記録のラウンドの `explore.close` と、最後のラウンドの `explore.session_close` の `violations`。`handoff_by_reason` は申し送り台帳の、発生元にフローIDを含み、IDがその機能の行。`rediscovery_rate` は発見ログ(`logs/discovery-log_*.md`)の、フローIDかシナリオIDを含む行の「再発見」の割合。`setup_unverified` は setup-log の `verified` が true でない状態(`S-CLEAN-ENV`・blocked を除く)。`kb_t05_reused` は stage10-context.json と、記録の `ext` の操作IDのうち新規登録でないもの。`recheck_resolved` はパートPのラウンドで、前の記録で `禁止操作` の blocked だったステップのうち blocked でなくなったもの
- `outcome`: `--dod-unmet`・STOP のカード・blocked・human-check のどれかがあれば `partial_success`、なければ `success`(00 ■status.yaml 契約の規約3)

## 12. `pms stats`(段2。`lib/stats.mjs`)

- カード(AIに1回以上出したもの)ごとに、実行形態(履歴の `issued` の `runner`、なければ submit-log の `runner`、なければ `b1`)と種類で集計する: 枚数・初回合格(最初の提出が合格)・平均の提出回数・不合格の区分ごとの件数・出し直し(出した回数 - 1)・STOP(`chained_from` を除く。`code` ごと)
- `--since` は、カードを出した時刻で絞る
- 記録の必須欄の充足率: setup-log(`built-by-ui` の `steps`・`steps[].locator`・`act`・`established_check`、`provided` の `steps`・`reused_from`)と exploration-log(`carried_data`、実行したステップの `started_at`・`ended_at`・`assertion_hint`・`act`・`actions`、failed・human-check の `evidence`、blocked の最初のステップの `resume_from`)

## 13. AI の CLI と使用禁止(段2。実物で確かめていないこと)

2026-10-08 に公式のドキュメントで確かめた(実物では動かしていない):

| CLI | 確かめたこと | 出典 |
|---|---|---|
| Copilot CLI | `-p PROMPT`(非対話で実行して終わる)・`--agent`・`--model`・`--no-ask-user`・`--output-format json`(JSONL)・`--allow-tool` / `--deny-tool`(例 `shell(git:*)`・`write(<パス>)`)・`--allow-all-tools`・`--available-tools`・`--excluded-tools`。終了コード 0 / 1(未完了)/ 2(引数の誤り)/ 130。認証は `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`。カスタムエージェントの frontmatter は `name`・`description`・`tools`・`model`(文字列) | docs.github.com「GitHub Copilot CLI programmatic reference」「Custom agents configuration」 |
| Kiro CLI | `kiro-cli chat --no-interactive`(依頼文は引数か標準入力)・`--agent`・`--model`・`--trust-all-tools` / `--trust-tools`・`--output-format stream-json`(V2・V3)。認証は `KIRO_API_KEY`(Pro 以上)。エージェントは `.kiro/agents/<名前>.json`(`name`・`description`・`prompt`・`tools`・`model`・`permissions`・`toolsSettings`)。`permissions.rules` の `deny` がほかの `allow` より優先する。`toolsSettings.shell.deniedCommands` は旧形式 | kiro.dev「Headless mode」「CLI commands」「Agent configuration reference」 |
| Claude Code の CLI(2026-10-10) | `claude -p`(非対話で実行して終わる。依頼文は引数か標準入力)・`--agent <名前>`(`.claude/agents/<名前>.md` をメインのセッションのエージェントにする)・`--model`(別名 `sonnet`・`haiku`・`opus` かモデルID)・`--output-format stream-json`(`-p` では `--verbose` が要る。道具の呼び出しは `message.content[]` の `tool_use`)・`--permission-mode acceptEdits`・`--allowedTools` / `--disallowedTools`(権限の規則の形。例 `Bash(sqlcmd *)`・`Edit(procedure/**)`。拒否が許可より優先する)。`-p` では確認の要る道具は使えない(許可していなければ拒否される)。認証は `claude` へのログインか `ANTHROPIC_API_KEY` | docs.claude.com「CLI reference」「Headless mode」「Identity and Access Management」 |

実物で確かめること(人間に頼む。違っていたら `config/pms.json` と `procedure/cards/agents.yaml` を直す):

- Copilot CLI の `--deny-tool` のパターンが、空白を含むコマンド(`shell(npx playwright-cli:*)`・`shell(node tools/env/env.mjs get:*)`)と、`write(procedure/**)` の `**` を受け付けるか。受け付けなければ、`--available-tools` で使える道具を絞る形に変える(2026-10-08 の F-001 の `pms run` で、`shell(node tools/env/env.mjs get:*)` が `node env.mjs get db.server` を含むコマンドを拒否したことは確かめられた。2.7)
- `--allow-all-tools` と `--deny-tool` を併せたとき、`--deny-tool` が優先するか
- `--agent` に、`.github/agents/pms-card-*.agent.md` のファイル名(`.agent.md` を除いた名前)を渡せるか
- Kiro CLI の `permissions` と `toolsSettings` を同じエージェントに書いてよいか(旧形式を受け付けない版なら `toolsSettings` を外す)。Kiro のモデルIDを `kinds.<種類>.kiro_model` に書くか
- 1枚 900 秒の上限が、探索のステップに足りるか(`runner.<名前>.timeoutSec`)
- Claude Code の CLI で、`-p` と `--agent` を併せて使えるか(エージェントの `tools`・`disallowedTools`・`model` がセッションに効くか)。`--disallowedTools` の空白を含むパターン(`Bash(node tools/env/env.mjs get *--reveal*)`)と `Edit(procedure/**)` が効くか。Windows で `claude` を起動できるか(npm で入れた `claude.cmd` は起動できないことがある。そのときは `command` の先頭を `claude.exe` の絶対パスにする)。`--runner claude --dry-run` で起こすコマンドを確かめてから、`--max-cards 1` で1枚だけ行わせて確かめる
- `--output-format json`(Copilot)・`stream-json`(Kiro・Claude Code)の行から、道具の呼び出しのキーワードが取れるか(`pms run` の進み具合。取れなければ `lib/progress.mjs` の `keywordOf` を直す)

## 14. IDE 内のループ(段3。B1。入口のエージェント `pms-runner`)

### 14.1 流れ

1. 利用者が IDE のチャットのエージェントを `pms-runner` に切り替え、「F-003 を進めて」と伝える
2. `pms-runner` が `node tools/pms/pms.mjs next --flow F-003 --brief` を実行する
3. `state: "card"` なら、出力の `agent`(カードの種類のエージェント `pms-card-<種類>`)をサブエージェントとして呼び、出力の `prompt` をそのまま渡す。サブエージェントは `prompt` に書かれたカードのファイルを読み、カードを行い、`pms submit` で提出する(B2 のセッションと同じエージェント・同じ依頼文)
4. サブエージェントの返事の内容にかかわらず 2 に戻る。提出されていなければ、次の `next` が同じカードを出し直す(4章の1。上限 `max_issues` で STOP)
5. `done` なら `pms status` の要約を、`STOP` なら `message` を利用者に伝えて終わる。利用者が「続けて」と言えば 2 から(キューはファイルにある)
6. 全部終わったら、入口 skill(`pms-regression`)が次の「続き」で `status` の `report_pending` を見て `pms report` を実行し、完了前の lint を行う(B2 では `pms run` が行うもの)

入口のエージェントの本文は `procedure/cards/agents.yaml` の `runner.instruction`(5行の手順)。生成は `tools/build-skills/build-skills.mjs`(Copilot: `.github/agents/pms-runner.agent.md`、Kiro: `.kiro/agents/pms-runner.json`、Claude Code: `.claude/agents/pms-runner.md`)。Claude Code のサブエージェントはサブエージェントを呼べないため、Claude Code では `claude --agent pms-runner` でメインのエージェントとして起動する(呼べるサブエージェントは `tools` の `Agent(pms-card-…)` に並べたカードのエージェントだけ)。

### 14.2 判断と根拠

| 判断 | 根拠 |
|---|---|
| カードの出力に `agent`(`lib/agents.mjs` の `cardType`。`config.cardTypes.<種類>.agent` があればそちら)と `prompt`(`promptOf`。B2 と同じ文)を入れる | 入口がカードの種類とエージェントの対応表を覚えなくてよいように(改訂指示 3.1)。B1 と B2 で依頼文を同じにし、計測の違いを実行形態だけにする |
| 入口はサブエージェントにカードの**本文ではなく** `prompt`(カードのファイルのパス)を渡し、`next` を `--brief` で呼ぶ | 改訂指示 3.1 は「カードの本文をそのまま渡す」だが、本文(探索のカードは KB の抜粋を含み数千字)を入口のモデルが写すと、写し間違い・省略が起きうる。また、本文が入口の会話に毎回積もり、数十枚でコンパクションが起きる(P2 に反する)。本文は `next` がファイルに書いており、サブエージェントは B2 と同じくファイルを読む |
| 報告書は入口のエージェントではなく入口 skill が作る(`report_pending`) | 入口のエージェントの道具を `pms next`・`pms status` とサブエージェントの呼び出しだけにし、本文を5行に保つため。`report_pending` は、パートCのカードが全部終わり、履歴の最後の `report` がカードの出来事(出した・合格・STOP・skipped・セッション・reopen)より前のとき true。B2 の `pms run` は lint の前に `report` を書くので false になる |
| `pms-runner` の `disable-model-invocation: true` | ほかのエージェントがループそのものをサブエージェントとして呼ばないように |
| カードのエージェントは段2のまま(`user-invocable` を付けない) | Copilot CLI の `--agent`(B2)への影響を確かめていないため。エージェントの選択の一覧にカードのエージェントも出る |

### 14.3 2026-10-08 に公式のドキュメントで確かめたこと(実物では動かしていない)

| IDE | 確かめたこと | 出典 |
|---|---|---|
| VS Code + Copilot | カスタムエージェントは `.github/agents/*.agent.md`。frontmatter の `agents`(サブエージェントとして呼べるエージェントの名前の一覧。`tools` に `agent` が要る)・`model`(文字列か候補の配列)・`tools`・`user-invocable`(エージェントの選択の一覧に出すか。既定 true)・`disable-model-invocation`(ほかのエージェントからサブエージェントとして呼ばせない。既定 false)。サブエージェントのモデルは、呼ぶ側が明示したモデル → **呼ばれたカスタムエージェントの `model`** → Auto → 会話のモデル の順。サブエージェントは会話の履歴を引き継がず、最後の結果だけを返す。入れ子は既定で無効(`chat.subagents.allowInvocationsFromSubagents`)。エージェントの切り替えはチャットの Agent のドロップダウン | code.visualstudio.com「Custom agents」「Subagents」 |
| Kiro IDE | カスタムエージェントは `.kiro/agents/<名前>.json`(または `.md`)。IDE でもカスタムエージェントをサブエージェントとして呼べる。呼ぶ側の `tools` に `subagent`、呼べるエージェントは `toolsSettings.subagent.availableAgents`(glob)、確認なしで呼ぶのは `trustedAgents`。`permissions.rules` の `capability` に `subagent`。エージェントの切り替えは、チャットの入力欄の行のエージェントの選択。**Workflows を有効にしていると、カスタムエージェントへの委任がバックグラウンドの実行になる** | kiro.dev「Subagents」「Custom agents」「Agent configuration reference」「Agent selector」 |
| Claude Code(proc-v026 で追加。2026-10-10) | サブエージェントは `.claude/agents/<名前>.md`(frontmatter の `name`・`description`・`tools`(カンマ区切り)・`disallowedTools`・`model`(省略すると呼び出し元と同じ))。サブエージェントはサブエージェントを呼べない。`claude --agent <名前>` でエージェントをメインのセッションとして起動でき、そのときは `tools` の `Agent(<名前>, …)` で呼べるサブエージェントを絞れる。skills は `.claude/skills/<名前>/SKILL.md`(`disable-model-invocation` が使える) | docs.claude.com「Subagents」「Agent Skills」 |

実物で確かめること(人間に頼む。違っていたら `procedure/cards/agents.yaml` の `runner` と生成スクリプトを直す):

- VS Code で `pms-runner` がエージェントの選択に出て、`agents` に並べたカードのエージェントだけをサブエージェントとして呼べるか。`tools: [execute, agent]` で端末のコマンドとサブエージェントの呼び出しができるか
- サブエージェントがカードのエージェントの `model`(`gpt-6-luna`)で動くか。VS Code が `model` に IDの形(`gpt-6-luna`)ではなく表示名の形(`GPT-6 Luna (copilot)` など)を求める場合は、`kinds.<種類>.model` に候補として足す(配列の先頭だけを書く今の生成を、配列を書く形に直す)
- サブエージェントの端末で `PMS_RUNNER` が設定されず、提出の記録が `b1` になるか(`pms stats` で `b1` と `b2` が分かれるか)
- Kiro IDE で、Workflows を有効にしているときに、入口がサブエージェントの終わりを待たずに `pms next` を呼ばないか。呼ぶと、同じカードが二重に出る(出し直しの回数が増え、上限で STOP になる)。待たない場合は、`pms-runner` を使うあいだ Workflows を無効にする(利用説明書の既知の制約)
- Kiro IDE で、`permissions` の `allow` と `toolsSettings` の旧形式を併記した `pms-runner.json` を読めるか
- Claude Code で、`claude --agent pms-runner` が `Agent(pms-card-…)` に並べたカードのエージェントだけを呼べるか。カードのエージェントの `disallowedTools`(`Bash(sqlcmd *)`・`Edit(procedure/**)` など)で、使用禁止のコマンドと書き込みが実際に拒まれるか。拒まれないときは、パターンの書き方(`Bash(sqlcmd:*)` など)を生成スクリプトで直す
