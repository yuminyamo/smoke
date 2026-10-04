---
name: collect-server-logs
description: PMS サーバー(PMS サーバーVM)の、指定した時間範囲のログを製品のログ収集ツールでマスクして集め、作業場所に保存する外部操作skill(SK-LOG)。作業15(健全性の是正)の H2 で、問い合わせに添付するログを集めるときに使う。返すのはログIDと件数の一覧だけで、ログの本文は読まない。回帰テストの判定には使わない。
---

# サーバーのログ収集(外部操作 SK-LOG)

PMS サーバーVMで製品のログ収集ツールを実行し、指定した時間範囲のログを**マスクして**集め、作業場所(VM の外)に保存する。
実行体は、リモートコマンドの CLI 本体(`tools/remote/pms-remote.ps1 logs-collect`)を呼ぶだけの入口である。ツールのパス・引数・出力先・マスクの指定は PMS サーバー側の設定で固定されている。**あなたが指定できるのは時間範囲と保存先だけ**である。

- 実行体は、集めたファイルからログIDを機械的に抜き出し、**ログIDと件数の一覧**を返す。あなたが読むのはこの一覧だけである
- 集めたログ一式は、問い合わせ skill の実行体に**所在(ディレクトリ)だけ**を渡す。ログの解析(原因の推定)は問い合わせ先が行う
- 外部操作 skill として扱う。KB T05 に登録してから使う(手順書 00 ■外部操作、§15 H1)。使い方を確立するときの接続確認は下の「確立時の確認」で行う

## いつ使うか

| 場面 | 使うか |
|---|---|
| 作業15 H2(自己診断)で、問い合わせに添付するログを集める | **使う**(シナリオ・問い合わせの回ごとに1回) |
| 2回目以降の問い合わせ | 前回と時間範囲が同じなら集め直さず、前回の一式を渡す。追加の操作をしたなら、その時間範囲で新しく集める |
| 一式は集めたが、ログIDの一覧を見失った(中断からの再開など) | `-Mode ids` で一覧だけ作り直す(サーバーに接続しない) |
| 回帰テストの判定・期待結果・待機条件を決めるため | **使わない**(ステップ1ではログを判定に使わない) |
| 健全性チェックの問い合わせの前に、人間・別の仕組みが集める | 同じコマンドで使える |

## 時間範囲の決め方

- 開始: 対象シナリオで自データを作成・操作した最初のステップの `started_at` から `vocab.default.log_window_margin_sec` 秒を引く
- 終了: 健全性シグナルの `observed_at` に同じ秒数を足す
- **ISO 8601 の時差付き**で渡す(例 `2026-10-03T13:49:50+09:00`)。時差のない時刻は受け付けない
- 探索記録に時刻がない(proc-v013 以前に始めたフロー)ときは、時間範囲を推測せず、集めない

## 実行方法

リポジトリのルートで実行する(CLI 本体と設定 `config/remote-targets.json` を上位へ探索するため)。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <このskillのフォルダ>/scripts/collect-server-logs.ps1 `
  -From 2026-10-03T13:49:50+09:00 -To 2026-10-03T13:56:10+09:00 `
  -OutDir work/<feature_code>/health/inquiries/<シナリオID>-<回>-logs
```

- `-OutDir` は**存在しないか空のディレクトリ**にする。集めるたびに新しいディレクトリを使う
- 所要時間は1〜数分(ツールの実行と転送)。途中経過は標準エラーに出る。**完了まで待つ。途中で打ち切らない**
- 読むのは**標準出力の最後の1行(JSON)だけ**でよい

一覧の作り直し(サーバーに接続しない):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <このskillのフォルダ>/scripts/collect-server-logs.ps1 -Mode ids -OutDir <集めたディレクトリ>
```

## 出力(標準出力の最後の1行)

| 項目 | 内容 |
|---|---|
| `success` | 成功したか |
| `collect_id` | 収集ID(`LOG-yyyyMMdd-HHmmss-xxxxxx`)。問い合わせの記録に残す |
| `bundle` | ログ一式を置いたディレクトリ。**問い合わせ skill の実行体にはこれを渡す** |
| `window` | `from`・`to`(渡した時刻)、`tool_from`・`tool_to`(ツールに渡した、サーバーの時刻)、`server_timezone` |
| `masked` | マスクを適用したか。`true` でなければ失敗として扱う |
| `log_ids` | ログIDと件数の配列(例 `{"id":"PMS-E-2041","count":2,"level":"ERROR"}`)。件数の多い順。`id` が `null` の要素は、ログIDを持たない行の件数 |
| `truncated` | `log_ids` を上限で切ったか(`log_id_kinds` が本来の種類数) |
| `files` | 集めたファイルの名前とサイズ(`files_truncated` で切ったか) |
| `server_time_offset_sec` | サーバーの時計 − 実行マシンの時計(秒。参考値) |
| `error_code` / `message` | 失敗したときの区分と内容 |

## 結果の扱い

| 終了コード | 意味 | 対応 |
|---|---|---|
| 0 | 成功 | 問い合わせの記録に `bundle`・`window`・`log_ids` を書き、`bundle` を問い合わせ skill に渡す。`log_ids` で KB T12 を引く |
| 1 | 収集の失敗(`TOOL_FAILED` `TOOL_TIMEOUT` `ARTIFACT_TOO_LARGE` `TRANSFER_FAILED` `MASK_NOT_CONFIGURED` `CONNECT_FAILED` など) | **1回だけ**再実行してよい(`-OutDir` は失敗時に空に戻るので同じでよい)。`ARTIFACT_TOO_LARGE` は時間範囲を広げすぎていないか確かめる。再度失敗したら、ログを添付せずに問い合わせ、問い合わせの記録と報告書に `error_code` を書く |
| 2 | 設定・資格情報・引数・実行環境の誤り(`CONFIG_*` `CREDENTIAL_*` `VERSION_MISMATCH` `ENDPOINT_NOT_FOUND` `ROLE_NOT_AVAILABLE` `NOT_ELEVATED` `TOOL_NOT_FOUND` `INVALID_ARGUMENT` `OUTPUT_DIR_NOT_EMPTY` `CLI_NOT_FOUND`) | 引数の誤り(`INVALID_ARGUMENT` `OUTPUT_DIR_NOT_EMPTY`)なら直して再実行する。それ以外は再実行しない。ログを添付せずに問い合わせ、報告書に `error_code` を書いて人間に知らせる |
| 3 | 実行中(`LOCKED`) | 再実行を繰り返さない。ログを添付せずに問い合わせ、報告書に書く |

**ログ収集が失敗しても作業15は止めない**(ログは問い合わせの精度を上げる補助である。手順書 00 ■健全性シグナルと問い合わせ ログの添付)。

## 確立時の確認(KB T05 に登録する前)

ツールを実行せずに、窓口の版・設定・マスクの指定・ツールの有無を確かめる。何も変更しない。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <このskillのフォルダ>/scripts/collect-server-logs.ps1 -InfoOnly
```

`"success":true` なら使える。`false` なら `error_code` を添えて人間に報告し、ログ収集 skill は「確立できない」として扱う(§15 H1)。

## 禁止事項

- **`bundle` の下のファイルを開かない・読まない・成果物に転記しない。** 読んでよいのは実行体が返す JSON(ログIDと件数の一覧)だけ
- ログを判定(期待結果・検証手段・待機条件・健全性シグナルの有無)に使わない
- ログ収集ツール・`Invoke-Command`・JEA を直接実行しない。サーバーのファイルを直接読む・別の手段でログを集めることをしない
- CLI の `deploy`・`cred-set`、配置用(管理者)の資格情報を使わない
- 実行体(`scripts/` 配下)、`tools/remote/`、`remote/`、`config/remote-targets.json` を書き換えない
- 資格情報を探したり、プロンプトや成果物に書き出したりしない
- 失敗を回避するために別の手段(マスクなしの収集、時間範囲を区切っての大量の実行など)を編み出さない
