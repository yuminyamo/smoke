---
review_status: unreviewed
reviewed_at:
reviewer:
review_scope:
review_notes:
generated_by: 作業40(IR-001)
generated_at: 2026-10-11
---

# 作業40 手順改善 報告書 IR-001

## 1. 要約

- 実行: IR-001(2026-10-11)。人間の指示「SIG-0009の改善を実施して。処理途中ですが気にせず修正して」による改訂だけを行った
- 改訂: IMP-001(CM/進行役と記録の道具(pms)、区分B、状態 `指示適用`)。Claude Code のカードのエージェントに `disallowedTools` を書かず、使用禁止は `config/pms.json` の `runner.claude.deny`(CLI の `--disallowedTools`)だけで渡す
- 版: proc-v028 → proc-v029(タグ proc-v029)。000 改訂履歴 39章
- outcome: partial_success(未処理シグナル SIG-0001〜0008 を振り分けていない。完了したフローがなく指標の行もない)
- 最も重要な1件: **実行中の F-001(proc-v028)の最中に配備した。** F-001 の作業10の続きは、生成し直した `.claude/agents/pms-card-*.md` で動く

## 2. サマリ

| 項目 | 件数 |
|---|---|
| 処理したシグナル | 1(SIG-0009) |
| 未処理のまま残したシグナル | 8(SIG-0001〜0008) |
| 起票した改訂 | 1(IMP-001。指示適用) |
| 試行の開始・判定 | 0 |

## 3. 参照した前段成果物・KBエントリとレビュー状況

- `work/_common/procedure-improvement.md`(unreviewed): SIG-0009 の行
- `work/_flows/F-001/flow.md`(unreviewed): C-0001 の STOP の記録
- KB: 参照なし。発見イベント 0 件 / 再発見 0 件

## 4. 資産流用の実績

なし(手順書と生成スクリプトの差分のみ)

## 5. 申し送り台帳への追記

なし

## 6.1 ガード異常と指標の推移

- ガード異常: なし(完了したフローがなく、計算の対象がない)
- 指標: `work/_improve/metrics.md` に行を追記していない(完了したフローがないため)

## 6.2 振り分けの結果

| 行き先 | 件数 | シグナル |
|---|---|---|
| 手順 | 1 | SIG-0009 → IMP-001 |
| その他 | 0 | — |

## 6.3 起票した改訂案(区分別)

| 区分 | IMP |
|---|---|
| A | なし |
| B | IMP-001(■進行役と記録の道具 は保護ブロック外の 00 のため B。人間の指示で適用) |
| C | なし |

## 6.4 試行を開始した改訂

なし(IMP-001 は指示適用)

## 6.5 判定の結果

なし(判定期限に達した試行中の改訂がない)

## 6.6 人間の採否待ちの一覧

なし

## 6.7 人間の指示で適用した改訂

- IMP-001 — 指示の原文は `procedure/docs/000_overview.md` 39章。差分は `work/_improve/IR-001/diffs/IMP-001.diff`
  - `tools/build-skills/build-skills.mjs`: Claude Code のカードのエージェントの frontmatter に `disallowedTools` を出力しない
  - `procedure/00_common.md` ■進行役と記録の道具: Claude Code は `runner.claude.deny` だけで止めること、B1 の Claude Code のサブエージェントには使用禁止がないことを書いた
  - `procedure/cards/agents.yaml`(注記)・`config/pms.sample.json`(`runner.claude._comment`)・`tools/pms/README.md`(実物で確かめること)を合わせた
  - `tools/build-skills/test/build-skills.test.mjs`: `disallowedTools` がないことを確かめる
- 確認: `node tools/build-skills/build-skills.mjs --check` OK / `node tools/lint/lint.mjs` ERROR 0 件 / build-skills のテスト 5/5・pms のテスト 55/55 合格 / Claude Code 2.1.296 の `claude -p --agent pms-card-setup-build --disallowedTools "Bash(sqlcmd *)" …` の init の tools が `Read, Edit, Write, Grep, Glob, Bash`(Bash・Edit が残る)

## 6.8 不可侵に触れる提案

なし

## 6. 未確認・要確認事項 / 前段成果物への疑義

- **B1 の Claude Code(`claude --agent pms-runner` がカードのエージェントをサブエージェントとして呼ぶ形)では、カードのエージェントにコマンドごとの使用禁止がなくなった。** 止めるのは記録の検査(`seq_missing`)とカードの規則(R-PMS-1)だけである。サブエージェントに使用禁止を効かせる方法(プロジェクトの設定の permissions.deny など。人間のセッションにも効く)は、必要なら別に決める
- `--disallowedTools` のパターン(`Bash(sqlcmd *)`・`Edit(procedure/**)`)で、コマンドと書き込みが実際に拒まれるかは確かめていない(Bash が残ることだけを確かめた)。`tools/pms/README.md` の実物で確かめることに残した
- 各自の `config/pms.json` に `runner.claude.deny` がない人は、見本から写す必要がある(この作業場所の `config/pms.json` にはある)
- F-001 の flow.md・フロー台帳の手順版は proc-v028 のまま。作業20の開始時の版の照合で食い違いが報告される見込み(■手順書の版と配備)。実行AIの成果物なので書き換えていない

## 7. 優先レビュー推奨リスト

1. IMP-001 の B1 での使用禁止の欠落(上記 6)。B1 を Claude Code で使うかどうかで、追加の手当ての要否が変わる
2. F-001 の版の食い違いの扱い(proc-v028 で開始し、途中で proc-v029 を配備)

## 8. 手順改善シグナル・残留データ・環境への影響

- 本作業で記録したシグナル: なし
- 検証環境: 使っていない(手順書と生成スクリプトの変更のみ)
