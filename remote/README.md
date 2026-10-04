# リモートコマンド(PmsRemote)— 導入手順

回帰テストのために、別のマシン(Hyper-V ホスト・PMS サーバーVM・将来の印刷クライアントPC)でコマンドを実行する一式の導入手順です。
**整備方針の正本は `docs/003_リモートコマンド整備方針.html`(第1部)です。** 新しいリモートコマンドを足すときは、その 9章の手順に従ってください。

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

## 同梱物

| パス | 置き場所 | 内容 |
|---|---|---|
| `remote/module/PmsRemote/` | 各マシン(インストーラが `%ProgramFiles%\WindowsPowerShell\Modules\` に配置) | リモートコマンドセット(全マシン共通の1パッケージ)とロール6つ |
| `remote/Install-PmsRemote.ps1` | 各マシン(直接実行、または CLI の deploy が送り込む) | 共通インストーラ(冪等) |
| `remote/targets/<接続先名>/config.psd1` | リポジトリ(deploy が `%ProgramData%\PmsRemote\config.psd1` として配置) | リモート側の設定の原本。対象・ツール・マスクの指定などを固定する |
| `tools/remote/pms-remote.ps1`(と `lib/`) | リポジトリ | CLI 本体 |
| `config/remote-targets.json` | リポジトリ | クライアント設定(接続先・資格情報の参照名・期待する版・復元・ログの書式) |
| `.kiro/skills/restore-golden-image/`・`.github/skills/` | リポジトリ | 外部操作 skill(復元。CLI の restore を呼ぶ入口・lint を同梱) |
| `.kiro/skills/collect-server-logs/`・`.github/skills/` | リポジトリ | 外部操作 skill(ログ収集。CLI の logs-collect を呼ぶ入口を同梱) |
| `remote/tests/external/remote.ts` | リポジトリの `tests/external/` にコピー | テストコードから CLI を呼ぶヘルパー |
| `remote/tests/global-setup.ts` | リポジトリの `tests/` にコピー | Playwright globalSetup(回帰の一括実行前の復元) |
| `playwright.readiness.config.ts` | リポジトリのルート | 起動確認テストだけを実行する設定 |
| `remote/examples/server-ready.setup.ts` | **置かない**(参考) | 起動確認テストの雛形。作業10がログイン fixture を整備したときに `tests/readiness/` に作る |
| `remote/docs/procedure-proc-v003.patch` | 参考 | 復元を導入したときの手順書の差分(履歴) |

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

---

## 1. AI 実行環境の準備(1回)

1. **TrustedHosts**(HTTP で別のマシンに接続するため。管理者の PowerShell で)

   ```powershell
   Set-Item WSMan:\localhost\Client\TrustedHosts -Value 'pms-test-01' -Concatenate -Force
   ```

   Hyper-V ホストが同じ PC(`localhost`)の間は不要です。
2. **資格情報**(参照名で保存。`config/remote-targets.json` の `credential` / `deployCredential` に書いた名前ごとに1回)

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 cred-set pms-vm         # 通常用(JEA に接続するユーザー)
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 cred-set pms-vm-admin   # 配置用(そのマシンの管理者)
   ```

   保存先は `%APPDATA%\PmsRemote\cred\<参照名>.xml` で、DPAPI により保存したユーザー・PC でしか復号できません。参照名が `null` の接続先は、ログオン中のユーザーで接続します。
3. `config/remote-targets.json` の接続先(`host`)を実際の名前に合わせます(0章の一覧)

## 2. Hyper-V ホスト(hyperv-host)

### 2.1 新規に導入する

`remote/targets/hyperv-host/config.psd1` の `Restore`(VM 名・チェックポイント名)を確かめてから、次のどちらかで配置します。

- **ホストで直接実行**(管理者の PowerShell。リポジトリのルートで)

  ```powershell
  .\remote\Install-PmsRemote.ps1 -Role HyperVRead,HyperVChange -ConfigFile .\remote\targets\hyperv-host\config.psd1 -OperatorUser yu
  ```

- **AI 実行環境から deploy**(AI 実行環境とホストが同じ PC なら、管理者の PowerShell で)

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 deploy -Target hyperv-host
  ```

- `-OperatorUser`: JEA に接続するユーザー(AI 実行環境・CI を動かすアカウント)。ローカル管理者である必要はありません。deploy では、通常用の資格情報のユーザー(参照名が `null` ならログオン中のユーザー)が自動で入ります
- 作られるもの: ローカルグループ `PmsRemoteRead` / `PmsRemoteChange`、JEA エンドポイント `PmsRemote`(実行は仮想アカウント。Hyper-V のロールだけなら権限は Hyper-V Administrators のみ)、設定 `%ProgramData%\PmsRemote\config.psd1`、操作記録 `...\Transcripts\`・`...\state\operations.log`
- 前提: 対象 VM に、復元先の運用チェックポイントが**名前の重複なく1つだけ**あること(インストーラが確かめます)
- 確認: `pms-remote.ps1 restore -InfoOnly`(復元はしません)

### 2.2 旧版(PmsGoldenRestore)から移行する

旧版の一式(`golden-restore/`、エンドポイント `PmsGoldenRestore`)を導入済みのホストでは、2.1 の導入のあとに旧版を取り除きます(管理者の PowerShell で)。

```powershell
Unregister-PSSessionConfiguration -Name PmsGoldenRestore -Force
Remove-Item "$env:ProgramFiles\WindowsPowerShell\Modules\PmsGoldenRestore" -Recurse -Force
Remove-LocalGroup -Name PmsRestoreOperators
# 旧設定の VM 名・チェックポイント名を remote/targets/hyperv-host/config.psd1 に移してから
Remove-Item "$env:ProgramData\PmsGoldenRestore" -Recurse -Force
```

AI 実行環境側の旧資格情報 `%APPDATA%\PmsGoldenRestore\credential.xml` を使っていた場合は、`cred-set` で参照名を付けて保存し直し、`config/remote-targets.json` の `hyperv-host.credential` に書きます。復元記録(`work/_common/env-restore-log.jsonl`)はそのまま使えます。

## 3. PMS サーバーVM(pms-vm)

`config/remote-targets.json` の `pms-vm` には、最初から `"restoredBy": "hyperv-host"` が書いてあります。復元のたびに、CLI が PMS VM の WinRM の応答を待ち(`restore.winrmTimeoutSec` = 30 秒まで)、窓口を自動で配置します。

**下の 3.1 の準備が整うまでは、復元のたびに約30秒待ったあと、配置の警告が出ます。** 復元自体は成功し、作業10・20と回帰の一括実行はそのまま進みます(出力の `deploy` に `"status":"failed"` と `WINRM_TIMEOUT` などが残り、ログ収集は使えません)。警告をなくすには 3.1 の準備をしてください。

### 3.1 PMS VM で準備が必要な内容(ゴールデンイメージに一度だけ入れる)

窓口(エンドポイント・モジュール)はゴールデンイメージに焼き込みません。入れるのは次の前提だけです(docs/003 C-5)。PMS VM の中で、管理者の PowerShell で行います。

| # | 準備 | 内容・コマンドの例 |
|---|---|---|
| 1 | WinRM を有効にする | `Enable-PSRemoting -Force`(Windows Server では既定で有効) |
| 2 | **WinRM を遅延なしの自動開始にする** | `sc.exe config WinRM start= auto`。「自動(遅延開始)」のままだと、復元直後の30秒以内に応答せず、準備が整っていても配置が毎回警告になることがあります |
| 3 | ファイアウォールで 5985 を開ける | AI 実行環境から TCP 5985 に接続できること。ネットワークのプロファイルが「パブリック」だと、既定の規則は同じサブネットからしか受け付けません。例: `Set-NetFirewallRule -Name WINRM-HTTP-In-TCP-PUBLIC -RemoteAddress Any`(必要な範囲に絞ってください) |
| 4 | 配置用の管理者アカウント | ローカルの管理者。**パスワードを無期限にする**(`Set-LocalUser -Name <名前> -PasswordNeverExpires $true`)。期限付きだと、復元で時計が戻ることもあり、数か月後に接続できなくなります。AI 実行環境で `cred-set pms-vm-admin` で保存します |
| 5 | ローカルアカウントでの遠隔管理を許す | 4 にビルトインの Administrator 以外を使うなら、`Set-ItemProperty -Path HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System -Name LocalAccountTokenFilterPolicy -Value 1 -Type DWord` |
| 6 | JEA に接続するユーザー | 通常用のローカルユーザー(管理者でなくてよい)。パスワード無期限。AI 実行環境で `cred-set pms-vm` で保存します(接続許可グループへの追加は deploy が行います) |
| 7 | 名前で接続できること | AI 実行環境から `config/remote-targets.json` の `pms-vm.host`(既定 `pms-test-01`)で名前解決できること。AI 実行環境の TrustedHosts にも同じ名前を登録します(1章) |
| 8 | ログ収集ツールがあること | `remote/targets/pms-vm/config.psd1` の `LogCollect.ExePath` の場所に、製品のログ収集ツールがあること(ゴールデンイメージに含まれていれば追加の作業はありません) |

準備したら、AI 実行環境から確かめます(何も変更しません)。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 check-target -Target pms-vm
```

`"success":true` になったら、**このときだけ** VM のチェックポイントを取り直します。順序は「復元 → 準備を入れる → `check-target` → チェックポイント」です(作業中のデータを混ぜないため)。チェックポイント名は `remote/targets/hyperv-host/config.psd1` の `CheckpointName` と同じにし、同名のチェックポイントがちょうど1つになるようにします。

### 3.2 配置と確認

1. `remote/targets/pms-vm/config.psd1` の `LogCollect`(ツールのパス・引数・マスクの指定・成功とみなす終了コード・時刻の書式)を製品のログ収集ツールに合わせます(0章の一覧)
2. 配置: `pms-remote.ps1 deploy -Target pms-vm`(以後は復元のたびに自動で行われます)
3. 確認: `pms-remote.ps1 info -Target pms-vm`(版・ロール・モジュールと設定がリポジトリと同じか)、`pms-remote.ps1 logs-collect -InfoOnly`(ツールの有無・マスクの指定)
4. 試験: 短い時間範囲で `pms-remote.ps1 logs-collect -From ... -To ... -OutDir work\_tmp\logs-test`。展開したファイルと出力の `log_ids` が一致するか(`config/remote-targets.json` の `logCollect.logIdPattern` が合っているか)を一度確かめてください
5. 復元を1回行い(`pms-remote.ps1 restore -Purpose manual`)、出力の `deploy` が `"status":"deployed"` になることを確かめます。準備のあとも `WINRM_TIMEOUT` が出る場合は、3.1 の 2(遅延開始)を確かめ、それでも足りなければ `restore.winrmTimeoutSec` を延ばしてください

版が安定したら、配置済みの状態でチェックポイントを取り直してもかまいません(任意)。復元後の配置が「版が同じなので何もしない」になり、復元が数十秒速くなります。

## 4. Playwright の設定

`remote/tests/external/remote.ts` を `tests/external/`、`remote/tests/global-setup.ts` を `tests/` にコピーし、`playwright.config.ts` に globalSetup と起動確認の setup project を追加します。

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

- **globalSetup は既定で復元しません。** 作業20の「復元せずに3回連続実行」や個別のデバッグ実行で勝手に復元されると、再実行耐性の確認が無意味になるためです(`PMS_RESTORE=1` で起動したときだけ)
- テストコードからリモートコマンドを使うときは、`tests/external/remote.ts` の `runRemote()` で CLI を呼びます。JEA を直接呼びません
- 起動確認テストの作り方と判定の条件は、手順書 00 ■回帰実行の環境前提(起動完了の判定)と `remote/examples/server-ready.setup.ts` を参照してください。ログイン fixture がまだない間は、復元が終了コード 4 を返し、人間がログインを確かめます

## 5. CLI と出力

```
pms-remote.ps1 <サブコマンド> [-Target <接続先名>] [引数]
```

| サブコマンド | 内容 | 主な利用者 |
|---|---|---|
| `info -Target <名前>` | 版・ロール・モジュールと設定がリポジトリと同じか | 人間 |
| `check-target -Target <名前>` | 接続先の一度きりの前提を確かめる(配置用の資格情報を使う) | 人間 |
| `deploy -Target <名前> [-Force]` | 共通インストーラを送り込んで実行する(配置用の資格情報を使う)。`-Force` は既存の設定を上書きする | 人間・restore |
| `cred-set <参照名>` | 資格情報を保存する(対話) | 人間 |
| `restore [-Purpose] [-FlowId] [-SkipReadiness] [-InfoOnly]` | 復元 → 復元した接続先への配置 → 起動確認 → 復元記録 | skill restore-golden-image・globalSetup |
| `logs-collect -From -To -OutDir [-InfoOnly]` / `logs-ids -OutDir` | ログ収集(ログIDと件数の一覧を返す) | skill collect-server-logs |

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
