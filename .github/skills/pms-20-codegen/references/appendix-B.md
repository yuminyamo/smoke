# 付録B: setup-log.yaml

```yaml
feature_code: PRT
flow_id: F-002
setups:
  - state_id: S-USER-LOGIN
    classification: built-by-ui   # vocab.setup_classification
    flow: flows/auth.ts#loginAsUser
    fixture: fixtures/auth.ts#userLogin
    steps:
      - action: goto
        detail: <env:pms.url>             # 環境情報は値ではなく <env:キー> で書く(00 ■検証環境の情報)
      - action: fill
        locator: getByLabel('ユーザーID')
        value: <env:pms.user>
      - action: fill
        locator: getByLabel('パスワード')
        value: <env:pms.password>         # 秘密情報の値を書かない(lint env_value_leak)
      - action: click
        locator: getByRole('button', { name: 'ログイン' })
    established_check: |
      getByRole('navigation') 内に getByRole('link', { name: 'ログアウト' }) が表示される
    verified: true
    cleanup: |
      なし(ゴールデンイメージ復元で初期化)
    act:                                  # 記録との対応(pms が書く)。steps は pms act の記録のこの連番から作った
      card: C-0001
      seqs: [1, 3, 5, 6]
      established_check_seq: 8
    notes: ''
  - state_id: S-ADMIN-LOGIN
    classification: provided              # 過去のフローの fixture を流用(setup.reuse で成立を確かめた)
    flow: flows/auth.ts#loginAsAdmin      # flow・fixture・steps・established_check・cleanup は流用元のエントリをそのまま写す
    fixture: fixtures/auth.ts#adminLogin
    steps:
      - action: goto
        detail: <env:pms.url>
      - action: fill
        locator: getByLabel('ユーザーID')
        value: <env:pms.admin.user>
      - action: fill
        locator: getByLabel('パスワード')
        value: <env:pms.admin.password>
      - action: click
        locator: getByRole('button', { name: 'ログイン' })
    established_check: getByRole('link', { name: '管理メニュー' }) が表示される
    verified: true                        # 今回の実行の結果
    cleanup: なし(ゴールデンイメージ復元で初期化)
    reused_from:                          # 流用元
      flow_id: F-001
      feature_code: AUTH
    notes: ''
  - state_id: S-DEVICE-REGISTERED
    classification: blocked
    blocked_by:                           # 整備できなかった理由(付録A の blocked_by と同じ語。pms が書く)
      reason: 操作手段なし                 # vocab.reason_code
      handoff: HO-PRT-004
      ext_demand: EXT-003
    notes: テスト用デバイスの登録には機器パネルでのペアリングが要り、使える skill がない
```

補足ルール:

- **`classification: built-by-ui` のエントリには `steps` を必ず書く**(成功した最短の操作列)。fixture(`fixture`)・シナリオ部品(`flow`)のコードに書いたことを、`steps` の代わりにしない。作業20は setup-log の記録を根拠に fixture を確かめ、作業30は操作列を setup-log から転記するためである
- 各 step には操作の対象を書く。`goto` は `detail`(遷移先。環境情報は `<env:キー>`)、`external` は `operation_id`(KB T05 の操作ID)、それ以外の操作(`click`・`fill` など)は `locator` である(lint `setup_steps_recorded`)
- `locator` は付録Aの `actions[].locator` と同じく、**安定ロケータ(またはページオブジェクト/部品のメソッド参照)のみ**。snapshot の一時IDを書かない(lint `no_temp_locator`)
- **proc-v017 以降のフローでは、setup-log のエントリはすべて進行役 pms が書く**(§10 フェーズA)。`built-by-ui` は `setup.build` のカードの提出が合格したときに `pms act` の記録から `steps`・`established_check`・`act` を書き、`setup.code` の合格で `flow`・`fixture`・`verified`・`cleanup` を埋める。CSS の暫定ロケータの step には `fragile`(理由)が付く
- `classification: provided` のエントリも `steps` を持つ。`steps`・`flow`・`fixture`・`established_check`・`cleanup` は流用元のエントリからそのまま写し、流用元を `reused_from`(`flow_id`・`feature_code`)に、今回の実行の結果を `verified` に書く(lint `setup_steps_recorded`。proc-v017 以降のフロー)。`S-CLEAN-ENV` は工程0の復元そのものであり、`provided_by` を書いて `steps` を持たない
- `classification: blocked` のエントリには `blocked_by`(理由 `reason`・申し送りID `handoff`・需要ID `ext_demand` または禁止ID `prohibition`)を書く
