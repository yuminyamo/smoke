// report.mjs — pms report: 作業10の報告書(report.md)の数値・一覧と status.yaml を記録から作る(docs/94 提案E)
//
// 数値と一覧は、探索記録(exploration-log)・setup-log・キュー(カードの結果と pms が書いた台帳の行)・台帳・
// 作業10の開始時の事実(stage10-context.json)から機械的に決める。AIが書くのは所見の欄だけ(カード report.findings)。
// 報告書の骨格は 00 ■完了報告(report.md)の共通骨格、固有セクションは stages.md §10 の6章、status.yaml は §10 の8章。
// 機能ごとに work/<機能コード>/exploration/report.md・status.yaml を作る(そのフローの、その機能のシナリオだけを数える)。

import fs from 'node:fs';
import path from 'node:path';
import { timestamp, UsageError, readText, writeText } from './util.mjs';
import { readScenarios } from './exploration-log.mjs';
import { readEntries } from './setup-log.mjs';
import { handoffsOfFlow, prohibitionLevels } from './ledgers.mjs';
import { emitDoc } from './yaml-write.mjs';
import { tables } from '../../lint/lib/markdown.mjs';
import { phaseOf, isDone, PMS, targetOf } from './queue.mjs';
import { NO_DETERMINISTIC } from './explore.mjs';

const RESTORE_STATES = new Set(['S-CLEAN-ENV']);

function frontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  return Object.fromEntries(m[1].split('\n').map((l) => l.match(/^([A-Za-z_]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
}

function cell(v) { return String(v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim(); }
function table(header, rows) {
  if (!rows.length) return 'なし';
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}
function bullets(items) { return items.length ? items.map((x) => `- ${x}`).join('\n') : 'なし'; }
const uniq = (a) => [...new Set(a.filter(Boolean))];

/** 再発見率: 発見ログ(logs/discovery-log_*.md)のうち、このフロー・機能のシナリオの行で「再発見」が yes の割合 */
function rediscovery(root, flow, scenarioIds) {
  const dir = path.join(root, 'logs');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  let yes = 0;
  for (const f of fs.readdirSync(dir).filter((x) => /^discovery-log_.*\.md$/.test(x))) {
    for (const t of tables(readText(path.join(dir, f)).split('\n'))) {
      const idCol = t.header.find((h) => h.startsWith('作業'));
      if (!idCol || !t.header.includes('再発見')) continue;
      for (const r of t.rows) {
        const id = String(r.obj[idCol] ?? '');
        if (!id.includes(flow) && !scenarioIds.some((s) => id.includes(s))) continue;
        n++;
        if (/^yes$/i.test(String(r.obj['再発見'] ?? '').trim())) yes++;
      }
    }
  }
  return n ? Math.round((yes / n) * 100) / 100 : 0;
}

/** 機能ごとに記録を集める */
function collect(ctx, q, fc) {
  const { root, paths, proc } = ctx;
  const rel = paths.explorationLog(fc);
  const all = readScenarios(paths.abs(rel), rel, q.flow_id);
  const latest = new Map();
  for (const sc of all) latest.set(sc.id, sc);
  const setups = readEntries(paths.abs(paths.setupLog(fc)), paths.setupLog(fc), q.flow_id);
  const cards = q.cards.filter((c) => (c.feature ?? fc) === fc || c.kind === 'report.findings' || c.kind === 'explore.session_close');
  const round = q.rounds?.at(-1) ?? null;
  const context = round?.context ?? {};
  const findingsCard = q.cards.filter((c) => c.kind === 'report.findings').at(-1) ?? null;
  const findings = findingsCard?.status === 'passed' ? findingsCard.output : null;
  const tracks = q.cards.filter((c) => c.track && (c.feature ?? fc) === fc).map((c) => c.track);
  const handoffs = handoffsOfFlow(root, q.flow_id).filter((h) => String(h.ID).startsWith(`HO-${fc}-`));
  return { fc, all, latest: [...latest.values()], setups, cards, round, context, findings, findingsCard, tracks, handoffs, version: q.procedure_version ?? proc.version };
}

function steps(d) { return d.latest.flatMap((sc) => (sc.steps ?? []).map((s) => ({ sc, s }))); }

/** status.yaml(§10 の8章) */
function statusOf(ctx, q, d, { dodUnmet }) {
  const { root, proc } = ctx;
  const ctxv = d.context;
  const count = (v) => d.latest.filter((sc) => sc.verdict === v).length;
  const verdicts = { passed: count('passed'), failed: count('failed'), human_check: count('human-check'), blocked: count('blocked') };
  const st = steps(d);
  const levels = prohibitionLevels(root);
  const permission = st.some(({ s }) => s.blocked_by?.reason === '禁止操作' && (/^包括原則/.test(String(s.blocked_by.prohibition ?? '')) || levels.get(s.blocked_by.prohibition) === '要許可'));
  const escalation = permission ? 'permission_required' : d.findings?.knowledge_gap?.needed ? 'knowledge_gap' : 'none';
  // DB不変条件の違反: 最新の記録のラウンドの、シナリオの終わりと全体検査
  const roundsOfLatest = new Set();
  for (const sc of d.latest) {
    const r = (q.rounds ?? []).filter((x) => (x.recheck_of ?? null) === (sc.recheck_of ?? null) && (x.reexplore_of ?? null) === (sc.reexplore_of ?? null)).at(-1);
    if (r) roundsOfLatest.add(`${r.round}\u0000${sc.id}`);
  }
  const closes = q.cards.filter((c) => c.kind === 'explore.close' && c.status === 'passed' && roundsOfLatest.has(`${c.round}\u0000${c.scenario}`));
  const session = q.cards.filter((c) => c.kind === 'explore.session_close' && c.status === 'passed' && c.round === d.round?.round);
  const violations = [...closes, ...session].flatMap((c) => c.output?.violations ?? []);
  const healthItems = d.latest.filter((sc) => (sc.steps ?? []).some((s) => s.health_signal)).map((sc) => sc.id);
  const handoffByReason = Object.fromEntries(Object.keys(proc.vocab.reason_code ?? {}).map((k) => [k, d.handoffs.filter((h) => String(h['理由コード']).trim() === k).length]));
  const registered = uniq([...(ctxv.kb_t05_registered ?? []), ...d.tracks.flatMap((t) => t.ops_registered ?? [])]);
  const used = uniq(ctx.store.actRecords(q).filter((a) => a.ok && a.operation_id && d.cards.some((c) => c.id === a.card)).map((a) => a.operation_id));
  const reused = uniq([...(ctxv.kb_t05_reused ?? []), ...used.filter((op) => !registered.includes(op))]);
  const stopped = d.cards.filter((c) => c.status === 'stopped');
  const anyBlockedOrCheck = verdicts.blocked + verdicts.human_check > 0;
  const outcome = dodUnmet || stopped.length || anyBlockedOrCheck ? 'partial_success' : 'success';

  const cu = {
    flow_kind: ctxv.flow_kind, flow_seq: ctxv.flow_seq, scenario_source: ctxv.scenario_source,
    escalation, invariant_violation: violations.length ? 'found' : 'none', health_signal: healthItems.length ? 'found' : 'none',
    nd_needed: d.findings?.nd_increment?.needed ? 'yes' : 'no',
    verdicts, handoff_by_reason: handoffByReason,
    rediscovery_rate: rediscovery(root, q.flow_id, d.latest.map((sc) => sc.id)),
    codeable_items: d.latest.filter((sc) => sc.verdict === 'passed').map((sc) => sc.id),
    health_signal_items: healthItems,
    assertion_gap_items: st.filter(({ s }) => String(s.assertion_hint ?? '').includes(NO_DETERMINISTIC)).map(({ s }) => s.step_id),
    setup_unverified: d.setups.filter((e) => e.classification !== 'blocked' && !RESTORE_STATES.has(e.state_id) && e.verified !== true).map((e) => e.state_id),
    blocked_by_prohibition: st.filter(({ s }) => s.blocked_by?.reason === '禁止操作').map(({ s }) => s.step_id),
  };
  if (d.round?.recheck_of) {
    const tagged = d.all.filter((sc) => sc.recheck_of === d.round.recheck_of);
    cu.recheck_resolved = tagged.flatMap((sc) => {
      const before = d.all.slice(0, d.all.indexOf(sc)).filter((x) => x.id === sc.id).at(-1);
      return (sc.steps ?? []).filter((s) => s.verdict !== 'blocked' && (before?.steps ?? []).some((b) => b.step_id === s.step_id && b.blocked_by?.reason === '禁止操作')).map((s) => s.step_id);
    });
  }
  Object.assign(cu, {
    kb_t05_registered: registered, kb_t05_reused: reused,
    ext_demand_added: uniq([...(ctxv.ext_demand_added ?? []), ...d.tracks.flatMap((t) => t.ext_added ?? [])]),
    ext_demand_appended: uniq([...(ctxv.ext_demand_appended ?? []), ...d.tracks.flatMap((t) => t.ext_appended ?? [])]),
    ext_demand_established: ctxv.ext_demand_established ?? [],
    ext_demand_unresolved: ctxv.ext_demand_unresolved ?? [],
    state_demand_added: ctxv.state_demand_added ?? [],
    state_demand_appended: ctxv.state_demand_appended ?? [],
    state_demand_provisioned: uniq(q.cards.filter((c) => (c.feature ?? d.fc) === d.fc && c.provisioned).map((c) => c.provisioned)),
    env_keys_added: ctxv.env_keys_added ?? [],
  });
  const signals = uniq([...(ctxv.signals_recorded ?? []), ...d.tracks.flatMap((t) => t.signals ?? [])]);
  const scenariosMd = ctx.paths.abs(ctx.paths.scenarios(d.fc));
  const nd = ctx.paths.abs(ctx.paths.ndCatalog());
  const inputs = {
    scenarios: fs.existsSync(scenariosMd) ? frontmatter(readText(scenariosMd)).review_status || 'unreviewed' : 'なし',
    'nd-catalog': fs.existsSync(nd) ? frontmatter(readText(nd)).review_status || 'unreviewed' : 'なし',
  };
  return {
    stage: '10', flow_id: q.flow_id, feature_code: d.fc, procedure_version: d.version, environment: ctxv.environment,
    outcome, review_status: 'unreviewed',
    env_restore: ctxv.env_restore, pre_stage: ctxv.pre_stage, prohibited_ops: ctxv.prohibited_ops,
    context_updates: cu,
    signals_recorded: signals,
    inputs_review_status: inputs,
    artifacts: {
      report: ctx.paths.report(d.fc), exploration_log: ctx.paths.explorationLog(d.fc), setup_log: ctx.paths.setupLog(d.fc),
      queue: ctx.paths.queue(q.flow_id),
    },
    notes: `pms report が記録から作った(${timestamp()})。${dodUnmet ? `DoD を満たせない項目がある: ${dodUnmet}` : ''}`.trim(),
    _violations: violations, _closes: closes, _session: session, _stopped: stopped,
  };
}

const AI = '(カード report.findings で書く)';

function reportText(ctx, q, d, s, { draft }) {
  const cu = s.context_updates;
  const f = draft ? null : d.findings;
  const fval = (v, none = 'なし') => (draft ? AI : v ?? none);
  const st = steps(d);
  const discByStep = new Map();
  for (const t of d.tracks) for (const x of t.disc ?? []) discByStep.set(x.step, [...(discByStep.get(x.step) ?? []), x]);
  const allDisc = d.tracks.flatMap((t) => t.disc ?? []);
  const stopA = d.cards.filter((c) => c.status === 'stopped' && phaseOf(c) === 'A');
  const stopC = d.cards.filter((c) => c.status === 'stopped' && phaseOf(c) === 'C');
  const ctxv = d.context;
  const L = [];
  L.push('---', 'review_status: unreviewed', `generated_by: pms report(作業10 / ${q.flow_id})`, `generated_at: ${timestamp()}`,
    `flow_id: ${q.flow_id}`, `feature_code: ${d.fc}`, `procedure_version: ${d.version}`, ...(draft ? ['draft: true'] : []), '---', '');
  L.push(`# 作業10 完了報告 — ${q.flow_id} / ${d.fc}${draft ? '(下書き)' : ''}`, '');
  L.push('数値と一覧は進行役 pms が記録から作った。所見の欄(要約の最も重要な1件・§3 の補足・§6・§7・固有セクション8の提案・10)だけをAIが書いた(カード report.findings)。', '');
  // 1 要約
  L.push('## 1. 要約', '');
  L.push(`- ${q.flow_id} / ${d.fc}: シナリオ ${d.latest.length} 件(passed ${cu.verdicts.passed} / failed ${cu.verdicts.failed} / human-check ${cu.verdicts.human_check} / blocked ${cu.verdicts.blocked})。outcome: ${s.outcome}`);
  L.push(`- DB不変条件の違反: ${cu.invariant_violation === 'found' ? `**あり(${s._violations.length} 件)**` : 'なし'} / 健全性シグナル: ${cu.health_signal_items.length} シナリオ / エスカレーション: ${cu.escalation}`);
  L.push(`- 人間の確認待ちのカード: ${s._stopped.length} 枚 / コード化できるシナリオ: ${cu.codeable_items.join(', ') || 'なし'}`);
  L.push(`- 最も重要な1件: ${draft ? AI : f?.headline ?? '(所見のカードが人間の確認待ちのため、AIの所見なし)'}`, '');
  // 2 サマリ
  L.push('## 2. サマリ', '');
  L.push(table(['項目', '件数'], [
    ['シナリオ', d.latest.length], ['ステップ', st.length],
    ['passed / failed / human-check / blocked(シナリオ)', `${cu.verdicts.passed} / ${cu.verdicts.failed} / ${cu.verdicts.human_check} / ${cu.verdicts.blocked}`],
    ['passed / failed / human-check / blocked(ステップ)', ['passed', 'failed', 'human-check', 'blocked'].map((v) => st.filter(({ s: x }) => x.verdict === v).length).join(' / ')],
    ['カード(合格 / skipped / 人間の確認待ち)', `${d.cards.filter((c) => c.status === 'passed').length} / ${d.cards.filter((c) => c.status === 'skipped').length} / ${s._stopped.length}`],
  ]), '');
  // 3 参照
  L.push('## 3. 参照した前段成果物・KBエントリとレビュー状況', '');
  L.push(table(['成果物', 'レビュー状況'], Object.entries(s.inputs_review_status)), '');
  L.push(`再発見率: ${cu.rediscovery_rate}(発見ログのうち、このフロー・機能の行)`, '');
  L.push(`補足: ${fval(f?.inputs_note)}`, '');
  // 4 資産流用
  L.push('## 4. 資産流用の実績', '');
  L.push(table(['状態ID', '区分', 'fixture', '流用元'], d.setups.map((e) => [e.state_id, e.classification, e.fixture ?? '', e.reused_from?.flow_id ?? e.provided_by ?? (e.classification === 'built-by-ui' ? '本フローで整備' : '')])), '');
  L.push(`- KB T05 の流用: ${cu.kb_t05_reused.join(', ') || 'なし'} / 新規登録: ${cu.kb_t05_registered.join(', ') || 'なし'}`, '');
  // 5 申し送り
  L.push('## 5. 申し送り台帳への追記', '');
  L.push(table(['理由コード', '件数'], Object.entries(cu.handoff_by_reason)), '');
  L.push(table(['ID', '理由コード', '対象'], d.handoffs.map((h) => [h.ID, h['理由コード'], h['対象']])), '');
  // 固有1
  L.push('## 固有1. 初期状態セットアップ結果と blocked の一覧', '');
  L.push(table(['状態ID', '区分', 'verified', 'fixture', '備考'], d.setups.map((e) => [e.state_id, e.classification, e.classification === 'blocked' ? '' : String(e.verified ?? ''), e.fixture ?? '',
    e.blocked_by ? `${e.blocked_by.reason}・${e.blocked_by.handoff ?? ''}${e.blocked_by.ext_demand ? `・${e.blocked_by.ext_demand}` : ''}${e.blocked_by.prohibition ? `・${e.blocked_by.prohibition}` : ''}` : e.notes ?? ''])), '');
  L.push(`- フェーズAで人間の確認待ち(STOP)になったカード: ${stopA.map((c) => `${c.id}(${c.kind} / ${targetOf(c)}: ${c.stop?.reason ?? ''})`).join('、') || 'なし'}`);
  L.push(`- 作り直した fixture: ${d.cards.filter((c) => c.rebuild && c.status === 'passed' && c.kind === 'setup.code').map((c) => `${c.state_id}(${c.rebuild.fixture ?? ''}・${c.rebuild.reason})`).join('、') || 'なし'}`);
  L.push(`- 禁止操作リスト: state=${ctxv.prohibited_ops?.state ?? '不明'} / digest=${ctxv.prohibited_ops?.digest ?? '不明'}`, '');
  const blockedRows = st.filter(({ s: x }) => x.verdict === 'blocked' && x.blocked_by?.reason !== '前ステップが blocked')
    .map(({ sc, s: x }) => [sc.id, x.step_id, x.blocked_by?.reason, [x.blocked_by?.handoff, x.blocked_by?.ext_demand, x.blocked_by?.prohibition, x.blocked_by?.ref].filter(Boolean).join('・'), x.blocked_by?.resume_from ?? '']);
  L.push(table(['シナリオID', 'ステップID', '理由', '参照', '再開するステップ'], blockedRows), '');
  const refl = s._closes.flatMap((c) => (c.output?.reflections ?? []).filter((r) => r.target !== 'none').map((r) => [c.scenario, r.operation, r.target, r.path]));
  L.push('探索で確立した操作の反映先:', '', table(['シナリオID', '操作', '反映先', 'ファイル'], refl), '');
  // 固有2
  L.push('## 固有2. DB不変条件の結果', '');
  if (s._violations.length) L.push('**違反があります(最優先)。** 人間の判断へ回す(INV_NO_RETRY)。', '', table(['INV', '内容'], s._violations.map((v) => [v.inv, v.detail])), '');
  const invKeys = Object.keys(ctx.proc.vocab.invariant ?? {});
  L.push(table(['シナリオID', ...invKeys], d.latest.map((sc) => [sc.id, ...invKeys.map((k) => sc.invariants?.[k] ?? '未記録')])), '');
  L.push(`全体検査: ${s._session.length ? Object.entries(s._session.at(-1).output?.invariants ?? {}).map(([k, v]) => `${k} ${v}`).join(' / ') : '未実施(カードが終わっていない)'}`, '');
  // 固有3
  L.push('## 固有3. 判定一覧表', '');
  L.push(table(['シナリオID', 'ステップID', '判定', '検証手段', '健全性シグナル', 'DISC', '証跡'], st.map(({ sc, s: x }) => [sc.id, x.step_id, x.verdict, x.verification ?? '',
    x.health_signal ? `${x.health_signal.kind}: ${x.health_signal.detail}` : '', (discByStep.get(x.step_id) ?? []).map((y) => y.id).join(', '), (x.evidence ?? []).join(', ')])), '');
  // 固有4
  L.push('## 固有4. 非同期待機の実測一覧', '');
  L.push(table(['ステップID', '待機条件', '実測(秒)', 'タイムアウト(秒)'], st.filter(({ s: x }) => x.wait).map(({ s: x }) => [x.step_id, x.wait.condition, x.wait.measured_seconds, x.wait.timeout_used])), '');
  // 固有5
  L.push('## 固有5. DB単独検証の一覧と理由', '');
  L.push(table(['ステップID', '検証手段(理由)'], st.filter(({ s: x }) => /^DB/.test(String(x.verification ?? ''))).map(({ s: x }) => [x.step_id, x.verification])), '');
  // 固有6
  L.push('## 固有6. 不整合(DISC)一覧とAIの見立て', '');
  L.push(table(['DISC', 'ステップ', '種別', 'AIの見立て'], allDisc.map((x) => [x.id, x.step, x.kind, x.assessment])), '');
  // 固有7
  L.push('## 固有7. KB T05 に新規登録した操作IDと、流用した操作ID', '');
  L.push(`- 新規登録: ${cu.kb_t05_registered.join(', ') || 'なし'}`, `- 流用: ${cu.kb_t05_reused.join(', ') || 'なし'}`, '');
  // 固有8
  L.push('## 固有8. 非決定値カタログへの追記候補', '');
  L.push(table(['ステップID', '値', '強度の候補'], st.flatMap(({ s: x }) => (x.nondeterministic ?? []).filter((n) => n.catalog_id === '未登録').map((n) => [x.step_id, n.value, n.strength ?? '']))), '');
  L.push(`作業02の増分実施: ${cu.nd_needed === 'yes' ? '推奨する' : '要らない'}(${fval(f?.nd_increment?.reason, '理由なし')})`, '');
  // 固有9
  L.push('## 固有9. ページオブジェクト・シナリオ部品一覧と FRAGILE 箇所', '');
  L.push(bullets(uniq([...d.setups.flatMap((e) => [e.flow, e.fixture]), ...refl.map((r) => r[3])]).map((x) => `\`${x}\``)), '');
  const fragile = [...d.setups.flatMap((e) => (e.steps ?? []).filter((x) => x.fragile).map((x) => [e.state_id, x.locator, x.fragile])),
    ...st.flatMap(({ s: x }) => (x.actions ?? []).filter((a) => a.fragile).map((a) => [x.step_id, a.locator, a.fragile]))];
  L.push('FRAGILE(CSS 暫定):', '', table(['状態・ステップ', 'ロケータ', '理由'], fragile), '');
  // 固有10
  L.push('## 固有10. 禁止操作リストへの追記提案', '');
  L.push(draft ? AI : bullets(f?.prohibition_proposals ?? []), '');
  // 固有11
  L.push('## 固有11. 外部操作需要リスト・状態需要リストへの記録', '');
  L.push(table(['区分', '需要ID'], [
    ['外部操作需要 新規追加', cu.ext_demand_added.join(', ')], ['外部操作需要 要求元の追記', cu.ext_demand_appended.join(', ')],
    ['外部操作需要 確立済にした', cu.ext_demand_established.join(', ')], ['外部操作需要 未整備に戻した', cu.ext_demand_unresolved.join(', ')],
    ['状態需要 提案', cu.state_demand_added.join(', ')], ['状態需要 要求元の追記', cu.state_demand_appended.join(', ')], ['状態需要 整備済にした', cu.state_demand_provisioned.join(', ')],
  ]), '');
  // 固有12
  if (ctxv.flow_kind === 'reexplore' || d.round?.recheck_of) {
    L.push('## 固有12. 再探索・再判定の結果', '');
    if (ctxv.flow_kind === 'reexplore') L.push(`- 確立済: ${cu.ext_demand_established.join(', ') || 'なし'} / 未確立: ${cu.ext_demand_unresolved.join(', ') || 'なし'}(理由は外部操作需要リストの不足の区分)`);
    if (d.round?.recheck_of) L.push(`- 照合: 旧版 ${d.round.recheck_of} → 新版 ${ctxv.prohibited_ops?.digest ?? '不明'}`, `- 実行できるようになったステップ: ${(cu.recheck_resolved ?? []).join(', ') || 'なし'}`, `- まだ blocked(禁止操作): ${cu.blocked_by_prohibition.join(', ') || 'なし'}`);
    L.push(table(['シナリオID', '判定'], d.latest.filter((sc) => sc.recheck_of || sc.reexplore_of).map((sc) => [sc.id, sc.verdict])), '');
  }
  // 6・7・8
  L.push('## 6. 未確認・要確認事項 / 前段成果物への疑義', '');
  const q6 = [...(draft ? [AI] : f?.open_questions ?? []),
    ...stopC.filter((c) => !c.stop?.chained_from).map((c) => `カード ${c.id}(${c.kind} / ${targetOf(c)})が人間の確認待ち: ${c.stop?.reason ?? ''}`),
    ...(s.notes.includes('DoD を満たせない') ? [s.notes.replace(/^.*?DoD/, 'DoD')] : [])];
  L.push(bullets(q6), '');
  L.push('## 7. 優先レビュー推奨リスト', '');
  L.push(draft ? AI : table(['対象', '理由'], (f?.priority_review ?? []).map((p) => [p.item, p.reason])), '');
  L.push('## 8. 手順改善シグナル・残留データ・環境への影響', '');
  L.push(`- 手順改善シグナル: ${s.signals_recorded.join(', ') || 'なし'}`, `- 検証環境: ${s.environment ?? '不明'} / 新たに保存した環境情報のキー: ${cu.env_keys_added.join(', ') || 'なし'}`,
    `- 残留データ: 工程0の復元(${ctxv.env_restore?.restore_id ?? '不明'})以降に作ったデータは、次の工程0の復元で戻る`, '');
  return L.join('\n');
}

function publicStatus(s) {
  const { _violations, _closes, _session, _stopped, ...rest } = s;
  void _violations; void _closes; void _session; void _stopped;
  return rest;
}

function featuresOf(q) {
  return uniq([...(q.rounds ?? []).flatMap((r) => r.scenarios.map((id) => q.scenarios.find((x) => x.id === id)?.feature)), ...q.features]);
}

/** 所見のカード(report.findings)に載せる下書き(所見の欄は空のまま)。ファイルにも書く */
export function draftReports(ctx, flow) {
  const q = ctx.store.loadQueue(flow);
  return featuresOf(q).map((fc) => {
    const d = collect(ctx, q, fc);
    const s = statusOf(ctx, q, d, { dodUnmet: null });
    const text = reportText(ctx, q, d, s, { draft: true });
    const file = ctx.paths.draft(flow, fc);
    writeText(ctx.paths.abs(file), text + '\n');
    return { feature: fc, file, text };
  });
}

/**
 * pms report。パートCのカードがすべて終わってから、機能ごとに report.md と status.yaml を書く。
 * @returns {{code: number, out: object}}
 */
export function buildReport(ctx, flow, { dodUnmet = null } = {}) {
  const q = ctx.store.loadQueue(flow);
  const cs = q.cards.filter((c) => phaseOf(c) === 'C');
  if (!cs.length) throw new UsageError(`${flow} のキューにパートCのカードがありません(queue build --phase C か all で作る)`);
  const open = q.cards.filter((c) => !isDone(c));
  if (open.length) throw new UsageError(`カードが終わっていません(${open.map((c) => c.id).join(', ')})。${PMS} run --flow ${flow} か ${PMS} next --flow ${flow} で続ける`);
  const wrote = [];
  const summary = [];
  for (const fc of featuresOf(q)) {
    const d = collect(ctx, q, fc);
    if (!d.latest.length) continue;
    const s = statusOf(ctx, q, d, { dodUnmet });
    writeText(ctx.paths.abs(ctx.paths.report(fc)), reportText(ctx, q, d, s, { draft: false }) + '\n');
    writeText(ctx.paths.abs(ctx.paths.status(fc)), emitDoc(publicStatus(s)));
    wrote.push(ctx.paths.report(fc), ctx.paths.status(fc));
    summary.push({ feature: fc, outcome: s.outcome, verdicts: s.context_updates.verdicts, escalation: s.context_updates.escalation, invariant_violation: s.context_updates.invariant_violation, health_signal: s.context_updates.health_signal });
  }
  q.history.push({ at: timestamp(), event: 'report', wrote });
  ctx.store.saveQueue(q);
  return {
    code: 0,
    out: { ok: true, flow, wrote, summary, next: `node tools/lint/lint.mjs --flow ${flow} --stage 10 --skip skills_in_sync` },
  };
}
