# カード {{card_id}} / 種類: report.findings(報告書の所見)/ {{flow_id}}

{{reissue}}

## やること(1つだけ)

作業10の報告書の**所見の欄だけ**を書く。数値・一覧は pms が記録から作った(下の下書き)。下書きの「(カード report.findings で書く)」の欄が、あなたが書く欄である。

## 入力

- 報告書の下書き(pms が記録から作ったもの):
{{drafts}}

{{draft_body}}

## 規則(このカードに必要なものだけ)

{{rule:R-PMS-3}}
{{rule:R-PMS-5}}
{{rule:R-RPT-1}}
{{rule:R-RPT-2}}
{{rule:R-RPT-3}}
{{rule:R-RPT-4}}
{{rule:R-RPT-5}}

{{protected:EXPECTED_IMMUTABLE}}

## 出力(この形の JSON を `{{out_file}}` に書く)

```json
{
  "result": "written | cannot_proceed",
  "headline": "<最も重要な1件(1文)>",
  "inputs_note": null,
  "open_questions": [],
  "priority_review": [{ "item": "<対象>", "reason": "<理由(1文)>" }],
  "prohibition_proposals": [],
  "knowledge_gap": { "needed": false, "reason": null },
  "nd_increment": { "needed": false, "reason": null },
  "notes": null
}
```

{{schema}}

## 合格した記入例(別のフローのもの)

```json
{
  "result": "written",
  "headline": "SC-PRT-02 のジョブログは、マニュアルの記載と異なり一覧に最大40秒遅れて反映される(DISC-PRT-004。製品不具合疑い)",
  "inputs_note": "scenarios.md と非決定値カタログが未レビュー。ジョブIDの強度(パターン一致)が誤っていると SC-PRT-01 の判定に影響する",
  "open_questions": ["SC-PRT-03-S2 の期待結果「完了状態になる」が、ジョブの状態 Completed と Printed のどちらを指すか文書から確定できなかった(human-check にした)"],
  "priority_review": [
    { "item": "explore.close の INV-003〜005 の SQL", "reason": "誤った INV は偽の失敗を全シナリオに撒くため" },
    { "item": "DISC-PRT-004", "reason": "製品不具合疑いで、作業20のアサーションの待機時間に影響するため" }
  ],
  "prohibition_proposals": [],
  "knowledge_gap": { "needed": false, "reason": null },
  "nd_increment": { "needed": true, "reason": "未登録の非決定値が3件あり、ジョブ一覧の並び順の強度が決まっていないため" },
  "notes": null
}
```

## 終わったら

`{{out_file}}` を書いてから、次を実行する。

```
{{submit}}
```

不合格なら、返された `failures` の理由のところだけを直して、同じコマンドで再提出する。
