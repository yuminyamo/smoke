# リモートコマンド(PmsRemote)— 導入手順

回帰テストのために、別のマシン(Hyper-V ホスト・PMS サーバーVM・将来の印刷クライアントPC)でコマンドを実行する一式の導入手順です。
**整備方針の正本は `docs/003_リモートコマンド整備方針.html`(第1部)です。** 新しいリモートコマンドを足すときは、その 9章の手順に従ってください。

**初めて導入する方へ:** 各コマンドが「どのマシンで打ち、どこに効くか」、登場するアカウントの対応、エラーの見分け方を、`docs/003` の第2部 8〜10章に図でまとめています。手順の途中で迷ったら、そちらの図と照らし合わせてください。

- 枠組みは **PowerShell リモート処理 + JEA**。どのマシンにも同じ名前のエンドポイント `PmsRemote` を置き、マシンごとに見せるロールを変えます
- **skill もテストコードも JEA を直接呼ばず、CLI 本体 `tools/remote/pms-remote.ps1` だけを呼びます**
- **PMS サーバーVMのゴールデンイメージには窓口を焼き込みません。** 復元のたびに CLI が自動で配置し直します(一度きりの前提だけをゴールデンイメージに入れます)
- 規約の正本は手順書です(`procedure/00_common.md` ■回帰実行の環境前提とテストデータ規約、`stages.md` §10・§15・§20、付録F)

```
[AI 実行環境]                                                   [Hyper-V ホスト  hyperv-host]
 skill restore-golden-image ─┐                                  JEA: PmsRemote
 skill collect-server-logs ──┼─▶ tools/remote/pms-remote.ps1 ──WinRM──▶ HyperVRead / HyperVChange(復元)
 tests/global-setup.ts ──────┘     config/remote-targets.json         │ 停止→チェックポイント適用→起動
   (tests/external/remote.ts)      資格情報(参照名)                    ▼
                                         │                      [PMS サーバーVM  pms-vm]
                                         └──────────WinRM──────▶ JEA: PmsRemote(復元のたびに deploy で配置し直す)
                                                                 ServerRead(ログ収集)/ ServerChange(将来)
```

### この文書の読み方

- 各コマンドの下に、次の3点を書いています
  - **何をする**: そのコマンドが何を作る・変える・確かめるか
  - **置き換え**: 環境に合わせて書き換える文字列。「なし」と書いたものは、そのまま打ってかまいません
  - **選ぶ**: 「どちらか一方」「必要なときだけ」のコマンドを選ぶ基準
- **`pms-remote.ps1 <サブコマンド> …` は、`powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 <サブコマンド> …` の略です。** どれも AI 実行環境の**リポジトリのルート**で打ちます(ほかのフォルダで打つと `CONFIG_NOT_FOUND`)
- CLI もインストーラも、**最後の1行に JSON** を出します。`"success":true` なら成功です。失敗したら `error_code` を見て、[8. エラーが出たとき](#8-エラーが出たとき) を引いてください

## 同梱物

| パス | 置き場所 | 内容 |
|---|---|---|
| `remote/module/PmsRemote/` | 各マシン(インストーラが `%ProgramFiles%\WindowsPowerShell\Modules\` に配置) | リモートコマンドセット(全マシン共通の1パッケージ)とロール6つ |
| `remote/Install-PmsRemote.ps1` | 各マシン(直接実行、または CLI の deploy が送り込む) | 共通インストーラ(冪等) |
| `remote/targets/<接続先名>/config.psd1` | リポジトリ(deploy が `%ProgramData%\PmsRemote\config.psd1` として配置) | リモート側の設定の原本。対象・ツール・マスクの指定などを固定する |
| `tools/remote/pms-remote.ps1`(と `lib/`) | リポジトリ | CLI 本体 |
| `config/remote-targets.json` | リポジトリ | クライアント設定(接続先・資格情報の参照名・期待する版・復元・ログの書式) |
| `.github/skills/restore-golden-image/`(原本)・`.kiro/skills/`・`.claude/skills/`(写し) | リポジトリ | 外部操作 skill(復元。CLI の restore を呼ぶ入口・lint を同梱)。直すのは原本だけ。写しは `node tools/build-skills/build-skills.mjs` が作る |
| `.github/skills/collect-server-logs/`(原本)・`.kiro/skills/`・`.claude/skills/`(写し) | リポジトリ | 外部操作 skill(ログ収集。CLI の logs-collect を呼ぶ入口を同梱)。直すのは原本だけ(同上) |
| `remote/tests/external/remote.ts` | リポジトリの `tests/external/` にコピー | テストコードから CLI を呼ぶヘルパー |
| `remote/tests/global-setup.ts` | リポジトリの `tests/` にコピー | Playwright globalSetup(回帰の一括実行前の復元) |
| `playwright.readiness.config.ts` | リポジトリのルート | 起動確認テストだけを実行する設定 |
| `remote/examples/server-ready.setup.ts` | **置かない**(参考) | 起動確認テストの雛形。作業10がログイン fixture を整備したときに `tests/readiness/` に作る |
| `remote/docs/procedure-proc-v003.patch` | 参考 | 復元を導入したときの手順書の差分(履歴) |

## 導入の流れ(全体)

丸数字は `docs/003` 第2部の図8と同じ番号です。**上から順に行います。** 「打つ場所」がいま自分のいるマシンと違うときは、そのコマンドをここで打つのは誤りです。

| 流れ | やること | 打つ場所 | 章 |
|---|---|---|---|
| ① | TrustedHosts に PMS VM の名前を登録する | AI 実行環境(管理者) | 1章 |
| ② | `config/remote-targets.json` の接続先の名前を合わせる | リポジトリのファイル | 1章 |
| ③ | `remote/targets/hyperv-host/config.psd1` の VM 名・チェックポイント名を合わせる | リポジトリのファイル | 2.1 |
| ④ | Hyper-V ホストに窓口を配置する(直接実行 **か** deploy のどちらか一方) | Hyper-V ホスト / AI 実行環境(管理者) | 2.1 |
| ⑤ | PMS VM に一度きりの準備を入れる(WinRM・ファイアウォール・**アカウント2つを作る**) | PMS VM の中(管理者) | 3.1 |
| ⑥ | ⑤で作ったアカウントのユーザー名・パスワードを `cred-set` で保存する | AI 実行環境(AI を動かすユーザー) | 3.1 |
| ⑦ | `check-target` で⑤の準備を確かめる(何も変えない) | AI 実行環境(管理者) | 3.1 |
| ⑧ | ⑦が成功したら、VM のチェックポイントを取り直す | Hyper-V ホスト(管理者) | 3.1 |
| ⑨ | `remote/targets/pms-vm/config.psd1` を直して、PMS VM に deploy する | AI 実行環境 | 3.2 |
| ⑩ | `info`・`logs-collect`・`restore` で動作を確かめる | AI 実行環境 | 3.2 |

### 登場するアカウント

**新しく作るアカウントは、PMS VM の中の2つだけです。** `cred-set` はアカウントを作るコマンドではなく、そのユーザー名とパスワードを AI 実行環境に暗号化して保存するだけです。

| アカウント | どこにあるか | 作る? | 何に使うか | 保存する参照名 |
|---|---|---|---|---|
| あなたの Windows ユーザー | AI 実行環境(と、同じ PC なら Hyper-V ホスト) | 作らない(今ログオンしているユーザー) | AI・テストの実行、`cred-set`。Hyper-V ホストへはこのユーザーで接続する | なし(`hyperv-host` の参照名は `null`) |
| 接続用ユーザー(例 `pmsremote`) | PMS VM の中 | ⑤で作る。**管理者にしない** | 窓口 `PmsRemote` への普段の接続(ログ収集など) | `pms-vm` |
| 配置用の管理者(例 `pmsadmin`) | PMS VM の中 | ⑤で作る(既存の管理者でもよい) | `deploy`・`check-target` だけ | `pms-vm-admin` |
| 仮想アカウント | 各マシン(自動) | 作らない | 窓口の関数がこの権限で動く | なし |

- 例の名前(`pmsremote`・`pmsadmin`)は自由に変えてかまいません。変えたら、⑥で入力するユーザー名を同じにします
- 参照名(`pms-vm`・`pms-vm-admin`)は保存ファイルの名前にすぎません。`config/remote-targets.json` の `credential` / `deployCredential` と同じであれば、VM のユーザー名と同じである必要はありません。特に理由がなければ変えません

## 0. 運用前に埋める値(一覧)

リポジトリに入っている値の一部は**仮の値**です。運用を始める前に、次の表の値を実際の環境に合わせてください。どれもリポジトリのファイルなので、直したら人間がレビューします(AI は書き換えません)。

| ファイル | キー | 今の値 | 決めること | いつ |
|---|---|---|---|---|
| `remote/targets/hyperv-host/config.psd1` | `Restore.VMName` | `PMS-TEST-01`(仮) | 復元する PMS サーバーVM の Hyper-V 上の名前 | Hyper-V ホストの導入前(2章) |
| 同上 | `Restore.CheckpointName` | `golden`(仮) | 戻す先のチェックポイント名(同名がちょうど1つあること) | 同上 |
| `config/remote-targets.json` | `targets.hyperv-host.host` | `localhost` | AI 実行環境と Hyper-V ホストが同じ PC なら `localhost` のまま。別なら Hyper-V ホストの名前 | 1章 |
| 同上 | `targets.pms-vm.host` | `pms-test-01`(仮) | AI 実行環境から PMS サーバーVM に接続するときの名前(名前解決できること。TrustedHosts にも同じ名前を登録する) | 1章 |
| 同上 | `targets.<名前>.credential` / `deployCredential` | `hyperv-host` は `null`、`pms-vm` は `pms-vm` / `pms-vm-admin` | 資格情報の参照名。名前を決めたら `cred-set <参照名>` で保存する(値はファイルに書かない)。`null` はログオン中のユーザーで接続する | 1章 |
| 同上 | `targets.pms-vm.restoredBy` / `restore.winrmTimeoutSec` | `hyperv-host`(書いてある) / `30` | そのままでよい。PMS VM の準備(3.1)が整うまでは、復元のたびに約30秒待って配置の警告が出る。準備のあとも `WINRM_TIMEOUT` が出るなら秒数を延ばす | 3.2 |
| 同上 | `logCollect.logIdPattern` | `PMS-[A-Z]-\d{4}` 形式(仮) | ログに出るログIDの形に合う正規表現。名前付きグループ `id` が必須 | 3.2 |
| 同上 | `logCollect.levelPattern` / `entryPattern` / `scanInclude` / `encoding` | `ERROR` などの語 / 空 / `*.log`・`*.txt` / `utf-8` | ログのレベルの書き方、1件の先頭行の形(任意)、数える対象のファイル名、文字コード | 3.2 |
| `remote/targets/pms-vm/config.psd1` | `LogCollect.ExePath` | `C:\PMS\tools\LogCollector.exe`(仮) | PMS サーバー上のログ収集ツールのパス | PMS VM への配置前(3.2) |
| 同上 | `LogCollect.Arguments` | `-from {From} -to {To} -out {OutDir} {Mask}`(仮) | ツールの引数の並び。時間範囲・出力先・マスクの位置を `{From}` `{To}` `{OutDir}` `{Mask}` で書く | 同上 |
| 同上 | `LogCollect.MaskArguments` | `-mask`(仮) | マスクを有効にする指定。空にするとログ収集は必ず失敗する | 同上 |
| 同上 | `LogCollect.SuccessExitCodes` | `@(0)` | ツールが正常終了のときに返す終了コード | 同上 |
| 同上 | `LogCollect.TimeZone` / `TimeFormat` | `GuestLocal` / `yyyy-MM-ddTHH:mm:sszzz` | ツールが受け付ける時刻の時差と書式(サーバーの現地時刻か UTC か、時差を付けるか) | 同上 |
| PMS サーバーVM(ゴールデンイメージ) | ローカルアカウント2つ | — | JEA に接続するユーザー(管理者でなくてよい)と配置用の管理者。どちらもパスワード無期限(3.1) | 3.1 |

上限時間などの値(`TimeoutSec`・`MaxWindowMinutes`・`MaxArtifactMB`・`restore.readiness.timeoutSec`・`restore.winrmTimeoutSec`)は既定のままで始めてよく、実測を見て直します。

**`remote/targets/<接続先名>/config.psd1` を、配置したあとに直したとき**は、`pms-remote.ps1 deploy -Target <接続先名> -Force` で配置し直します。`-Force` がないと、マシンに置かれた既存の設定は上書きされず、警告(`the existing config differs …`)が出るだけです。

---

## 1. AI 実行環境の準備(1回)

### ① TrustedHosts に PMS VM の名前を登録する

管理者の PowerShell で打ちます。

```powershell
Set-Item WSMan:\localhost\Client\TrustedHosts -Value 'pms-test-01' -Concatenate -Force
Get-Item WSMan:\localhost\Client\TrustedHosts      # 登録できたかの確認(Value に名前が出る)
```

- **何をする**: 手元の PC の WinRM クライアントの設定に、「この名前の相手には、ドメインの仕組みなしでパスワード認証(NTLM)で接続してよい」と登録します。**相手のマシンは何も変わりません。** `-Concatenate` は既存の登録に追加する指定で、ほかの登録を消しません
- **置き換え**: `'pms-test-01'` → `config/remote-targets.json` の `targets.pms-vm.host` に書く名前。Hyper-V ホストが別の PC なら、その名前も同じように登録します
- **選ぶ**: Hyper-V ホストが同じ PC(`localhost`)の間は、Hyper-V ホストについては不要です。PMS VM については必要です
- **名前で接続できるか**も、ここで確かめておきます

  ```powershell
  [System.Net.Dns]::GetHostAddresses('pms-test-01')   # VM の IP アドレスが出れば OK
  ```

  エラーになる(名前を解決できない)ときは、DNS に登録するか、管理者のメモ帳で `C:\Windows\System32\drivers\etc\hosts` に `<VM の IP アドレス> pms-test-01` の1行を足します(置き換え: IP アドレスと名前)
- **エラー**: 「WinRM サービスが実行されていない」旨のエラーなら `Start-Service WinRM` を打ってからやり直します。「アクセスが拒否されました」なら、管理者として開いた PowerShell で打ちます

### ② 接続先の名前を合わせる

`config/remote-targets.json` の `targets.<名前>.host` を実際の名前に合わせます(0章の一覧)。

- **何をする**: CLI はこのファイルを読んで、`-Target hyperv-host` や `-Target pms-vm` が「どの名前のマシンか」「どの資格情報を使うか」を決めます
- **置き換え**: `host` の値だけ。`credential` / `deployCredential` の参照名と、`hyperv-host`・`pms-vm` という接続先名(キー)はそのままにします

### (資格情報の保存は 3.1 の⑥で行います)

資格情報(`cred-set`)は、PMS VM の中でアカウントを作ったあと(⑤)でないと保存する値がないため、3.1 の⑥に移しました。Hyper-V ホストが同じ PC の間は、Hyper-V ホスト用の資格情報は要りません(参照名が `null` = ログオン中のユーザーで接続する)。

## 2. Hyper-V ホスト(hyperv-host)

### 2.1 新規に導入する

#### ③ 復元の対象を確かめる

`remote/targets/hyperv-host/config.psd1` の `Restore` を、Hyper-V ホストの実際の値に合わせます。Hyper-V ホストの PowerShell(管理者)で、次のコマンドで確かめられます。

```powershell
Get-VM | Select-Object Name, State                          # Name 列 → VMName に書く値
Get-VMSnapshot -VMName PMS-TEST-01 | Select-Object Name     # Name 列 → CheckpointName に書く値
```

- **何をする**: 確認だけです(何も変えません)。`config.psd1` の値は窓口の中で固定され、AI やテストコードからは変えられません
- **置き換え**: 2行目の `PMS-TEST-01` → 1行目で分かった VM 名
- **前提**: 復元先のチェックポイントは、**同じ名前がちょうど1つ**であること(2つ以上あると `CHECKPOINT_AMBIGUOUS` で止まります)

#### ④ 窓口を配置する(どちらか一方)

**選ぶ**: 結果はどちらも同じです。

| 状況 | 選ぶ方法 |
|---|---|
| AI 実行環境と Hyper-V ホストが**別の PC** | **A. ホストで直接実行**(B は Hyper-V ホスト用の資格情報と TrustedHosts の登録が別に要るため) |
| **同じ PC** で、管理者の PowerShell で `Test-WSMan localhost` が**エラー**になる(Windows 10/11 の既定) | **A. ホストで直接実行**(インストーラが WinRM を有効にする) |
| **同じ PC** で、`Test-WSMan localhost` が応答する | A・B どちらでもよい。迷ったら **B. deploy**(接続許可グループに入れるユーザーを自動で決め、配置後に窓口が使えるかまで確かめる) |
| 2回目以降(モジュールの版を上げたときなど) | B. deploy でよい |

**A. ホストで直接実行**(Hyper-V ホストの管理者の PowerShell。リポジトリのルートで。ホストが別の PC なら、リポジトリ(少なくとも `remote` フォルダ)をホストにコピーして、その場所で)

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force   # この PowerShell の窓だけ、スクリプトの実行を許す
.\remote\Install-PmsRemote.ps1 -Role HyperVRead,HyperVChange -ConfigFile .\remote\targets\hyperv-host\config.psd1 -OperatorUser "$env:USERDOMAIN\$env:USERNAME"
```

- **何をする**: このマシンに、①モジュールを `%ProgramFiles%\WindowsPowerShell\Modules\PmsRemote` に置く、②設定 `%ProgramData%\PmsRemote\config.psd1` を作る、③接続許可グループ `PmsRemoteRead` / `PmsRemoteChange` を作り `-OperatorUser` を入れる、④WinRM が無効なら有効にする、⑤エンドポイント `PmsRemote` を登録して WinRM を再起動する。**何度実行しても同じ状態になります**(2回目は `"message":"no changes"`)
- **置き換え**:
  - `-OperatorUser`: JEA に接続するユーザー = **AI と回帰テストを動かす Windows ユーザー**。`"$env:USERDOMAIN\$env:USERNAME"` は「今この PowerShell を動かしているユーザー」に置き換わります。AI を動かすのと同じユーザーで管理者の PowerShell を開いたなら、そのままでかまいません(`whoami` で確かめられます)。別のユーザーなら `-OperatorUser yu` のように名前を直接書きます。ローカル管理者である必要はありません
  - Hyper-V ホストが AI 実行環境と別の PC なら、`-OperatorUser` には AI 実行環境から接続に使う**ホスト側の**ユーザーを書き、AI 実行環境でそのユーザーを `cred-set` して、`config/remote-targets.json` の `hyperv-host.credential` にその参照名を書きます
  - `-Role` と `-ConfigFile` はそのまま(Hyper-V ホストに見せるロールと、その設定の原本です)
- 1行目は、スクリプトの実行が禁止されている PC(Windows 10/11 の既定)で「このシステムではスクリプトの実行が無効」と言われないためのものです。この窓を閉じれば元に戻ります

**B. AI 実行環境から deploy**(AI 実行環境とホストが同じ PC。管理者の PowerShell で)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 deploy -Target hyperv-host
```

- **何をする**: A と同じインストーラを、CLI が WinRM 経由で送り込んで実行します。`-OperatorUser` には通常用の資格情報のユーザー(参照名が `null` ならログオン中のユーザー)が自動で入ります。最後に、窓口に接続して版が合うことまで確かめます
- **置き換え**: なし
- 管理者として開いていない PowerShell で打つと、自分の PC への接続が「アクセスが拒否されました」(`CONNECT_FAILED`)になります

**A・B 共通**

- 作られるもの: ローカルグループ `PmsRemoteRead` / `PmsRemoteChange`、JEA エンドポイント `PmsRemote`(実行は仮想アカウント。Hyper-V のロールだけなら権限は Hyper-V Administrators のみ)、設定 `%ProgramData%\PmsRemote\config.psd1`、操作記録 `...\Transcripts\`・`...\state\operations.log`
- 前提: 対象 VM に、復元先の運用チェックポイントが**名前の重複なく1つだけ**あること(インストーラが確かめます)
- 確認(何も変えません。VM も戻しません):

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 restore -InfoOnly
  ```

  `"success":true` で、`vm`・`checkpoint` が③の値になり、`info.checkpoint_count` が `1` なら OK です
  - **何をする**: 窓口 `PmsRemote` に接続し、VM とチェックポイントの状態を読むだけです。**`-InfoOnly` を付け忘れると本当に復元が走る**ので注意してください
  - **置き換え**: なし

### 2.2 旧版(PmsGoldenRestore)から移行する

**選ぶ**: Hyper-V ホストの PowerShell で次を打ち、**結果が出たときだけ**行います。「見つかりません」のエラーになるなら旧版は入っていないので、2.2 は飛ばします。

```powershell
Get-PSSessionConfiguration -Name PmsGoldenRestore
```

旧版の一式(`golden-restore/`、エンドポイント `PmsGoldenRestore`)を導入済みのホストでは、2.1 の導入のあとに旧版を取り除きます(管理者の PowerShell で)。

```powershell
Unregister-PSSessionConfiguration -Name PmsGoldenRestore -Force
Remove-Item "$env:ProgramFiles\WindowsPowerShell\Modules\PmsGoldenRestore" -Recurse -Force
Remove-LocalGroup -Name PmsRestoreOperators
# 旧設定の VM 名・チェックポイント名を remote/targets/hyperv-host/config.psd1 に移してから
Remove-Item "$env:ProgramData\PmsGoldenRestore" -Recurse -Force
```

- **何をする**: 旧版の窓口・モジュール・接続許可グループ・設定を消します。新しい `PmsRemote` には影響しません
- **置き換え**: なし(旧版の固定の名前です)。最後の行の前に、`%ProgramData%\PmsGoldenRestore` の中の設定ファイルに書いてある VM 名・チェックポイント名を、③の `config.psd1` に写しておきます(消すと見られなくなります)

AI 実行環境側の旧資格情報 `%APPDATA%\PmsGoldenRestore\credential.xml` を使っていた場合は、`cred-set` で参照名を付けて保存し直し、`config/remote-targets.json` の `hyperv-host.credential` に書きます。復元記録(`work/_common/env-restore-log.jsonl`)はそのまま使えます。

## 3. PMS サーバーVM(pms-vm)

`config/remote-targets.json` の `pms-vm` には、最初から `"restoredBy": "hyperv-host"` が書いてあります。復元のたびに、CLI が PMS VM の WinRM の応答を待ち(`restore.winrmTimeoutSec` = 30 秒まで)、窓口を自動で配置します。

**下の 3.1 の準備が整うまでは、復元のたびに約30秒待ったあと、配置の警告が出ます。** 復元自体は成功し、作業10・20と回帰の一括実行はそのまま進みます(出力の `deploy` に `"status":"failed"` と `WINRM_TIMEOUT` などが残り、ログ収集は使えません)。警告をなくすには 3.1 の準備をしてください。

### 3.1 PMS VM の一度きりの準備(ゴールデンイメージに一度だけ入れる)

窓口(エンドポイント・モジュール)はゴールデンイメージに焼き込みません。入れるのは次の前提だけです(docs/003 C-5)。順序は「**VM をゴールデンイメージの状態に戻す → ⑤ 準備を入れる → ⑥ 資格情報を保存 → ⑦ `check-target` → ⑧ チェックポイント**」です(作業中のデータを混ぜないため)。

**準備の前に、VM をゴールデンイメージの状態に戻します。** 2章が終わっていれば、AI 実行環境で次を打ちます。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 restore -Purpose manual
```

- **何をする**: PMS VM を電源断 → チェックポイント適用 → 起動します。**VM の中の作業中のデータは消えます**
- **置き換え**: なし(`-Purpose manual` は「人が手で行った復元」の印です)
- この時点では準備がまだなので、約30秒待って配置の警告(`WINRM_TIMEOUT`)が出ます。起動確認テストがまだなければ終了コード 4 で終わります。**どちらも想定どおり**です。VM が起動したら次へ進みます
- 2章の前なら、Hyper-V マネージャーで VM のチェックポイントを右クリック →「適用」でもかまいません

#### ⑤ PMS VM の中での準備

Hyper-V マネージャーで VM に接続し、**VM の中で、管理者の PowerShell** を開いて行います(AI 実行環境ではありません)。

**⑤-1 WinRM を有効にする**

```powershell
Enable-PSRemoting -Force -SkipNetworkProfileCheck
```

- **何をする**: WinRM サービスを動かし、外からの接続を受け付ける窓口(HTTP 5985 番)を作ります。Windows Server では最初から有効なことが多く、その場合は何も変わりません
- **置き換え**: なし

**⑤-2 WinRM を遅延なしの自動開始にする**

```powershell
sc.exe config WinRM start= auto
```

- **何をする**: VM の起動直後から WinRM が応答するようにします。「自動(遅延開始)」のままだと、復元直後の30秒以内に応答せず、準備が整っていても配置が毎回警告になることがあります
- **置き換え**: なし。`start=` のあとの空白は必須です。PowerShell では `sc` が別のコマンドを指すため、必ず `sc.exe` と打ちます

**⑤-3 ファイアウォールで 5985 番を開ける(必要なときだけ)**

**選ぶ**: AI 実行環境で次を打ち、`TcpTestSucceeded : True` なら不要です。

```powershell
Test-NetConnection pms-test-01 -Port 5985      # AI 実行環境で打つ(置き換え: pms-test-01 → pms-vm.host)
```

`False` で、VM の中の `Get-NetConnectionProfile` の `NetworkCategory` が `Public` なら、既定の規則が同じサブネットからしか受け付けていません。VM の中で次を打ちます。

```powershell
Set-NetFirewallRule -Name WINRM-HTTP-In-TCP-PUBLIC -RemoteAddress 192.168.10.0/24
```

- **何をする**: WinRM の受信規則が受け付ける相手のアドレスを広げます
- **置き換え**: `192.168.10.0/24` → AI 実行環境の IP アドレス、またはそのサブネット。`Any` にするとどこからでも受け付けます(隔離されたネットワークの外に出る VM では避けます)

**⑤-4 配置用の管理者アカウント**

新しく作る場合:

```powershell
$pw = Read-Host -AsSecureString 'pmsadmin のパスワード'
New-LocalUser -Name pmsadmin -Password $pw -PasswordNeverExpires -Description 'PmsRemote 配置用'
Add-LocalGroupMember -SID S-1-5-32-544 -Member pmsadmin    # S-1-5-32-544 = Administrators(OS の言語によらない書き方)
```

既存の管理者を使う場合は、パスワードを無期限にするだけです。

```powershell
Set-LocalUser -Name pmsadmin -PasswordNeverExpires $true
```

- **何をする**: `deploy` と `check-target` が、窓口を作るために使う**この VM のローカル管理者**を用意します。**パスワードを無期限にする**のは、期限付きだと(復元で時計が戻ることもあり)数か月後に接続できなくなるためです
- **置き換え**: `pmsadmin` → 好きな名前(⑥で同じ名前を入力します)。パスワードは入力を求められたときに打ちます
- **選ぶ**: ビルトインの `Administrator` を使ってもかまいません。その場合は⑤-5 が不要です

**⑤-5 ローカルアカウントでの遠隔管理を許す(必要なときだけ)**

**選ぶ**: ⑤-4 にビルトインの `Administrator` **以外**のアカウントを使うときだけ行います。

```powershell
Set-ItemProperty -Path HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System -Name LocalAccountTokenFilterPolicy -Value 1 -Type DWord
```

- **何をする**: ローカルの管理者アカウントで遠隔から接続したときに、Windows が管理者の権限を削らないようにします。これがないと、管理者なのに遠隔からは「アクセスが拒否されました」になるか、`check-target` の `admin_elevated` が失敗します
- **置き換え**: なし

**⑤-6 JEA に接続するユーザー(接続用ユーザー)**

```powershell
$pw = Read-Host -AsSecureString 'pmsremote のパスワード'
New-LocalUser -Name pmsremote -Password $pw -PasswordNeverExpires -Description 'PmsRemote 接続用'
```

- **何をする**: 窓口 `PmsRemote` に普段接続する、**管理者でない**ローカルユーザーを作ります。窓口の接続許可グループ(`PmsRemoteRead` / `PmsRemoteChange`)に入れる作業は、⑨の `deploy` が行うので、ここではグループに入れません
- **置き換え**: `pmsremote` → 好きな名前(⑥で同じ名前を入力します)

**⑤-7 名前を確かめる**

```powershell
hostname
```

- **何をする**: この VM のコンピューター名を表示します。⑥でユーザー名の前に付けるので控えておきます(Hyper-V 上の VM 名と違うことがあります)
- AI 実行環境から `config/remote-targets.json` の `pms-vm.host`(既定 `pms-test-01`)で名前解決できること、TrustedHosts に同じ名前があることは、①で確かめました

**⑤-8 ログ収集ツールがあること**

```powershell
Test-Path 'C:\PMS\tools\LogCollector.exe'     # True なら OK
```

- **置き換え**: パス → `remote/targets/pms-vm/config.psd1` の `LogCollect.ExePath` の値。ゴールデンイメージに含まれていれば追加の作業はありません

#### ⑥ 資格情報を保存する(AI 実行環境で)

AI 実行環境に戻り、**AI と回帰テストを動かすのと同じ Windows ユーザー**で、リポジトリのルートで打ちます(管理者でなくてよい)。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 cred-set pms-vm         # ⑤-6 の接続用ユーザー
powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 cred-set pms-vm-admin   # ⑤-4 の配置用の管理者
```

- **何をする**: 端末の中で、ユーザー名とパスワード(確認のため2回)を聞かれます。入力した値を、このユーザー・この PC でしか開けない形(DPAPI)で `%APPDATA%\PmsRemote\cred\<参照名>.xml` に保存します。**アカウントを作るのではありません。** パスワードが正しいかもここでは確かめません(⑦で分かります)
- 入力画面(ウィンドウ)は出しません。VS Code の端末や SSH でも、そのまま入力できます。ユーザー名は `-UserName PMS-TEST-01\pmsremote` のように引数で渡してもかまいません(そのときはパスワードだけ聞かれます)
- ユーザー名が `<コンピューター名>\<ユーザー名>` の形でないとき(`pmsremote` だけ、`.\pmsremote` など)と、2回のパスワードが一致しないときは、何も保存せずに `INVALID_ARGUMENT` で止まります
- **入力する値**:

  | コマンド | ユーザー名の欄 | パスワードの欄 |
  |---|---|---|
  | `cred-set pms-vm` | `<⑤-7 のコンピューター名>\<⑤-6 のユーザー名>`(例 `PMS-TEST-01\pmsremote`) | ⑤-6 で決めたパスワード |
  | `cred-set pms-vm-admin` | `<⑤-7 のコンピューター名>\<⑤-4 のユーザー名>`(例 `PMS-TEST-01\pmsadmin`) | ⑤-4 のパスワード |

- **置き換え**: コマンドの参照名 `pms-vm` / `pms-vm-admin` はそのまま(`config/remote-targets.json` の `credential` / `deployCredential` と同じ名前にする必要があります)。入力欄の値は環境に合わせます
- 打ち間違えたら、同じコマンドをもう一度打てば上書きされます
- 別の Windows ユーザーで保存すると、AI が使うときに `CREDENTIAL_INVALID` になります

#### ⑦ 準備を確かめる(何も変えない)

AI 実行環境で、**管理者の PowerShell** で打ちます(手元の TrustedHosts を読むため。管理者でないと `client_trusted_hosts` が確かめられず失敗します)。⑥と同じユーザーのまま「管理者として実行」で開けば、保存した資格情報はそのまま使えます。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 check-target -Target pms-vm
```

- **何をする**: 配置用の管理者(`pms-vm-admin`)で VM に接続し、⑤の前提がそろっているかを確かめます。**VM には何も変更を加えません**
- **置き換え**: なし
- `"success":true` なら⑧へ。失敗したら、出力の `checks` の中で `"ok":false` の項目を見て直します

  | 項目 | 意味 | 直す場所 |
  |---|---|---|
  | `winrm_reachable` | VM の 5985 番に届かない | ⑤-1〜⑤-3、①の名前解決 |
  | `client_trusted_hosts` | 手元の TrustedHosts に名前がない(`null` は管理者でないため読めなかった) | ① |
  | `admin_session` | 配置用の管理者で接続できない | ⑥の入力(ユーザー名の形・パスワード)、⑤-4、⑤-5 |
  | `admin_elevated` | 接続できたが管理者の権限がない | ⑤-5、⑤-4 で Administrators に入れたか |
  | `password_never_expires` | 配置用の管理者のパスワードに期限がある | ⑤-4 |
  | `endpoint_registered` / `installed_version` | 窓口がまだない | 参考情報(必須ではない)。⑨の前は `false` で正常 |

#### ⑧ チェックポイントを取り直す(⑦が成功したときだけ)

`"success":true` になったら、**このときだけ** VM のチェックポイントを取り直します。チェックポイント名は `remote/targets/hyperv-host/config.psd1` の `CheckpointName` と同じにし、同名のチェックポイントがちょうど1つになるようにします。Hyper-V ホストの管理者の PowerShell で:

```powershell
Rename-VMSnapshot -VMName PMS-TEST-01 -Name golden -NewName golden-old   # 古いゴールデンイメージを別名で残す
Checkpoint-VM -Name PMS-TEST-01 -SnapshotName golden                       # 今の状態を新しい golden にする
```

確認して問題がなければ、古いほうを消します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 restore -InfoOnly   # AI 実行環境で。checkpoint_count が 1 なら OK
Remove-VMSnapshot -VMName PMS-TEST-01 -Name golden-old                                             # Hyper-V ホストで
```

- **何をする**: 準備を入れた今の VM の状態を、復元先(ゴールデンイメージ)にします。古いものを先に別名にするのは、同じ名前が2つになる(`CHECKPOINT_AMBIGUOUS`)のを防ぎ、失敗したときに戻れるようにするためです
- **置き換え**: `PMS-TEST-01` → `config.psd1` の `VMName`、`golden` → `CheckpointName`
- Hyper-V マネージャーで同じことをしてもかまいません(既存の golden の名前を変える → チェックポイントを作る → 名前を golden にする)

### 3.2 配置と確認

#### ⑨ 設定を合わせて配置する

1. `remote/targets/pms-vm/config.psd1` の `LogCollect`(ツールのパス・引数・マスクの指定・成功とみなす終了コード・時刻の書式)を製品のログ収集ツールに合わせます(0章の一覧)。あわせて `config/remote-targets.json` の `logCollect`(ログIDの形など)も合わせます
2. 配置します(以後は復元のたびに自動で行われます)

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 deploy -Target pms-vm
   ```

   - **何をする**: 配置用の管理者(`pms-vm-admin`)で VM に接続し、モジュール・インストーラ・設定の原本を送り込んでインストーラを実行します(ロール `ServerRead`・`ServerChange`)。接続用ユーザー(`pms-vm` に保存したユーザー)を接続許可グループに入れ、最後にそのユーザーで窓口に接続して、版が合うことまで確かめます。出力の `status` が `deployed`(配置した)か `skipped`(同じ版が配置済み)なら成功です
   - **置き換え**: なし
   - **選ぶ**: 1 の `config.psd1` を、配置したあとに直したときは `-Force` を付けます(復元した直後の VM なら不要)
   - 窓口(エンドポイント)の登録と WinRM の再起動は、配置中の接続を切らないよう、VM の中で約10秒後に動くタスクが行います(出力の `actions` に `endpoint_registration_scheduled`)。CLI はその再起動を待ってから窓口の版を確かめるので、完了まで数十秒かかります。`DEPLOY_VERIFY_FAILED` になったら、VM の中の `C:\ProgramData\PmsRemote\state\restart-winrm.log` を見ます

#### ⑩ 動作を確かめる

3. 窓口の版と設定を確かめます(何も変えません)

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 info -Target pms-vm
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 logs-collect -InfoOnly
   ```

   - **何をする**: `info` は版・ロール・モジュールと設定がリポジトリと同じかを返します(`module_matches`・`config_matches`・`roles_match` がすべて `true` なら OK)。`logs-collect -InfoOnly` は、ツールを**実行せずに**、ツールの有無(`tool_present`)・マスクの指定(`masked`)・管理者権限を確かめます
   - **置き換え**: なし

4. 短い時間範囲でログを実際に集めてみます

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 logs-collect -From 2026-10-06T10:00:00+09:00 -To 2026-10-06T10:10:00+09:00 -OutDir work\_tmp\logs-test
   ```

   - **何をする**: VM の中でログ収集ツールを(マスクを付けて)実行し、結果を `-OutDir` に受け取って、ログIDと件数の一覧を返します。VM の状態は変えません
   - **置き換え**: `-From` / `-To` → PMS を操作してログが出ていそうな、最近の時間範囲(時差 `+09:00` 付き。`MaxWindowMinutes` = 180 分まで)。`-OutDir` → **まだない、または空のフォルダ**(同じフォルダに2回集めると `OUTPUT_DIR_NOT_EMPTY`。2回目は `logs-test2` などに変える)
   - 展開したファイルと出力の `log_ids` が一致するか(`config/remote-targets.json` の `logCollect.logIdPattern` が合っているか)を一度確かめてください

5. 復元を1回行い、復元のあとの自動配置を確かめます

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 restore -Purpose manual
   ```

   - **何をする**: VM をゴールデンイメージに戻し(**作業中のデータは消えます**)、WinRM の応答を待って窓口を配置し、起動確認を行います
   - **置き換え**: なし
   - 出力の `deploy` が `"status":"deployed"` になることを確かめます。準備のあとも `WINRM_TIMEOUT` が出る場合は、⑤-2(遅延開始)を確かめ、それでも足りなければ `restore.winrmTimeoutSec` を延ばしてください。起動確認テストがまだなければ終了コード 4 で終わり、Web UI へのログインは人が確かめます

版が安定したら、配置済みの状態でチェックポイントを取り直してもかまいません(任意。手順は⑧と同じ)。復元後の配置が「版が同じなので何もしない」になり、復元が数十秒速くなります。

## 4. Playwright の設定

`remote/tests/external/remote.ts` を `tests/external/`、`remote/tests/global-setup.ts` を `tests/` にコピーし、`playwright.config.ts` に globalSetup と起動確認の setup project を追加します。

```powershell
New-Item -ItemType Directory -Force tests\external | Out-Null
Copy-Item remote\tests\external\remote.ts tests\external\
Copy-Item remote\tests\global-setup.ts tests\
```

- **何をする**: テストコードから CLI を呼ぶヘルパーと、回帰の一括実行の前に復元する globalSetup を、テストのフォルダに置きます
- **置き換え**: なし

```ts
// playwright.config.ts(抜粋)
export default defineConfig({
  globalSetup: './tests/global-setup.ts',        // PMS_RESTORE=1 のときだけ復元する
  projects: [
    // 起動確認: Web UI にログインできるまで待つ(ファイルは作業10がログイン fixture 整備時に作る)
    { name: 'readiness', testDir: './tests/readiness', testMatch: /server-ready\.setup\.ts/ },
    // 既存の project はすべて readiness に依存させ、tests/readiness を対象から外す
    { name: 'default', testDir: './tests/specs', dependencies: ['readiness'] },
  ],
});
```

- **置き換え**: `default` と `./tests/specs` → 既存の `playwright.config.ts` にある project の名前と `testDir`。既存の project が複数あれば、すべてに `dependencies: ['readiness']` を付けます
- **globalSetup は既定で復元しません。** 作業20の「復元せずに3回連続実行」や個別のデバッグ実行で勝手に復元されると、再実行耐性の確認が無意味になるためです(`PMS_RESTORE=1` で起動したときだけ)
- テストコードからリモートコマンドを使うときは、`tests/external/remote.ts` の `runRemote()` で CLI を呼びます。JEA を直接呼びません
- 起動確認テストの作り方と判定の条件は、手順書 00 ■回帰実行の環境前提(起動完了の判定)と `remote/examples/server-ready.setup.ts` を参照してください。ログイン fixture がまだない間は、復元が終了コード 4 を返し、人間がログインを確かめます

## 5. CLI と出力

```
pms-remote.ps1 <サブコマンド> [-Target <接続先名>] [引数]
```

実際に打つときは `powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 <サブコマンド> …` の形で、リポジトリのルートで打ちます。`-Target` には `config/remote-targets.json` の `targets` のキー(`hyperv-host`・`pms-vm`)を書きます。

| サブコマンド | 内容 | 変更するか | 主な利用者 |
|---|---|---|---|
| `info -Target <名前>` | 版・ロール・モジュールと設定がリポジトリと同じか | しない | 人間 |
| `check-target -Target <名前>` | 接続先の一度きりの前提を確かめる(配置用の資格情報を使う) | しない | 人間 |
| `deploy -Target <名前> [-Force]` | 共通インストーラを送り込んで実行する(配置用の資格情報を使う)。`-Force` は既存の設定を上書きする | する(接続先) | 人間・restore |
| `cred-set <参照名>` | 資格情報を保存する(対話) | する(手元の保存ファイルだけ) | 人間 |
| `restore [-Purpose] [-FlowId] [-SkipReadiness] [-InfoOnly]` | 復元 → 復元した接続先への配置 → 起動確認 → 復元記録。`-InfoOnly` は状態を読むだけ | する(VM を戻す)。`-InfoOnly` はしない | skill restore-golden-image・globalSetup |
| `logs-collect -From -To -OutDir [-InfoOnly]` / `logs-ids -OutDir` | ログ収集(ログIDと件数の一覧を返す)。`logs-ids` は集めたフォルダから一覧を作り直す(接続しない) | しない(手元の `-OutDir` に書く) | skill collect-server-logs |

標準出力の最後に1行の JSON を出します(進捗は標準エラー。非ASCII 文字は `\uXXXX`)。共通のキーは `success`・`command`・`target`・`error_code`・`message`・`started_at`・`completed_at`・`duration_sec` です。

| 終了コード | 意味 | 主な error_code |
|---|---|---|
| 0 | 成功 | — |
| 1 | 実行の失敗 | `CONNECT_FAILED` `CHECKPOINT_AMBIGUOUS` `STOP_TIMEOUT` `HEARTBEAT_TIMEOUT` `HYPERV_ERROR` `READINESS_FAILED` `TOOL_FAILED` `TOOL_TIMEOUT` `ARTIFACT_TOO_LARGE` `TRANSFER_FAILED` `MASK_NOT_CONFIGURED` `DEPLOY_FAILED` |
| 2 | 設定・資格情報・引数・実行環境の誤り | `CONFIG_NOT_FOUND` `CONFIG_INVALID` `TARGET_NOT_FOUND` `CREDENTIAL_NOT_FOUND` `CREDENTIAL_INVALID` `INVALID_ARGUMENT` `VERSION_MISMATCH` `ENDPOINT_NOT_FOUND` `ROLE_NOT_AVAILABLE` `NOT_ELEVATED` `TOOL_NOT_FOUND` `OUTPUT_DIR_NOT_EMPTY` `NOT_A_BUNDLE` `READINESS_COMMAND_UNAVAILABLE` `TARGET_NOT_READY` |
| 3 | 実行中 | `LOCKED` |
| 4 | 成功したが人間の確認が要る | restore で起動確認テストがまだない(`readiness: unavailable`) |

`VERSION_MISMATCH` と `ENDPOINT_NOT_FOUND` は、その接続先に `deploy` すれば直ります。リポジトリのモジュールの版(`remote/module/PmsRemote/PmsRemote.psd1`)を上げたら、`config/remote-targets.json` の `expectedVersion` も上げてください。

## 6. 呼び忘れの検出(lint `env_restored`)

```powershell
.kiro\skills\restore-golden-image\scripts\Test-EnvRestoreMarker.ps1 -StatusFile work\PRT\exploration\status.yaml -Purpose work10 -WorkRoot work
```

- **何をする**: 作業の `status.yaml` に書かれた restore_id が、本当に復元記録にあるか(skill を呼んだか)を確かめます。何も変えません
- **置き換え**: `work\PRT\exploration\status.yaml` → 確かめたい作業の `status.yaml`(`PRT` は機能ID)。`-Purpose` → その作業の目的(`work10` / `work20` / `regression`)

復元記録の場所は `config/remote-targets.json` の `restore.markerLog` から読みます。

| コード | 検出内容 |
|---|---|
| ENV001 | status.yaml に `env_restore.restore_id` がない(skill を呼んでいない) |
| ENV002 | その restore_id が復元記録にない、または失敗している(値の捏造・失敗の見落とし) |
| ENV003 | 復元の目的が作業と合わない(作業20で作業10の復元を流用 等) |
| ENV004 | 同じ restore_id を別の作業が使っている(復元の使い回し) |
| ENV005 | 起動確認の記録が矛盾する(起動確認テストがなかったのに `readiness: human` になっていない 等) |

## 7. 設計上の注意

- 復元はホスト側で「電源断 → チェックポイント適用 → 起動 → ハートビート待ち」、続いて CLI 側で配置と起動確認(ログイン)を待ちます。Java アプリケーションサーバーの起動が遅い環境では `restore.readiness.timeoutSec` を延ばしてください
- ゲストの統合サービス(ハートビート)を無効にしている場合は、`remote/targets/hyperv-host/config.psd1` で `RequireHeartbeat = $false`
- 同時に2つの復元が走らないよう、ホスト側でロックしています。**マシンをまたいだ排他はしません**(復元中に PMS VM でログ収集が走ると、収集は途中で失敗します)
- **ログイン画面が変わると、起動確認が「サーバー未起動」のようにタイムアウトします。** 失敗時は起動確認テストの出力とスクリーンショットで、ログインの部品が壊れたのか、サーバーが起動しないのかを見分けてください
- ログ収集ツールの標準出力・標準エラーはマスクの対象か分からないため、成果物に含めず PMS VM の作業フォルダに残します(失敗時の調査用。復元で消えます)
- PMS VM の操作記録(トランスクリプト・`operations.log`)は復元で消えます
- JEA は「AI とテストコードが呼べる操作を定義した関数に限る枠」であり、セキュリティの境界ではありません(配置用の管理者の資格情報が存在するため。docs/003 1.2)。skill から配置用の資格情報・`deploy` を使わせないでください

## 8. エラーが出たとき

まず出力の最後の1行の JSON で `error_code` と `message` を見ます。接続のエラーがどの段階で止まったかは、`docs/003` 第2部の図11(接続が通る関門)も参考になります。

### PowerShell 自体のエラー(JSON が出ない)

| 見えるもの | 原因 | 直し方 |
|---|---|---|
| 「このシステムではスクリプトの実行が無効になっているため…」 | 実行ポリシーでスクリプトが禁止されている | `Install-PmsRemote.ps1` を直接実行するときは、先に `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`(④-A)。CLI は `powershell -NoProfile -ExecutionPolicy Bypass -File …` の形で打つ |
| 「…管理者として実行するための #requires ステートメントが含まれています」 | インストーラを管理者でない PowerShell で実行した | PowerShell を右クリック →「管理者として実行」で開き直す |
| TrustedHosts の `Set-Item` で「WinRM サービス…」 | 手元の WinRM サービスが止まっている | `Start-Service WinRM` のあとでやり直す |

### CLI の error_code

| error_code | 主な原因 | 直し方 |
|---|---|---|
| `CONFIG_NOT_FOUND` | リポジトリのルート以外で打った | リポジトリのルートに `cd` してから打つ |
| `TARGET_NOT_FOUND` | `-Target` の名前の誤り | `hyperv-host` か `pms-vm`(`remote-targets.json` の `targets` のキー) |
| `CREDENTIAL_NOT_FOUND` | その参照名の資格情報をまだ保存していない | `message` に出るとおり `cred-set <参照名>`(⑥) |
| `CREDENTIAL_INVALID` | 別の Windows ユーザー・別の PC で保存した | AI を動かすユーザーで `cred-set` をやり直す |
| `INVALID_ARGUMENT`(`cred-set needs an interactive terminal`) | `cred-set` を、入力のできない環境(AI のツール・パイプ・スケジュール実行など)から呼んだ | 人が PowerShell の窓で、AI を動かすユーザーとして打つ |
| `CONNECT_FAILED`(名前を解決できない) | `host` の名前が引けない | ①の名前の確認。DNS か hosts に登録する |
| `CONNECT_FAILED`(TrustedHosts の文言) | 手元の TrustedHosts に名前がない | ① |
| `CONNECT_FAILED`(応答がない・タイムアウト・接続できない) | VM の WinRM が動いていない、またはファイアウォール | ⑤-1〜⑤-3。`Test-NetConnection <host> -Port 5985` で確かめる |
| `CONNECT_FAILED`(アクセスが拒否されました) | ①パスワード・ユーザー名の誤り ②管理者なのに権限が削られている ③同じ PC への deploy を管理者でない PowerShell で打った ④接続用ユーザーが接続許可グループに入っていない | ①`cred-set` をやり直す(ユーザー名は `コンピューター名\ユーザー名`)②⑤-5 ③管理者の PowerShell で打つ ④`deploy` する |
| `ENDPOINT_NOT_FOUND` | その接続先に窓口がまだない(または復元で消えた) | `deploy -Target <名前>` |
| `VERSION_MISMATCH` / `ROLE_NOT_AVAILABLE` | 窓口の版やロールが古い | `deploy -Target <名前>` |
| `TARGET_NOT_READY` | `check-target` で前提が足りない | 出力の `checks` を⑦の表で引く |
| `CHECKPOINT_AMBIGUOUS` | 同じ名前のチェックポイントが0個または2個以上 | ③の `Get-VMSnapshot` で確かめ、名前が1つになるようにする(⑧) |
| `INSTALL_FAILED` / `DEPLOY_FAILED`(`message` に Hyper-V が VM を見つけられない旨) | `VMName` が Hyper-V 上の名前と違う | ③で `VMName` を直し、`-Force` 付きで④をやり直す |
| `DEPLOY_FAILED` | インストーラが途中で失敗した | `message` の内容を見る(多くは上のどれか) |
| `DEPLOY_VERIFY_FAILED` | 配置はできたが、接続用ユーザーで窓口に入れない | `cred-set pms-vm` の内容(ユーザー名・パスワード)を見直して、もう一度 `deploy` |
| 復元の出力の `deploy` に `WINRM_TIMEOUT` | 復元直後の 30 秒以内に VM の WinRM が応答しなかった | 3.1 が未了なら想定どおり。済んでいるなら⑤-2、それでも出るなら `restore.winrmTimeoutSec` を延ばす |
| `TOOL_NOT_FOUND` | ログ収集ツールが `ExePath` にない | ⑤-8 と `LogCollect.ExePath` |
| `MASK_NOT_CONFIGURED` | `LogCollect.MaskArguments` が空 | マスクの指定を書く(マスクなしでは集めない決まり) |
| `NOT_ELEVATED` | PMS VM の窓口が管理者の権限で動いていない | `deploy -Target pms-vm -Force` |
| `OUTPUT_DIR_NOT_EMPTY` | `-OutDir` に前回の結果がある | 新しいフォルダ名にする |
| `READINESS_FAILED` | 復元後に Web UI へログインできなかった | 起動確認テストの出力とスクリーンショットを見る(7章) |
| `LOCKED`(終了コード 3) | 別の復元が実行中 | 終わるのを待ってやり直す |
| 終了コード 4 | エラーではない。起動確認テストがまだない | Web UI にログインできることを人が確かめる |
| インストーラの警告 `the existing config differs …` | `config.psd1` を直したが、既存の設定が残った | `deploy -Target <名前> -Force`(直接実行なら `-Force` を付ける) |
