# 付録G: 状態カタログと catalog-log.yaml

## state-catalog.md の列構成

| 列 | 内容 | 必須 |
|---|---|---|
| 状態ID | `vocab.id_format.state` | ○ |
| 状態名 | 日本語の短い名前 | ○ |
| 分類 | `vocab.state_category` | ○ |
| 内容 | 何が成立していれば良いかを業務語で1〜2文 | ○ |
| 成立確認方法 | 画面上の確認方法。安定ロケータで記録 | ○(画面確認済のもの) |
| 構築の骨子 | 実操作で作る場合の概略(画面名+操作の要旨) | △ |
| 解除方法 | 初期化・削除の手段。なければ `不可(環境リセットのみ)` | △ |
| 排他 | 同時に成立しない状態ID | △ |
| 前提 | この状態を作るために必要な他の状態ID | △ |
| 整備状況 | `vocab.provisioning` | ○ |
| 検証担当項目 | 項目ID / `<機能コード>-未採番` / `不要(データ状態のみ)` | ○ |
| 確度 | `vocab.catalog_confidence` | ○ |
| 出所 | `探索記録: <シナリオID>` / `ソース: <ファイル:シンボル>` / 文書名+章番号 / `画面観察: <画面名>` | ○ |

**整備状況について**: フィクスチャは**整備済みか否か**で扱いが決まり、実現手段では区別しない。ここでは**「実操作で作れるかどうか」だけを判定する**。API/DB投入でも作れるが未整備なだけのものは単に `未整備` とする。`未整備(実操作不可)` は過去日付の実績、0件状態、大量データ等に限る。**この判定に時間をかけないこと。**

出力例:

```markdown
| 状態ID | 状態名 | 分類 | 内容 | 成立確認方法 | 構築の骨子 | 解除方法 | 排他 | 前提 | 整備状況 | 検証担当項目 | 確度 | 出所 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S-ADMIN-LOGIN | 管理者ログイン済 | AUTH | 全権限を持つ管理者でログイン済 | ヘッダーに getByRole("link", {name:"管理"}) が表示される | ログイン画面でID/PW入力 | ログアウト | S-USER-LOGIN | - | 整備済 | SC-LGN-01 | 確認済 | 探索記録: SC-LGN-01 / setup-log |
| S-JOB-COMPLETED | ジョブ完了済 | ENTITY | 印刷ジョブが完了状態で存在 | ジョブ一覧にステータス「完了」の行が存在 | 印刷実行→外部操作OP-DEV-001。完了まで約42秒 | ジョブ削除(管理者) | S-JOB-QUEUED | S-DEVICE-REGISTERED | 未整備 | SC-PRT-01 | 確認済 | 探索記録: SC-PRT-01-S3 |
| S-PRINT-LOG-EMPTY | 印刷実績なし | DATA | 対象期間の実績が0件 | 実績一覧に「該当データなし」が表示される | 実操作では作成不可 | - | S-PRINT-LOG-EXISTS | S-ADMIN-LOGIN | 未整備(実操作不可) | 不要(データ状態のみ) | 文書のみ | 仕様書4.2 / 申し送り台帳 HO-RPT-003 |
```

## catalog-log.yaml

```yaml
generated: 2026-09-XX
processed_flows: [F-001, F-002, F-003]   # 次回の増分更新はこの続きから
sources:
  exploration_logs: [work/PRT/exploration/exploration-log.yaml, ...]
  handoff_register: work/_common/handoff-register.md
  spec: PMS仕様書 v12.3
  source_code: コミット abc1234
states:
  - id: S-JOB-COMPLETED
    name: ジョブ完了済
    category: ENTITY
    status: proposed                      # vocab.progress_state
    confidence: 確認済                    # vocab.catalog_confidence
    provisioning: 未整備                  # vocab.provisioning
    evidence_of_state:
      description: ジョブ一覧にステータス「完了」の行が存在する
      locator: 'getByRole("row").filter({ hasText: "完了" })'
    build_outline: 印刷実行後、外部操作(OP-DEV-001)で実行。完了まで約42秒
    teardown: ジョブ一覧から削除(管理者)
    exclusive_with: [S-JOB-QUEUED]
    depends_on: [S-DEVICE-REGISTERED]
    owner_test: SC-PRT-01
    origin:
      - '探索記録: SC-PRT-01-S3'
      - 'ソース: job/status.ts JobStatus.COMPLETED'
    demand: [HO-BIL-002]                  # 需要の根拠(申し送り台帳との対応)
    evidence: [evidence/S-JOB-COMPLETED_01.png]
    disc: []
rejected:
  - id: S-JOB-CANCELLED
    reason: enum に存在するが画面表示は「完了」と同一(job/list.tsx に分岐なし)。分岐が見つかるまで不採用
  - id: S-PRINT-LOG-3ITEMS
    reason: データ量はパラメータで表現できるため不採用(粒度の原則2)
```
