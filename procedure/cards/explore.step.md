# カード {{card_id}} / 種類: explore.step(シナリオの1ステップを探索して判定する)/ {{flow_id}}

{{reissue}}

## やること(1つだけ)

シナリオ **{{scenario_id}}** のステップ **{{step_id}}**({{position}})を、`pms act` による画面操作で探索し、**期待結果を満たすかを判定する。** このステップだけを行う(次のステップを先に探索しない)。

## 入力

- シナリオの目的: {{purpose}}
- シナリオの合格条件: {{pass_condition}}
- このステップ(scenarios.md の行。**期待結果・判定基準は変えない**):

{{step_row}}

- 前のステップまでの記録(記録から pms が抜き出したもの):
{{previous}}
- 持ち回るデータの現在の値: {{carried_data}}
- 持ち回るデータ(シナリオの定義): {{carried_fields}} / 使用する外部操作: {{used_ops}}
- 前提状態(最初のステップのとき。setup-log の記録。画面がこの状態でなければ、この操作列を `pms act` で行ってから始める):
{{setup}}
- 現在の画面の URL: {{current_url}}
- このステップ・シナリオに関わる申し送り(パートBで記録済みのもの。blocked にするときは `blocked_by.handoff` にIDを書く):
{{ledger_refs}}
- 参考になる資料(必要なら読む):
{{kb_pages}}
- 非決定値カタログ: {{nd_catalog}}
- 禁止操作リスト: `work/_common/prohibited-operations.md`(外部操作を使う前に読む)
- 使える環境情報のキー(値は `<env:キー>` と書けば pms が取り出す。値を調べて書かない):
{{env_keys}}

## 操作のしかた

| したいこと | コマンド |
|---|---|
| ブラウザを開く・移動する | `{{act}} open "<env:pms.url>"` / `{{act}} goto "<URL>"` |
| 画面の要素参照(ref)を見る | `{{act}} snapshot` |
| 要素を操作する | `{{act}} --intent "<この操作の目的>" click <ref>` / `fill <ref> "<値|<env:キー>>"` / `select`・`check`・`press <ref> Enter` など |
| 画面で期待結果を確かめる | `{{act}} --intent "<確かめること>" assert <ref> visible`(`hidden` / `text "<文言>"`) |
| 証跡を撮る | `{{act}} --intent "<何の証跡か>" screenshot`(`{{evidence_dir}}/` に保存される) |
| 外部操作 | `{{act}} --intent "<目的>" ext --op <KB T05 の操作ID> -- <実行体の呼び出し...>` |
| DB を確かめる | 下の「DB の接続」の `pms db` で SELECT を1つずつ実行し、文と結果の要点を出力の `verification.db` に書く(sqlcmd を直接呼ばない) |

DB の接続: {{db_connection}}

`pms act` の出力の `seq` が、その操作の連番である。出力の `warnings` に安定でない・一意でないと出たら、別の要素で操作し直す。

## 規則(このカードに必要なものだけ)

{{rule:R-PMS-1}}
{{rule:R-PMS-2}}
{{rule:R-PMS-3}}
{{rule:R-PMS-4}}
{{rule:R-PMS-5}}
{{rule:R-EXP-1}}
{{rule:R-EXP-2}}
{{rule:R-EXP-3}}
{{rule:R-EXP-4}}
{{rule:R-EXP-5}}
{{rule:R-EXP-6}}
{{rule:R-EXP-7}}
{{rule:R-EXP-8}}
{{rule:R-EXP-9}}
{{rule:R-EXP-10}}
{{rule:R-EXP-11}}
{{rule:R-EXP-12}}
{{rule:R-EXP-13}}
{{rule:R-EXP-14}}
{{rule:R-EXP-15}}
{{rule:R-JDG-1}}
{{rule:R-JDG-2}}
{{rule:R-JDG-3}}
{{rule:R-JDG-4}}
{{rule:R-DB-1}}
{{rule:R-DB-2}}
{{rule:R-HLT-1}}
{{rule:R-HLT-2}}
{{rule:R-WAIT-1}}
{{rule:R-WAIT-2}}
{{rule:R-WAIT-3}}
{{rule:R-WAIT-4}}
{{rule:R-WAIT-5}}
{{rule:R-DISC-1}}
{{rule:R-DISC-2}}
{{rule:R-LOC-1}}
{{rule:R-LOC-2}}
{{rule:R-LOC-3}}
{{rule:R-LOC-4}}
{{rule:R-DAT-1}}
{{rule:R-ENV-1}}
{{rule:R-HO-1}}
{{rule:R-SIG-1}}
{{rule:R-SIG-2}}
{{rule:R-SIG-3}}

申し送り・DISC・手順改善シグナルは、台帳に直接書かず、出力の `handoffs`・`discrepancies`・`procedure_signals` に書く(pms が台帳に行を足す)。

期待結果・判定基準(`stages.md` の保護ブロック。文言を変えずに引用する):

{{protected:EXPECTED_IMMUTABLE}}

正解の定義・非決定値(`00_common.md` の保護ブロック):

{{protected:ORACLE}}

{{protected:ND_STRENGTH}}

外部操作と禁止操作(`00_common.md` の保護ブロック):

{{protected:EXT_SKILL_ONLY}}

{{protected:PROHIBITED_OPS}}

判定(`vocab.verdict`):

{{vocab:verdict}}

健全性シグナルの種類(`vocab.health_signal_kind`):

{{vocab:health_signal_kind}}

`blocked` の理由コード(`vocab.reason_code`):

{{vocab:reason_code}}

## 出力(この形の JSON を `{{out_file}}` に書く)

```json
{
  "result": "explored | cannot_proceed",
  "verdict": "passed | failed | human-check | blocked | null",
  "seqs": [<このステップの操作の連番>],
  "fragile": [],
  "verification": { "method": "<検証手段>", "screen_seqs": [<assert の連番>], "db": { "query": "SELECT …", "result": "<要点>" } | null, "reason": "<理由> | null" } | null,
  "observed": "<観測した事実>",
  "assertion_hint": "<作業20への検証方法の提案>",
  "carried_data": { "<名前>": "<実値>" },
  "nondeterministic": [],
  "wait": null,
  "health_signal": null,
  "blocked_by": null,
  "discrepancies": [],
  "handoffs": [],
  "procedure_signals": [],
  "ops_registered": [],
  "evidence": [<screenshot の連番>],
  "notes": "<失敗した試行の要点> | null"
}
```

- このステップの期待結果を検証手段どおりに確かめられた・確かめられなかった: `passed` / `failed` / `human-check`(`blocked_by` は null)
- このステップから実行できない: `blocked`(`verification` は null、`blocked_by` に理由・参照・再開するステップ。操作をしたなら `seqs` に書いてよい)
- カードの範囲で判断できない(環境情報が足りない・画面に到達する手段が見当たらない等): `cannot_proceed`(人間の確認待ちになる。`notes` に理由)

{{schema}}

## 合格した記入例(別のステップのもの)

```json
{
  "result": "explored",
  "verdict": "passed",
  "seqs": [31, 33, 34],
  "fragile": [],
  "verification": { "method": "両方", "screen_seqs": [35], "db": { "query": "SELECT COUNT(*) FROM PrintJob WHERE JobId = 'JOB-00001042'", "result": "1 件" }, "reason": null },
  "observed": "受付完了のメッセージが表示され、ジョブID JOB-00001042 が採番された",
  "assertion_hint": "DB: SELECT COUNT(*) FROM PrintJob WHERE JobId = <carried_data.job_id> = 1。画面は getByRole('alert') に受付完了",
  "carried_data": { "job_id": "JOB-00001042" },
  "nondeterministic": [{ "value": "ジョブID", "catalog_id": "ND-UI-001", "strength": "パターン一致" }],
  "wait": null,
  "health_signal": null,
  "blocked_by": null,
  "discrepancies": [],
  "handoffs": [],
  "procedure_signals": [],
  "ops_registered": [],
  "evidence": [36],
  "notes": null
}
```

```json
{
  "result": "explored",
  "verdict": "blocked",
  "seqs": [],
  "fragile": [],
  "verification": null,
  "observed": null,
  "assertion_hint": null,
  "carried_data": {},
  "nondeterministic": [],
  "wait": null,
  "health_signal": null,
  "blocked_by": {
    "reason": "操作手段なし",
    "detail": "機器パネルでの認証印刷の解除に使える skill がない(KB T05 にも登録がない)",
    "ref": null,
    "handoff": null,
    "ext_demand": { "operation": "機器パネルで認証印刷を解除", "target": "シミュレータ", "gap": "skillなし", "alternative": "なし", "prohibition": "該当なし" },
    "resume_from": "SC-PRT-03-S2"
  },
  "discrepancies": [],
  "handoffs": [],
  "procedure_signals": [],
  "ops_registered": [],
  "evidence": [],
  "notes": null
}
```

## 終わったら

`{{out_file}}` を書いてから、次を実行する。

```
{{submit}}
```

不合格なら、返された `failures` の理由のところだけを直して、同じコマンドで再提出する。
