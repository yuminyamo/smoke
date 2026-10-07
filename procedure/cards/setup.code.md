# カード {{card_id}} / 種類: setup.code(fixture とシナリオ部品のコード)/ {{flow_id}}

{{reissue}}

## やること(1つだけ)

状態 **{{state_id}}**({{definition}})の、合格した操作列を、シナリオ部品(`tests/flows/`)と fixture(`tests/fixtures/`)のコードにし、fixture を使ったテストを2回実行して確かめる。

## 入力

- 状態ID: `{{state_id}}` / 定義: {{definition}}
- 作り直し: {{rebuild}}
- setup-log の記録(pms が `pms act` の記録から書いたもの。コードはこれと一致させる):
{{setup_entry}}
- 記録から作ったコードの下書き(値は環境情報の取り出しに置き換えてある。規約に合う形に置き直して使う):
{{draft}}
- 既存のコード(同じ操作の部品・ページオブジェクトがあれば使う):
{{existing_code}}
- 起動確認テスト: {{readiness}}
- 環境情報の読み方: テストコードは `tests/helpers/env.ts` の `envValue('<キー>')` で値を読む

## 規則(このカードに必要なものだけ)

{{rule:R-PMS-2}}
{{rule:R-PMS-3}}
{{rule:R-SETC-1}}
{{rule:R-SETC-2}}
{{rule:R-SETC-3}}
{{rule:R-SETC-4}}
{{rule:R-STA-1}}
{{rule:R-STA-3}}
{{rule:R-PRT-1}}
{{rule:R-PRT-2}}
{{rule:R-PRT-3}}
{{rule:R-PRT-4}}
{{rule:R-PO-1}}
{{rule:R-PO-2}}
{{rule:R-PO-3}}
{{rule:R-PO-4}}
{{rule:R-PO-5}}
{{rule:R-DAT-2}}
{{rule:R-ENV-1}}

## 出力(この形の JSON を `{{out_file}}` に書く)

```json
{
  "result": "coded | cannot_proceed",
  "flow": "flows/<ファイル>.ts#<関数名>",
  "fixture": "fixtures/<ファイル>.ts#<名前>",
  "runs": [
    { "command": "<実行したコマンド>", "exit_code": <終了コード>, "started_at": "<開始時刻>", "ended_at": "<終了時刻>" },
    { "command": "<2回目>", "exit_code": <終了コード>, "started_at": "<開始時刻>", "ended_at": "<終了時刻>" }
  ],
  "cleanup": "<後始末>",
  "notes": null
}
```

- `runs` は2回分を、実行した結果のとおりに書く(時刻は `vocab.timestamp_format`。例 2026-10-03T13:50:12+09:00)。失敗した回も書く(pms が `verified: false` と記録する)
- 記録の各操作のロケータと established check のロケータは、部品・fixture(と、そこから import するページオブジェクト)のコードに現れなければならない

{{schema}}

## 合格した記入例(別の状態のもの)

```json
{
  "result": "coded",
  "flow": "flows/auth.ts#loginAsUser",
  "fixture": "fixtures/auth.ts#userLogin",
  "runs": [
    { "command": "npx playwright test tests/readiness/server-ready.setup.ts --workers=1", "exit_code": 0, "started_at": "2026-10-07T10:12:03+09:00", "ended_at": "2026-10-07T10:12:21+09:00" },
    { "command": "npx playwright test tests/readiness/server-ready.setup.ts --workers=1", "exit_code": 0, "started_at": "2026-10-07T10:12:40+09:00", "ended_at": "2026-10-07T10:12:57+09:00" }
  ],
  "cleanup": "なし(ゴールデンイメージ復元で初期化)",
  "notes": null
}
```

## 終わったら

`{{out_file}}` を書いてから、次を実行する。

```
{{submit}}
```

不合格なら、返された `failures` の理由のところだけを直して、同じコマンドで再提出する。
