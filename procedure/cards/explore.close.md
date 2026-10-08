# カード {{card_id}} / 種類: explore.close(シナリオの終わりの処理)/ {{flow_id}}

{{reissue}}

## やること(1つだけ)

シナリオ **{{scenario_id}}** の探索が終わった。**シナリオ末尾の DB不変条件を検査し、探索で確立した操作の反映先を決めて反映する。** シナリオの判定は pms がステップの判定から決める(ここでは書かない)。

## 入力

- シナリオの目的: {{purpose}}
- ステップの記録(pms が記録から抜き出したもの):
{{steps_summary}}
- 持ち回ったデータ(このシナリオが作ったデータ。DB不変条件の検査はこのデータに限る): {{carried_data}}
- 既存のシナリオ部品・fixture・ページオブジェクト:
{{existing_code}}
- DB不変条件の注記: {{invariant_note}}
- DB の接続: {{db_connection}}

DB不変条件(`vocab.invariant`):

{{vocab:invariant}}

反映先の区分(`vocab.reflection_target`):

{{vocab:reflection_target}}

## 規則(このカードに必要なものだけ)

{{rule:R-PMS-2}}
{{rule:R-PMS-3}}
{{rule:R-PMS-5}}
{{rule:R-EXP-16}}
{{rule:R-EXP-17}}
{{rule:R-EXP-18}}
{{rule:R-INV-1}}
{{rule:R-INV-2}}
{{rule:R-DB-1}}
{{rule:R-DB-2}}
{{rule:R-INV-3}}
{{rule:R-INV-4}}
{{rule:R-PO-1}}
{{rule:R-PO-2}}
{{rule:R-PO-3}}
{{rule:R-PO-4}}
{{rule:R-PO-5}}
{{rule:R-PRT-1}}
{{rule:R-HO-1}}
{{rule:R-SIG-1}}
{{rule:R-SIG-2}}

DB不変条件の違反の扱い(`00_common.md` の保護ブロック):

{{protected:INV_NO_RETRY}}

## 出力(この形の JSON を `{{out_file}}` に書く)

```json
{
  "result": "closed | cannot_proceed",
  "invariants": { "INV-001": "pass | fail | 未実施(<理由>)", "…": "…" },
  "violations": [],
  "reflections": [{ "operation": "<確立した操作>", "target": "<反映先の区分>", "path": "<反映したファイル> | null" }],
  "manual_gap": false,
  "handoffs": [],
  "procedure_signals": [],
  "notes": null
}
```

{{schema}}

## 合格した記入例(別のシナリオのもの)

```json
{
  "result": "closed",
  "invariants": { "INV-001": "未実施(課金スキーマ未確認)", "INV-002": "未実施(課金スキーマ未確認)", "INV-003": "pass", "INV-004": "pass", "INV-005": "pass" },
  "violations": [],
  "reflections": [
    { "operation": "印刷ジョブ一覧の検索", "target": "page", "path": "tests/pages/JobListPage.ts" },
    { "operation": "テスト用プリンタの登録(前提データ)", "target": "flow", "path": "tests/flows/printer.ts#registerPrinter" }
  ],
  "manual_gap": false,
  "handoffs": [],
  "procedure_signals": [],
  "notes": null
}
```

## 終わったら

`{{out_file}}` を書いてから、次を実行する。

```
{{submit}}
```

不合格なら、返された `failures` の理由のところだけを直して、同じコマンドで再提出する。
