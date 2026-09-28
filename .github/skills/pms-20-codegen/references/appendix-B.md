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
