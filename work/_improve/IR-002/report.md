---
review_status: unreviewed
reviewed_at:
reviewer:
review_scope:
review_notes:
generated_by: 作業40(IR-002)
generated_at: 2026-10-12
---

# 作業40 手順改善 報告書 IR-002

## 1. 要約

- 実行: IR-002(2026-10-12)。人間の指示(KB カテゴリ T13 UI操作知見の新設)による改訂と、未処理シグナル 18件の振り分けを行った
- 改訂: IMP-002(区分B、状態 `指示適用`)。KB T13(`kb/ui-tips/`、`UIT-<4桁>`、部品の型ごとに1ファイル)を新設し、操作のコツの記録先を `kb/gotchas/` から T13 に変えた。pms は T13 の全ファイルのパスと索引の主題を、setup.build・setup.code・explore.step・explore.close のカードに渡す
- 版: proc-v030 → proc-v031(タグ proc-v031)。000 改訂履歴 41章
- outcome: success
- 最も重要な1件: **KB T13 はまだ空である。** 配備後のセッションで記事(GOT-0001〜0003 の移し替えを含む)を書くまで、カードの「UI操作知見」は「なし」になり、IMP-002 の効果は出ない

## 2. サマリ

| 項目 | 件数 |
|---|---|
| 処理したシグナル | 18(SIG-0001〜0008・0010〜0019) |
| 未処理のまま残したシグナル | 0 |
| 起票した改訂 | 4(指示適用 1・承認待ち 3) |
| 試行の開始・判定 | 0 |

## 3. 参照した前段成果物・KBエントリとレビュー状況

- `work/_common/procedure-improvement.md`(unreviewed): SIG-0001〜0019
- `work/_flows/F-001/flow.md`(unreviewed): suspended で閉じた記録
- `work/USR/exploration/status.yaml`・`work/USR/codegen/status.yaml`(unreviewed): 指標の計算
- `work/USR/scenarios.md`(unreviewed)・`work/_common/nondeterministic-catalog.md`(unreviewed): ガード指標の計算
- KB: `kb/00_索引.md` のみ(T13 の行がないことの確認)。発見イベント 0 件 / 再発見 0 件

## 4. 資産流用の実績

なし(手順書と pms の差分のみ)

## 5. 申し送り台帳への追記

なし

## 6.1 ガード異常と指標の推移

- ガード異常: なし(F-001 が最初の行で、比べる前の行がない)
- `work/_improve/metrics.md` に F-001 の行を足した。F-001 は done ではなく suspended で閉じたが、作業10・20を終えているため指標の基準とした。再発見率 0 / lint ERROR 1(procedure_version_present)/ 差し戻し 0 / flaky 0 / 逸脱 5 / 存在のみ比率 0.00 / 両方比率 0.90

## 6.2 振り分けの結果

| 行き先 | 件数 | シグナル |
|---|---|---|
| 手順 | 8 | SIG-0011・0012 → IMP-002 / SIG-0013・0014 → IMP-003 / SIG-0001・0007・0018 → IMP-004 / SIG-0010 → IMP-005 |
| KB | 1 | SIG-0015(T03 へ。NIM_LOCK_ON_ATACK が無効を表すかを作業01の調査候補に) |
| 様子見 | 8 | SIG-0002・0003・0004・0005・0006・0008・0016・0019(1件だけで、後段・人間の裏付けがない) |
| 見送り | 1 | SIG-0017(proc-v030 の撤回に伴う一回限りの残留物。下の §6 を参照) |

SIG-0011・0012 の事象そのもの(ツリーの項目の遅れた描画・操作メニューの開閉)は、KB T13 の記事の材料である。記事は配備後のセッションで書く。

## 6.3 起票した改訂案(区分別)

| 区分 | IMP |
|---|---|
| A | なし |
| B | IMP-002(指示適用)/ IMP-003(ST/10/付録A)/ IMP-004(CM/ディレクトリ構成)/ IMP-005(ST/20/4) |
| C | なし |

## 6.4 試行を開始した改訂

なし(IMP-002 は指示適用。IMP-003〜005 は承認待ち)

## 6.5 判定の結果

なし(判定期限に達した試行中の改訂がない。IMP-001 は B2 の Claude Code で1フロー分のカードが実行されていないため判定期間中)

## 6.6 人間の採否待ちの一覧

- IMP-003(ST/10/付録A): 確認のための操作(再読込・開き直し)も actions に入れること、verified_by と操作の記録の assert の locator を一致させることを付録A に書く。作業20で同じ種類の後段不足が2件出た(SIG-0013・0014)
- IMP-004(CM/ディレクトリ構成): 作業02・機能一覧・作業20の成果物の置き場所を ■ディレクトリ構成 に加える。3つの作業で同じ種類の不足が出た(SIG-0001・0007・0018)
- IMP-005(ST/20/4): フローの途中で手順版が変わったときの扱いを決める。F-001 が done にできず suspended で閉じた原因(SIG-0010)

## 6.7 人間の指示で適用した改訂

- IMP-002 — 指示の原文は `procedure/docs/000_overview.md` 41章。差分は `work/_improve/IR-002/diffs/IMP-002.diff`
  - vocab: `kb_category.T13`、`id_format.ui_tip`、`reflection_target.kb`、T10 の説明
  - 00: ■ロケータ規約 の R-LOC-5(読む)・R-LOC-6(書く)、■ディレクトリ構成 の `ui-tips/`
  - stages: §01・§02・§10(R-EXP-6・R-EXP-17)・§15・§20(入力表と、記録にない操作を足すとき)、付録E の T13
  - cards: setup.build・setup.code・explore.step・explore.close に入力「UI操作知見」と規則 R-LOC-5・R-LOC-6(explore.close は R-LOC-6 だけ)
  - pms: `lib/queue.mjs` の `uiTips`・`uiTipsList`、`lib/explore.mjs`・README、テスト(explore.test.mjs にテスト1件、pms.test.mjs の setup.code の確認)
- 確認: `node tools/build-skills/build-skills.mjs --check` OK / pms のテスト 56/56・build-skills 5/5・lint 37/37・env 7/7・pre-stage 12/12 合格 / `node tools/lint/lint.mjs` の ERROR は改訂前からある1件だけ(下の §6)

## 6.8 不可侵に触れる提案

なし(保護ブロックは変えていない)

## 6. 未確認・要確認事項 / 前段成果物への疑義

- **lint の ERROR 1件(procedure_version_present)が残る。** F-001 の作業10(proc-v028)と作業20(proc-v030)の版の食い違いで、改訂前からある。手順書ではなく F-001 の成果物に対するもの。扱いは IMP-005 の採否で決まる
- **`tests/helpers/invariants.ts`(SIG-0017)は、どのテストからも使われていない残留物である。** 消すかどうかは人間が決める(作業40は実行AIの成果物を書き換えない)
- **タグ proc-v030 がなかった。** コミット 1f4260b(proc-v030)にタグが付いていなかったので付けた
- **IR-001 の成果物(report・status・diff・metrics)は、ステージ済みのままコミットされていなかった。** 台帳と metrics を IR-002 でも変えたため、IR-002 と同じコミットに入れた
- `.claude/skills/awms-ui-tips/`(git に入っていない人間向けの skill)は、記録先を `kb/gotchas/` と書いたまま。T13 の記事を書くときに合わせるとよい
- 索引の書式(SIG-0003、様子見)は決まっていない。pms は列「主題」を読む。T13 の行を足すときは、この列名の表に入れる

## 7. 優先レビュー推奨リスト

1. IMP-005 の採否(F-001 のような版の食い違いの扱い)
2. 付録E の T13 の書式と記入例が、配備後に書く記事の形に合うか
3. IMP-003・IMP-004 の採否

## 8. 手順改善シグナル・残留データ・環境への影響

- 本作業で記録したシグナル: なし
- 検証環境: 使っていない(手順書と pms の変更のみ)
