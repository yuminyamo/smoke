# カード {{card_id}} / 種類: setup.build(状態を画面操作で作る)/ {{flow_id}}

{{reissue}}

## やること(1つだけ)

状態 **{{state_id}}**({{definition}})を、`pms act` による画面操作で作り、成立を `pms act assert` で確かめる。

## 入力

- 状態ID: `{{state_id}}` / 定義: {{definition}}
- この状態を requires に持つシナリオ: {{scenarios}}
- established check の案: {{established_check_idea}}
- 状態需要リストの行: {{state_demand}}
- 作り直し: {{rebuild}}
- 現在の画面の URL: {{current_url}}
- 参考になる資料(必要なら読む):
{{kb_pages}}
- 使える環境情報のキー(値は `<env:キー>` と書けば pms が取り出す。値を調べて書かない):
{{env_keys}}
- 禁止操作リスト: `work/_common/prohibited-operations.md`(外部操作を使うときに読む)

## 操作のしかた

| したいこと | コマンド |
|---|---|
| ブラウザを開く | `{{act}} open "<env:pms.url>"` |
| 画面の要素参照(ref)を見る | `{{act}} snapshot` |
| 要素を操作する | `{{act}} --intent "<この操作の目的>" click <ref>` / `fill <ref> "<値|<env:キー>>"` / `select`・`check`・`press <ref> Enter` など |
| 成立を確かめる | `{{act}} --intent "<確かめること>" assert <ref> visible`(`hidden` / `text "<文言>"`) |
| 外部操作 | `{{act}} --intent "<目的>" ext --op <KB T05 の操作ID> -- <実行体の呼び出し...>` |

`pms act` の出力の `seq` が、その操作の連番である。出力の `warnings` に安定でない・一意でないと出たら、別の要素で操作し直す。

## 規則(このカードに必要なものだけ)

{{rule:R-PMS-1}}
{{rule:R-PMS-2}}
{{rule:R-PMS-3}}
{{rule:R-PMS-4}}
{{rule:R-SETB-1}}
{{rule:R-SETB-2}}
{{rule:R-SETB-3}}
{{rule:R-SETB-4}}
{{rule:R-STA-2}}
{{rule:R-LOC-1}}
{{rule:R-LOC-2}}
{{rule:R-LOC-3}}
{{rule:R-LOC-4}}
{{rule:R-DAT-1}}
{{rule:R-ENV-1}}

外部操作と禁止操作(00_common.md の保護ブロック。文言を変えずに引用する):

{{protected:EXT_SKILL_ONLY}}

{{protected:PROHIBITED_OPS}}

`blocked` の理由コード(`vocab.reason_code`):

{{vocab:reason_code}}

## 出力(この形の JSON を `{{out_file}}` に書く)

```json
{
  "result": "built | blocked | cannot_proceed",
  "seqs": [<成功した最短の操作の連番>],
  "established_check_seq": <成立を確かめた assert の連番 | null>,
  "fragile": [],
  "blocked": null,
  "notes": "<失敗した試行の要点(1〜2文)> | null"
}
```

- `built`: `seqs` に1つ以上、`established_check_seq` に assert の連番、`blocked` は null
- `blocked`: `seqs` は []、`established_check_seq` は null、`blocked` に理由を書く(`禁止操作` は `ref` に禁止ID か包括原則の番号、`操作手段なし` は `ext_demand` に外部操作需要リストに書く項目)
- `cannot_proceed`: カードの範囲で判断できない(人間の確認待ちになる)。`notes` に理由を書く

{{schema}}

## 合格した記入例(別の状態のもの)

```json
{
  "result": "built",
  "seqs": [12, 14, 15, 17],
  "established_check_seq": 19,
  "fragile": [],
  "blocked": null,
  "notes": "初回は保存ボタンが無効だった。必須欄の部署を選ぶと有効になる"
}
```

```json
{
  "result": "blocked",
  "seqs": [],
  "established_check_seq": null,
  "fragile": [],
  "blocked": {
    "reason": "操作手段なし",
    "detail": "テスト用デバイスの登録には機器パネルでのペアリング操作が要り、使える skill がない",
    "ref": null,
    "ext_demand": { "operation": "機器パネルでペアリングを承認", "target": "シミュレータ", "gap": "skillなし", "alternative": "不明", "prohibition": "該当なし" }
  },
  "notes": null
}
```

## 終わったら

`{{out_file}}` を書いてから、次を実行する。

```
{{submit}}
```

不合格なら、返された `failures` の理由のところだけを直して、同じコマンドで再提出する。
