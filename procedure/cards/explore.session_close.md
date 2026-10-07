# カード {{card_id}} / 種類: explore.session_close(探索セッションの終わりの処理)/ {{flow_id}}

{{reissue}}

## やること(1つだけ)

このラウンドの全シナリオの探索が終わった。**DB 全体の不変条件の検査を1回行う。**

## 入力

- このラウンドのシナリオ: {{scenarios}}
- シナリオ末尾の検査の結果:
{{scenario_invariants}}
- DB不変条件の注記: {{invariant_note}}

DB不変条件(`vocab.invariant`):

{{vocab:invariant}}

## 規則(このカードに必要なものだけ)

{{rule:R-PMS-2}}
{{rule:R-PMS-3}}
{{rule:R-PMS-5}}
{{rule:R-EXP-19}}
{{rule:R-INV-2}}
{{rule:R-INV-3}}
{{rule:R-INV-4}}

{{protected:INV_NO_RETRY}}

## 出力(この形の JSON を `{{out_file}}` に書く)

```json
{
  "result": "checked | cannot_proceed",
  "invariants": { "INV-001": "pass | fail | 未実施(<理由>)", "…": "…" },
  "violations": [],
  "notes": null
}
```

{{schema}}

## 合格した記入例

```json
{
  "result": "checked",
  "invariants": { "INV-001": "未実施(課金スキーマ未確認)", "INV-002": "未実施(課金スキーマ未確認)", "INV-003": "pass", "INV-004": "fail", "INV-005": "pass" },
  "violations": [{ "inv": "INV-004", "detail": "BillingDetail に Amount = -120 の行が1件(BillingId 553。本フローのデータではない)" }],
  "notes": null
}
```

## 終わったら

`{{out_file}}` を書いてから、次を実行する。

```
{{submit}}
```

不合格なら、返された `failures` の理由のところだけを直して、同じコマンドで再提出する。
