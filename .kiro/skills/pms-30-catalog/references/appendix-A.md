# 付録A: exploration-log.yaml

作業10の主成果物。スキーマとゴールド例。

```yaml
feature_code: PRT
flow_id: F-002
explored_at: 2026-09-03
environment: <環境ID>(ビルド番号 <番号>)   # 値(URL 等)ではなく環境ID。00 ■検証環境の情報
scenarios:
  - id: SC-PRT-01
    verdict: passed             # vocab.verdict
    requires_setup: |
      S-USER-LOGIN: fixtures/auth.ts#userLogin(既存流用)で成立を確認
    carried_data:               # 持ち回ったデータの実値(作業20での変数化のヒント)
      job_id: 'JOB-00001042'
    steps:
      - step_id: SC-PRT-01-S1
        verdict: passed
        started_at: 2026-09-03T13:50:12+09:00   # ステップの開始・終了時刻(vocab.timestamp_format)。作業15がログを集める時間範囲に使う
        ended_at: 2026-09-03T13:50:31+09:00
        actions:
          - action: goto
            detail: /print/new
          - action: click
            locator: getByRole('button', { name: '印刷実行' })
        verification: 両方
        verified_by:
          screen: getByRole('alert') に受付完了が表示される
          db: PrintJob テーブルに当該ジョブの行が1件追加される
        assertion_hint: |       # 作業20への引き継ぎ。機械的に検証する方法の提案(必ず書く)
          DB: SELECT COUNT(*) FROM PrintJob WHERE JobId = <carried_data.job_id> = 1
        nondeterministic:
          - { value: ジョブID, catalog_id: ND-UI-001, strength: パターン一致 }
        observed: 受付完了が表示され、ジョブIDが採番された
        evidence: [evidence/SC-PRT-01-S1_01.png]
        act:                    # 記録との対応(pms が書く。proc-v018 以降)。actions は pms act の記録のこの連番から作った
          card: C-0007
          seqs: [21, 23]        # actions の元の操作
          screen_seqs: [24]     # verified_by.screen の元の assert
          evidence_seqs: [25]   # evidence の元の screenshot
      - step_id: SC-PRT-01-S3
        verdict: passed
        actions:
          - action: external    # 外部操作。tests/external/ のラッパ経由(操作IDと1対1)
            operation_id: OP-DEV-001
        wait:                   # 非同期待機を行ったステップには必ず書く
          condition: ジョブ状態が「完了」になる(DB: PrintJob.Status)
          measured_seconds: 42
          timeout_used: 180
        verification: 両方
        assertion_hint: |
          waitUntil で PrintJob.Status = 'Completed' を待機。画面はジョブ一覧の状態列で確認
        evidence: [evidence/SC-PRT-01-S3_01.png]
    invariants: { INV-001: pass, INV-002: 未実施(スキーマ未確認), INV-003: pass, INV-004: pass, INV-005: pass }
    discrepancies: [DISC-PRT-001]
    manual_gap: false           # マニュアルに操作手順の記載がなかったら true

  # 健全性シグナルが出た例(作業10)。期待結果は満たしたが、自データのジョブがエラーになった
  - id: SC-PRT-05
    verdict: human-check
    steps:
      - step_id: SC-PRT-05-S2
        verdict: human-check      # 健全性シグナルが出たステップは passed にしない
        started_at: 2026-09-03T14:05:40+09:00
        ended_at: 2026-09-03T14:06:58+09:00
        actions:
          - action: external
            operation_id: OP-CLI-001
        health_signal:            # 00 ■健全性シグナルと問い合わせ
          kind: 自データの異常状態 # vocab.health_signal_kind
          detail: ジョブは受け付けられ一覧で検索できるが、PrintJob.Status = 'Error'、エラーコード AUTH-401(認証エラー)
          observed_at: 2026-09-03T14:06:55+09:00   # 健全性シグナルを観測した時刻(待機のあとに観測したときは、その時刻)
        verification: 両方
        assertion_hint: |
          DB: SELECT Status FROM PrintJob WHERE JobId = <carried_data.job_id>(現状 'Error')
        evidence: [evidence/SC-PRT-05-S2_01.png]

  # 作業15で解消し、追記した記録(同じ flow_id。作業10の記録は残す)
  - id: SC-PRT-05
    verdict: passed
    health_fix:                 # 作業15(健全性の是正)で解消した記録にだけ付ける
      inquiries: 1              # 問い合わせの回数(KB で解消したときは 0)
      cause: 複合機に認証設定が残っており、登録外のユーザー名の印刷ジョブが認証エラーになっていた
      change: 印刷指示のユーザー名を、複合機に登録済みのテスト用ユーザーに変えた
      record: health/inquiries/SC-PRT-05-1.md
      log_ids: [PMS-E-2041]     # 回答が原因の根拠として挙げ、添付したログのログIDの一覧で確認したログID(KB T12 に記録したもの。なければ省略)
    steps:
      - step_id: SC-PRT-05-S2
        verdict: passed
        # (以下、通常の記録と同じ)

  # 外部操作の skill がなく blocked にした例(再探索フローで探索し直す対象になる)
  - id: SC-PRT-03
    verdict: blocked
    requires_setup: |           # blocked のシナリオでも前提状態は整備して記録する
      S-USER-LOGIN: fixtures/auth.ts#userLogin(既存流用)で成立を確認
      S-DEVICE-REGISTERED: fixtures/device.ts#deviceRegistered(本フローで整備)で成立を確認
    steps:
      - step_id: SC-PRT-03-S1   # blocked のステップより前は探索して記録する
        verdict: passed
        actions:
          - action: goto
            detail: /print/new
        verification: 両方
        assertion_hint: |
          DB: SELECT COUNT(*) FROM PrintJob WHERE JobId = <carried_data.job_id> = 1
        evidence: [evidence/SC-PRT-03-S1_01.png]
      - step_id: SC-PRT-03-S2
        verdict: blocked
        blocked_by:               # 理由・参照・再開するステップを必ず書く
          reason: 操作手段なし
          ext_demand: EXT-003
          handoff: HO-PRT-006
          resume_from: SC-PRT-03-S2   # blocked が解けたら、シナリオを最初のステップから実行し直し、ここから先を探索する
        notes: 機器パネルでの認証印刷の解除に使える skill がない(不足の区分 skillなし)
      - step_id: SC-PRT-03-S3
        verdict: blocked
        blocked_by: { reason: 前ステップが blocked }

  # 禁止操作リストで blocked にした例(リストが変わったら、作業20の前にパートPで判定し直す対象になる)
  - id: SC-PRT-04
    verdict: blocked
    steps:
      - step_id: SC-PRT-04-S3
        verdict: blocked
        blocked_by:
          reason: 禁止操作
          prohibition: PROH-001       # 禁止ID。包括原則でエスカレーションした場合は 包括原則1 等
          handoff: HO-PRT-007
          resume_from: SC-PRT-04-S3
        notes: 1ジョブ50ページの印刷が PROH-001 の制約(10ページ以下)を超える
```

補足ルール:

- `actions[].locator` は**安定ロケータ(またはページオブジェクト/部品のメソッド参照)のみ**。snapshot の一時IDを書かない
- `assertion_hint` は**必ず書く**(`blocked` のステップを除く)。決定的に検証できる形で、**自シナリオのデータにスコープして**書く(環境全体の件数を基準にしない)。判定不能なら「決定的な検証手段が見つからない」と正直に書く
- `wait` は非同期待機を行ったステップに必ず書く
- `nondeterministic` は非決定値を扱ったステップに書く。未登録の値は `catalog_id: 未登録` とする
- `carried_data` はシナリオ単位で1箇所にまとめる(各ステップには書かない)
- **`blocked` のシナリオでも `requires_setup` を書き、blocked のステップより前のステップを判定付きで記録する**(lint `requires_covered` / `blocked_recorded`)
- `blocked` の最初のステップの `blocked_by` には、理由・参照・`resume_from` を書く。`操作手段なし` は需要IDと申し送りID(lint `ext_demand_linked`)、`禁止操作` は禁止ID(または包括原則の番号)と申し送りIDを書く。後続のステップは `{ reason: 前ステップが blocked }` でよい
- 再探索フローの記録は、当該シナリオの記録に新しい `flow_id` と `reexplore_of: <旧フローID>` を付けて追記する。パートPの記録は `recheck_of: <前回の prohibited_ops.digest>` を付けて追記する。いずれも旧記録は削除しない
- 健全性シグナルが出たステップには `health_signal`(種類 `kind` は `vocab.health_signal_kind`、要点 `detail`、観測した時刻 `observed_at`)を書き、判定を `passed` にしない(lint `health_recorded`)
- 探索したステップには `started_at`・`ended_at`(`vocab.timestamp_format`。AI実行マシンの時計)を書く。ステップの最初の操作の直前と、判定に使った観測の直後の時刻とする(待機を含む)。`blocked` で実行しなかったステップには書かない。作業15がサーバーのログを集める時間範囲に使う(00 ■健全性シグナルと問い合わせ ログの添付)。健全性シグナルのあるステップの `started_at` と `observed_at` は lint `health_recorded` が検査する(proc-v014 以降のフロー)
- **proc-v018 以降のフローでは、探索記録は進行役 pms が書く**(§10 パートC)。`explore.step` のカードの提出が合格したときに、`actions`・`started_at`・`ended_at`(そのカードの `pms act` の記録の最初と最後の時刻)・`verified_by.screen`(assert の記録)・`evidence`(`pms act screenshot` が `evidence/<ステップID>_<連番>.png` に保存したもの)・`act`(カードと連番)を記録から作り、判定・`verified_by.db`・`assertion_hint`・`observed`・`nondeterministic`・`wait`・`health_signal`・`blocked_by`・`carried_data` をカードの出力から写す。検証手段を変えた理由は `verification_note` に、`DB` 単独の理由は `verification` に `DB(理由: …)` の形で書く。シナリオの判定・`requires_setup`・`invariants`・`discrepancies`・`manual_gap` も pms が書く。`act` の連番と `actions` が記録と一致することを lint `explore_act_linked` が検査する(作業15の `health_fix` の記録を除く)
- 作業15で解消した記録は、同じ `flow_id` と `health_fix`(問い合わせの回数・原因・変えた操作・問い合わせの記録のパス・確認済みのログID)を付けて追記する。作業10の記録は削除しない。`health_fix` の付いた記録のどのステップにも `health_signal` があってはならない
