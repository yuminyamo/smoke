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
    notes: ''
```

補足ルール:

- **`classification: built-by-ui` のエントリには `steps` を必ず書く**(成功した最短の操作列)。fixture(`fixture`)・シナリオ部品(`flow`)のコードに書いたことを、`steps` の代わりにしない。作業20は setup-log の記録を根拠に fixture を確かめ、作業30は操作列を setup-log から転記するためである
- 各 step には操作の対象を書く。`goto` は `detail`(遷移先。環境情報は `<env:キー>`)、`external` は `operation_id`(KB T05 の操作ID)、それ以外の操作(`click`・`fill` など)は `locator` である(lint `setup_steps_recorded`)
- `locator` は付録Aの `actions[].locator` と同じく、**安定ロケータ(またはページオブジェクト/部品のメソッド参照)のみ**。snapshot の一時IDを書かない(lint `no_temp_locator`)
- 記録する時機は §10 フェーズAに従う(状態を1つ整備・確認したら、次の状態へ進む前に記録する)
