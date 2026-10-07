# カード {{card_id}} / 種類: setup.reuse(既存の fixture の流用)/ {{flow_id}}

{{reissue}}

## やること(1つだけ)

状態 **{{state_id}}**({{definition}})を作る既存の fixture を1回実行し、状態が成立する(established check が通る)かを確かめる。

## 入力

- 状態ID: `{{state_id}}` / 定義: {{definition}}
- 流用元: {{source_flow}} の setup-log のエントリ
{{source_entry}}
- 実行のしかた: {{run_example}}

## 規則(このカードに必要なものだけ)

{{rule:R-PMS-2}}
{{rule:R-PMS-3}}
{{rule:R-SETR-1}}
{{rule:R-STA-3}}

## 出力(この形の JSON を `{{out_file}}` に書く)

```json
{
  "result": "reused | broken | cannot_proceed",
  "runs": [
    { "command": "<実行したコマンド>", "exit_code": <終了コード>, "started_at": "<開始時刻>", "ended_at": "<終了時刻>" }
  ],
  "notes": "<broken のときは失敗のしかた(1〜2文)> | null"
}
```

- `reused`: 実行が成功した(終了コード 0)。pms が流用元の記録を写して setup-log に書く
- `broken`: 実行が失敗した(終了コード 0 以外)。直さない。作り直しのカードは pms が出す
- `runs` は1回分を、実行した結果のとおりに書く(時刻は `vocab.timestamp_format`。例 2026-10-03T13:50:12+09:00)

{{schema}}

## 合格した記入例(別の状態のもの)

```json
{
  "result": "broken",
  "runs": [
    { "command": "npx playwright test tests/specs/dev/device.spec.ts --workers=1", "exit_code": 1, "started_at": "2026-10-07T10:20:11+09:00", "ended_at": "2026-10-07T10:21:02+09:00" }
  ],
  "notes": "デバイス登録画面の保存ボタンの名前が「登録」に変わっており、fixture の established check の前で止まった"
}
```

## 終わったら

`{{out_file}}` を書いてから、次を実行する。

```
{{submit}}
```

不合格なら、返された `failures` の理由のところだけを直して、同じコマンドで再提出する。
