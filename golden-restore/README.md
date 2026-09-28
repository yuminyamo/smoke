# ゴールデンイメージ自動復元 — 導入手順

PMS 検証環境(Hyper-V 上の PMS サーバーVM 1台)を、AI やテストランナーがゴールデンイメージへ戻せるようにする一式です。
**「復元するかどうか」の判断は AI にさせず、決まった契機で実行体が呼ばれるだけ**の構成です。

- **サーバーの起動完了は「Web UI にログインできること」で判定します。** ログイン画面の表示や IIS の応答では判定しません(IIS の外で動く Java アプリケーションサーバーが立ち上がりきるまで、PMS はテストできないため)
- **ログイン確認の処理は skill に持たせません。** テストコード側の起動確認テスト(`tests/readiness/server-ready.setup.ts`)が、ログイン fixture と同じシナリオ部品を使って判定します。ログイン画面が変わっても直すのは1か所です
- 規約の正本は手順書です(`procedure/00_common.md` ■回帰実行の環境前提とテストデータ規約、`stages.md` §10・§20 工程0、付録F)。本書は導入の手順です

```
[AI実行環境 / CI]                                             [Hyper-V ホスト]
 Playwright globalSetup (PMS_RESTORE=1) ──┐
   └ 続いて setup project `readiness` ──┐  │
 skill restore-golden-image (作業10/20) ─┼─┴─ restore-golden-image.ps1 ──WinRM──▶ JEA: PmsGoldenRestore
                                         │        │                                └ 停止→チェックポイント適用→起動
                                         │        └ readiness.command を呼ぶ(作業10/20のとき)
                                         ▼
                     tests/readiness/server-ready.setup.ts
                     = ログイン fixture と同じ部品で Web UI にログインできるまで待つ
                       (ファイルがない間は 終了コード4 → 人間がログインを確かめる)
 lint Test-EnvRestoreMarker.ps1 ── status.yaml の env_restore を復元記録と突合
```

| いつ | 復元 | 起動完了の確認 | AI の関与 |
|---|---|---|---|
| 回帰テストセットの一括実行前 | globalSetup(`PMS_RESTORE=1` のとき) | setup project `readiness`(全 project の依存) | なし |
| 作業10・作業20の開始時 | skill `restore-golden-image` | 実行体が起動確認コマンドを呼ぶ | 実行体を1回呼ぶだけ |
| 同上・ログイン fixture 未整備の間 | 同上 | **人間**がログインを確かめる(終了コード4で止まる) | 止まって伝えるだけ |
| 作業後・再開時 | しない | — | — |

## 同梱物

| パス | 置き場所 | 内容 |
|---|---|---|
| `host/PmsGoldenRestore/` | Hyper-V ホスト(インストーラが配置) | 復元モジュールと JEA ロール |
| `host/Install-PmsRestoreEndpoint.ps1` | Hyper-V ホストで1回実行 | JEA エンドポイント導入 |
| `host/config.sample.psd1` | 参考 | ホスト設定の見本(インストーラが生成する) |
| `skills/restore-golden-image/` | リポジトリの `.kiro/skills/` と `.github/skills/` | 外部操作 skill(復元の実行体・lint を同梱。ログイン確認は含まない) |
| `config/golden-restore.json` | リポジトリの `config/` | クライアント設定(接続先・起動確認コマンド) |
| `tests/global-setup.ts` | リポジトリの `tests/` | Playwright globalSetup(回帰の一括実行前の復元) |
| `playwright.readiness.config.ts` | リポジトリのルート | 起動確認テストだけを実行する設定 |
| `examples/server-ready.setup.ts` | **置かない**(参考) | 起動確認テストの雛形。作業10がログイン fixture を整備したときに `tests/readiness/` に作る |
| `docs/procedure-proc-v003.patch` | 参考 | 手順書の正本(`procedure/`・利用説明書)への変更差分(proc-v002 → proc-v003)。プロジェクトの正本には反映済み。リポジトリへ取り込むときに使う |

---

## 1. Hyper-V ホスト側(管理者 PowerShell で1回)

前提: 対象VMに、復元先の運用チェックポイントが**名前の重複なく1つだけ**あること(以下の例では `golden`)。

```powershell
cd .\host
.\Install-PmsRestoreEndpoint.ps1 -VMName 'PMS-TEST-01' -CheckpointName 'golden' -OperatorUser 'yu'
```

- `-OperatorUser`: 復元を呼ぶローカルユーザー(AI 実行環境・CI を動かすアカウント)。ローカル管理者である必要はありません
- 作られるもの
  - ローカルグループ `PmsRestoreOperators`(このグループだけが接続可能)
  - JEA エンドポイント `PmsGoldenRestore`(実行は仮想アカウント、権限は Hyper-V Administrators のみ)
  - 設定 `%ProgramData%\PmsGoldenRestore\config.psd1`(VM名・チェックポイント名・待機上限)
  - 操作記録 `%ProgramData%\PmsGoldenRestore\Transcripts\`、復元ログ `...\state\restore.log`
- ゴールデンイメージを作り直してチェックポイント名が変わったら、`config.psd1` を編集するだけで済みます

## 2. AI 実行環境側

1. `skills/restore-golden-image/` を `.kiro/skills/` と `.github/skills/` に配置
2. `config/golden-restore.json` を `config/` に、`playwright.readiness.config.ts` をリポジトリのルートに配置
3. `playwright.config.ts` に globalSetup と起動確認の setup project を追加(下の「3. Playwright の設定」)
4. 接続確認(復元はしない)

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .kiro\skills\restore-golden-image\scripts\restore-golden-image.ps1 -InfoOnly
   ```

   `"success":true` と VM の状態・チェックポイント作成日時が返れば OK。`readiness_test_present` は起動確認テストがあるかどうかです(初期は `false`)。
5. 復元の試験: `... restore-golden-image.ps1 -Purpose manual`
   - 起動確認テストがまだなければ終了コード 4 で返ります。手でログインできることを確かめてください
6. `.gitignore` に `work/_common/env-restore-log.jsonl` を入れるかは運用で決めてください(個人環境の記録なのでコミットしない方が自然です)

### 資格情報(Hyper-V ホストへの接続)

- **同一PCでの運用中**: 実行ユーザーが `PmsRestoreOperators` のメンバーなら保存は不要(ログオン中の資格情報で localhost に接続)
- **CI をサービスアカウントで動かす場合、またはホスト分離後**: そのアカウントで1回だけ `... restore-golden-image.ps1 -SaveCredential`。`%APPDATA%\PmsGoldenRestore\credential.xml` に DPAPI で暗号化保存され、保存したユーザー・PC でしか復号できません

PMS へのログインの資格情報は、ログイン fixture が使っているものがそのまま使われます(起動確認テストは同じ部品を呼ぶため)。この一式では別に持ちません。

## 3. Playwright の設定

```ts
// playwright.config.ts(抜粋)
export default defineConfig({
  globalSetup: './tests/global-setup.ts',        // PMS_RESTORE=1 のときだけ復元する
  projects: [
    // 起動確認: Web UI にログインできるまで待つ(ファイルは作業10がログイン fixture 整備時に作る)
    { name: 'readiness', testDir: './tests/readiness', testMatch: /server-ready\.setup\.ts/ },
    // 既存の project はすべて readiness に依存させ、tests/readiness を対象から外す
    { name: 'default', testDir: './tests/specs', dependencies: ['readiness'] },
    // { name: 'serial-DEV', testDir: './tests/specs', grep: /@serial-DEV/, workers: 1, dependencies: ['readiness'] },
  ],
});
```

```jsonc
// package.json(cross-env を使う例。PowerShell なら $env:PMS_RESTORE='1'; npx playwright test)
"scripts": { "test:regression": "cross-env PMS_RESTORE=1 playwright test" }
```

- **globalSetup は既定で復元しません。** 作業20の「復元せずに3回連続実行」や個別のデバッグ実行で勝手に復元されると、再実行耐性の確認が無意味になるためです
- 起動確認の project は毎回の実行で先に走ります(起動済みなら数秒で終わります)
- `playwright.readiness.config.ts` は globalSetup / globalTeardown を持ちません。起動確認を単独で走らせても、復元が入れ子になったり、DB 全体の不変条件検査が走ったりしません

## 4. 起動確認テスト(ログイン fixture を再利用)

- **作るのは作業10です。** ログイン状態の fixture を初めて整備したフローの作業10(フェーズA)が、同じシナリオ部品を使って `tests/readiness/server-ready.setup.ts` を作ります(雛形: `examples/server-ready.setup.ts`)。それ以後の復元では起動確認が自動で行われます
- 判定の条件(手順書 00 ■回帰実行の環境前提 に定義)
  - ログイン fixture と同じシナリオ部品でログインし、fixture の established check と同じ条件で成功とみなす。ログイン操作を別に書かない
  - 保存済みセッション(storageState)を使わず、試行ごとに Cookie のない新しいコンテキストでログインし直す
  - 成功するまで一定間隔で繰り返し、上限時間(既定 900 秒。`config/golden-restore.json` の `readiness.timeoutSec`)を超えたら失敗。最後の試行のスクリーンショットを残す
- **ログイン fixture がまだない間**(初回フローの作業10の開始時など)は、実行体が終了コード 4 を返し、AI は作業を始めずに止まります。**管理者が PMS の画面にログインできることを確かめ**、`/pms-regression F-xxx の続き(ログイン確認済み、確認した人)` と伝えると再開します

### 注意

- **ログイン画面が変わると、起動確認が「サーバー未起動」のようにタイムアウトします。** 製品側の変化が環境の失敗に見えるため、失敗時は起動確認テストの出力とスクリーンショットで「ログインの部品が壊れた」のか「サーバーが起動しない」のかを見分けてください
- **アカウントのロックアウト**: 起動待ちの間、ログインが繰り返されます。ログイン失敗回数でロックされる仕様なら、ロックされない専用アカウントをログイン fixture に使うか、雛形の試行間隔を延ばしてください
- ログインによりログイン履歴などのレコードが増える可能性があります。テストは再実行耐性(自データスコープ)が前提なので影響しない想定ですが、「復元直後の件数」を観測するときは念頭に置いてください

## 5. ホストを分離するとき(将来)

ドメイン非参加(ワークグループ)同士なので Kerberos が使えません。平文 HTTP + NTLM で TrustedHosts を広げるより、HTTPS を推奨します。

1. ホストでインストーラを `-EnableHttpsListener` 付きで再実行 → `%ProgramData%\PmsGoldenRestore\winrm-<ホスト名>.cer` が出力される
2. AI 実行環境で、その証明書を「ローカルコンピューター\信頼されたルート証明機関」にインポート
3. ホストに AI 実行環境用のローカルユーザーを作り `PmsRestoreOperators` に追加
4. `config/golden-restore.json` を `"hyperVHost": "<ホスト名>", "useSsl": true` に変更し、`-SaveCredential` で資格情報を保存
5. `-InfoOnly` で接続確認

ホスト名は証明書の DNS 名と一致させてください(名前解決できない場合は AI 実行環境の hosts に登録)。

## 6. 出力と終了コード

実行体は標準出力の最後に1行の JSON を出します(進捗は標準エラー。非ASCII文字は `\uXXXX` にエスケープ)。

```json
{"success":true,"restore_id":"RST-20260926-114600-a1b2","purpose":"work10","flow_id":"F-003","readiness":"verified","error_code":null,"message":"restored and Web UI login succeeded","vm":"PMS-TEST-01","checkpoint":"golden","restore_sec":95.3,"readiness_sec":141.2,"duration_sec":238.0,...}
```

| 終了コード | 意味 | `readiness` | 主な error_code |
|---|---|---|---|
| 0 | 復元し、Web UI へのログインまで確認した(`-SkipReadiness` 時は復元のみ) | `verified` / `skipped` | — |
| 1 | 復元または起動確認の失敗 | — | `CONNECT_FAILED` `CHECKPOINT_AMBIGUOUS` `STOP_TIMEOUT` `HEARTBEAT_TIMEOUT` `HYPERV_ERROR` `READINESS_FAILED` |
| 2 | 設定・資格情報・実行環境の誤り | — | `CONFIG_NOT_FOUND` `CONFIG_INVALID` `CREDENTIAL_INVALID` `READINESS_COMMAND_UNAVAILABLE` |
| 3 | 別の復元が実行中 | — | `LOCKED` |
| 4 | 復元は成功。起動確認テストがまだないため、人間がログインを確かめる | `unavailable` | — |

## 7. 呼び忘れの検出(lint `env_restored`)

```powershell
.kiro\skills\restore-golden-image\scripts\Test-EnvRestoreMarker.ps1 -StatusFile work\PRT\exploration\status.yaml -Purpose work10 -WorkRoot work
```

| コード | 検出内容 |
|---|---|
| ENV001 | status.yaml に `env_restore.restore_id` がない(skill を呼んでいない) |
| ENV002 | その restore_id が復元記録にない、または失敗している(値の捏造・失敗の見落とし) |
| ENV003 | 復元の目的が作業と合わない(作業20で作業10の復元を流用 等) |
| ENV004 | 同じ restore_id を別の作業が使っている(復元の使い回し) |
| ENV005 | 起動確認の記録が矛盾する(起動確認テストがなかったのに `readiness: human` になっていない = 人間の確認なしで作業を始めた疑い 等) |

## 8. 設計上の注意

- 復元はホスト側で「電源断 → チェックポイント適用 → 起動 → ハートビート待ち」、続いてクライアント側で起動確認(ログイン)を待ちます。Java アプリケーションサーバーの起動が遅い環境では `readiness.timeoutSec` を延ばしてください
- ゲストの統合サービス(ハートビート)を無効にしている場合は、ホストの `config.psd1` で `RequireHeartbeat = $false`
- 同時に2つの復元が走らないよう、ホスト側でロックしています(複数人運用を始めるときの排他の土台にもなります)
