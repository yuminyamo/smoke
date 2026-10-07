// explore.mjs — 作業10パートCのカード(explore.step / explore.close / explore.session_close / report.findings)
//
// キューの作り方(どの単位でカードにするか)・出す前の処理・カードの入力・提出の検査・合格時の記録を受け持つ。
// 分担(stages.md §10 パートC): AIは操作(pms act)と判定・所見だけを行い、探索記録(exploration-log)・DISC・
// 申し送り・外部操作需要・手順改善シグナルの行は pms が書く。

import fs from 'node:fs';
import path from 'node:path';
import { timestamp, today, blank, readText, TIMESTAMP_RE } from './util.mjs';
import { skipCard, stopCard, chainStop, kbPages, list, mdTable, isDone } from './queue.mjs';
import { scenarioDefs } from './scenarios.mjs';
import { readEntries } from './setup-log.mjs';
import { upsertScenario, readScenarios, scenarioVerdict, orderStep, sameTag } from './exploration-log.mjs';
import {
  appendHandoff, peekHandoffId, recordExtDemand, appendSignal, appendDiscrepancy, prohibitionLevels, ledgerIds, handoffsOfFlow,
} from './ledgers.mjs';
import { leakedSecrets, TEMP_REF } from './checks.mjs';
import { secretsToMask } from './store.mjs';
import { stepOf, establishedCheckOf } from './submit.mjs';
import { draftReports } from './report.mjs';
import { no_temp_locator } from '../../lint/rules/exploration.mjs';

export const EXPLORE_TODO = {
  'explore.step': (c) => `ステップ ${c.step_id} を pms act で探索し、期待結果を満たすかを判定して提出する`,
  'explore.close': (c) => `シナリオ ${c.scenario} の DB不変条件を検査し、確立した操作の反映先を決めて提出する`,
  'explore.session_close': () => '探索セッションの終わりに DB不変条件の全体検査を1回行って提出する',
  'report.findings': () => '報告書の下書きを読み、所見の欄だけを書いて提出する',
};

const FOLLOWS_BLOCKED = '前ステップが blocked';
// 決定的な検証手段がないときの assertion_hint の書き方(付録A 補足ルール)。status.yaml の assertion_gap_items はこの文言で拾う
export const NO_DETERMINISTIC = '決定的な検証手段が見つからない';
// 期待結果・判定基準を書き換えたと述べる文(EXPECTED_IMMUTABLE)
const EXPECTED_CHANGE_RE = /(期待結果|判定基準)(を|は|の)?.{0,12}(変更し|変えた|変更した|修正し|書き換え|訂正し|置き換え|読み替え)/;

// ════════════════════════════════════════════════════════
// キューの作り方
// ════════════════════════════════════════════════════════

/**
 * パートCのカードを1ラウンド分作る: シナリオごとにステップの数の explore.step と explore.close、
 * 最後に explore.session_close と report.findings。
 */
export function exploreCards(ctx, q, scenarios, context) {
  const { store } = ctx;
  const round = (q.rounds.at(-1)?.round ?? 0) + 1;
  const tag = { recheck_of: context.recheck_of ?? null, reexplore_of: context.reexplore_of ?? null };
  q.rounds.push({ round, created_at: timestamp(), scenarios: scenarios.map((s) => s.id), context, ...tag });
  const added = [];
  const add = (card) => {
    const c = { id: store.nextCardId(q), phase: 'C', round, status: 'pending', issued_count: 0, rejections: 0, created_at: timestamp(), ...card };
    q.cards.push(c);
    added.push(c);
  };
  for (const sc of scenarios) {
    if (sc.steps.length === 0) q.warnings.push(`${sc.id} にステップの表(Step ID の列)がないため、探索のカードを作れない(付録C)`);
    for (const row of sc.steps) add({ kind: 'explore.step', feature: sc.feature, scenario: sc.id, step_id: row.id, digest: row.digest });
    add({ kind: 'explore.close', feature: sc.feature, scenario: sc.id });
  }
  add({ kind: 'explore.session_close', feature: scenarios[0]?.feature ?? null });
  add({ kind: 'report.findings', feature: null });
  return added;
}

export function roundOf(q, c) { return (q.rounds ?? []).find((r) => r.round === c.round) ?? null; }
function tagOf(r) { return { recheck_of: r?.recheck_of ?? null, reexplore_of: r?.reexplore_of ?? null }; }
function defOf(ctx, id) { return scenarioDefs(ctx.root).find((d) => d.id === id) ?? null; }
function stepCards(q, round, scenario) {
  return q.cards.filter((x) => x.kind === 'explore.step' && x.round === round && x.scenario === scenario);
}

/** フローの setup-log のエントリ(キューの全機能) */
function flowSetups(ctx, q) {
  const out = new Map();
  for (const fc of q.features ?? []) {
    const rel = ctx.paths.setupLog(fc);
    for (const e of readEntries(ctx.paths.abs(rel), rel, q.flow_id)) out.set(e.state_id, e);
  }
  return out;
}

/** requires_setup(付録A)の文: 状態ごとに setup-log の記録から1行 */
export function requiresSetup(ctx, q, scenarioId) {
  const def = defOf(ctx, scenarioId);
  const setups = flowSetups(ctx, q);
  const lines = (def?.requires ?? []).map((st) => {
    const e = setups.get(st);
    if (!e) return `${st}: 整備の記録がない(フェーズAのカードが人間の確認待ち)`;
    if (e.classification === 'blocked') return `${st}: 整備できなかった(${e.blocked_by?.reason ?? ''}・${e.blocked_by?.handoff ?? ''})`;
    if (e.provided_by) return `${st}: ${e.provided_by}で成立を確認`;
    const how = e.classification === 'provided' ? `既存流用(${e.reused_from?.flow_id ?? ''})` : '本フローで整備';
    return `${st}: ${e.fixture || '(fixture なし)'}(${how})で成立を${e.verified === true ? '確認' : '確認できなかった(verified: false)'}`;
  });
  return lines.length ? lines.join('\n') + '\n' : 'なし\n';
}

// ════════════════════════════════════════════════════════
// 出す前の処理(pms next から呼ぶ)
// ════════════════════════════════════════════════════════

/** @returns {'issue'|'skipped'|'stopped'} */
export function prepareExplore(ctx, q, c) {
  if (c.kind !== 'explore.step') return 'issue';
  const sib = stepCards(q, c.round, c.scenario);
  if (sib[0]?.id !== c.id) return 'issue';
  // シナリオの最初のステップ: 前提状態の記録を確かめる
  const def = defOf(ctx, c.scenario);
  const setups = flowSetups(ctx, q);
  const missing = (def?.requires ?? []).filter((st) => !setups.has(st));
  if (missing.length) {
    stopCard(q, c, `シナリオ ${c.scenario} の前提状態 ${missing.join(', ')} が整備されていない(フェーズAのカードが人間の確認待ち。setup-log に記録がない)`, 'setup_unready');
    chainStop(q, c);
    return 'stopped';
  }
  const blocked = (def?.requires ?? []).map((st) => setups.get(st)).find((e) => e.classification === 'blocked');
  if (blocked) {
    autoBlockScenario(ctx, q, c.round, c.scenario, blocked);
    return 'skipped';
  }
  return 'issue';
}

/** 前提状態が blocked のシナリオ: 全ステップを blocked と記録し、終わりの処理もカードにしない */
function autoBlockScenario(ctx, q, round, scenario, entry) {
  const cards = stepCards(q, round, scenario);
  const first = cards[0];
  const b = entry.blocked_by ?? {};
  const steps = cards.map((x, i) => (i === 0
    ? orderStep({
      step_id: x.step_id, verdict: 'blocked',
      blocked_by: { reason: b.reason, handoff: b.handoff, ext_demand: b.ext_demand, prohibition: b.prohibition, ref: b.ref, resume_from: first.step_id },
      notes: `前提状態 ${entry.state_id} を整備できなかった(setup-log の blocked。pms が記録した)`,
    })
    : { step_id: x.step_id, verdict: 'blocked', blocked_by: { reason: FOLLOWS_BLOCKED } }));
  const inv = Object.fromEntries(Object.keys(ctx.proc.vocab.invariant ?? {}).map((k) => [k, '未実施(前提状態が blocked でシナリオを実行していない)']));
  writeScenario(ctx, q, { round, scenario, feature: first.feature }, (sc) => {
    sc.steps = steps;
    sc.invariants = inv;
    return sc;
  });
  for (const x of cards) skipCard(q, x, `前提状態 ${entry.state_id} が blocked`);
  const close = q.cards.find((x) => x.kind === 'explore.close' && x.round === round && x.scenario === scenario);
  if (close) skipCard(q, close, `前提状態 ${entry.state_id} が blocked(シナリオを実行していないため、終わりの処理はない)`);
}

/** シナリオの記録を書き直す(判定はステップから決め直す) */
function writeScenario(ctx, q, { round, scenario, feature }, mutate) {
  const r = (q.rounds ?? []).find((x) => x.round === round);
  const rel = ctx.paths.explorationLog(feature);
  const def = defOf(ctx, scenario);
  const order = (def?.steps ?? []).map((s) => s.id);
  upsertScenario(ctx.paths.abs(rel), rel, { feature, flow: q.flow_id, environment: r?.context?.environment, date: today() },
    { id: scenario, ...tagOf(r) }, (cur) => {
      const sc = cur ?? { id: scenario, ...Object.fromEntries(Object.entries(tagOf(r)).filter(([, v]) => v)), requires_setup: requiresSetup(ctx, q, scenario), carried_data: {}, steps: [] };
      const out = mutate(sc);
      out.steps = [...(out.steps ?? [])].sort((a, b) => order.indexOf(a.step_id) - order.indexOf(b.step_id));
      out.verdict = scenarioVerdict(out.steps);
      return out;
    });
  return rel;
}

/** シナリオの記録(このラウンドのもの) */
function scenarioRecord(ctx, q, round, scenario, feature) {
  const r = (q.rounds ?? []).find((x) => x.round === round);
  const rel = ctx.paths.explorationLog(feature);
  return readScenarios(ctx.paths.abs(rel), rel, q.flow_id).find((sc) => sc.id === scenario && sameTag(sc, tagOf(r))) ?? null;
}

// ════════════════════════════════════════════════════════
// カードの入力
// ════════════════════════════════════════════════════════

function actionText(a) {
  const target = a.locator ?? a.detail ?? a.operation_id ?? '';
  return `${a.action} ${target}${a.value != null ? ` ← ${a.value}` : ''}`.trim();
}

export function exploreVars(ctx, q, c, acts) {
  const { root, paths, proc } = ctx;
  const v = { round: String(c.round ?? ''), evidence_dir: c.feature ? paths.evidenceDir(c.feature) : '' };
  if (c.kind === 'explore.step') {
    const def = defOf(ctx, c.scenario);
    const row = def?.steps.find((s) => s.id === c.step_id) ?? {};
    const idx = (def?.steps ?? []).findIndex((s) => s.id === c.step_id);
    const sc = scenarioRecord(ctx, q, c.round, c.scenario, c.feature);
    const prev = (sc?.steps ?? []).filter((s) => (def?.steps ?? []).findIndex((x) => x.id === s.step_id) < idx);
    const setups = flowSetups(ctx, q);
    const ops = [...new Set(`${row.check ?? ''} ${def?.fields?.['使用する外部操作'] ?? ''}`.match(/OP-[A-Z0-9]+-\d{3}/g) ?? [])];
    const refs = handoffsOfFlow(root, q.flow_id).filter((h) => `${h['対象']} ${h['発生元']}`.includes(c.step_id) || `${h['対象']} ${h['発生元']}`.includes(c.scenario));
    Object.assign(v, {
      scenario_id: c.scenario, step_id: c.step_id,
      purpose: def?.fields?.['目的'] || '(記載なし)',
      pass_condition: def?.fields?.['合格条件'] || '(記載なし)',
      carried_fields: def?.fields?.['持ち回るデータ'] || 'なし',
      used_ops: def?.fields?.['使用する外部操作'] || 'なし',
      position: `${idx + 1} / ${def?.steps.length ?? '?'}`,
      step_row: mdTable({ 'Step ID': c.step_id, 項目名: row.name, 確認内容: row.check, 期待結果: row.expected, 検証手段: row.method, 根拠: row.basis }),
      expected_method: row.method || '(記載なし)',
      previous: prev.length
        ? prev.map((s) => `- ${s.step_id}: ${s.verdict}。操作: ${(s.actions ?? []).map(actionText).join(' → ') || 'なし'}${s.observed ? `。観測: ${s.observed}` : ''}`).join('\n')
        : 'なし(このシナリオの最初のステップ)',
      carried_data: sc && Object.keys(sc.carried_data ?? {}).length ? '```json\n' + JSON.stringify(sc.carried_data, null, 2) + '\n```' : 'まだない',
      setup: idx === 0
        ? (def?.requires ?? []).map((st) => {
          const e = setups.get(st) ?? {};
          const steps = (e.steps ?? []).map((s) => `  - ${actionText(s)}`).join('\n');
          return `- ${st}(${e.classification ?? '記録なし'}${e.fixture ? `・fixture \`${e.fixture}\`` : ''}${e.provided_by ? `・${e.provided_by}` : ''})。成立の確認: ${String(e.established_check ?? '').trim() || 'なし'}${steps ? `\n${steps}` : ''}`;
        }).join('\n') || 'なし'
        : '前のステップのあとの画面から続ける(画面がずれていたら snapshot で確かめる)',
      kb_pages: list(kbPages(root, c.scenario, c.step_id, ...ops)),
      ledger_refs: refs.length ? refs.map((h) => `- ${h.ID}(${h['理由コード']}): ${h['対象']}${h['想定手段'] ? ` / 想定手段 ${h['想定手段']}` : ''}`).join('\n') : 'なし',
      nd_catalog: fs.existsSync(paths.abs(paths.ndCatalog())) ? `\`${paths.ndCatalog()}\`` : 'なし(ファイルがない。値はすべて 未登録 として追加候補にする)',
    });
  } else if (c.kind === 'explore.close') {
    const def = defOf(ctx, c.scenario);
    const sc = scenarioRecord(ctx, q, c.round, c.scenario, c.feature);
    const ls = (d) => (fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)).filter((f) => /\.(ts|js)$/.test(f)).map((f) => `${d}/${f}`) : []);
    Object.assign(v, {
      scenario_id: c.scenario,
      purpose: def?.fields?.['目的'] || '(記載なし)',
      steps_summary: (sc?.steps ?? []).map((s) => `- ${s.step_id}: ${s.verdict}。操作: ${(s.actions ?? []).map(actionText).join(' → ') || 'なし'}`).join('\n') || 'なし',
      carried_data: sc && Object.keys(sc.carried_data ?? {}).length ? '```json\n' + JSON.stringify(sc.carried_data, null, 2) + '\n```' : 'なし(データを作っていない)',
      existing_code: list([...ls('tests/flows'), ...ls('tests/fixtures'), ...ls('tests/pages')]),
      invariant_note: proc.vocab.invariant_note ?? '',
    });
  } else if (c.kind === 'explore.session_close') {
    const r = roundOf(q, c);
    const rows = [];
    for (const x of q.cards.filter((y) => y.kind === 'explore.close' && y.round === c.round)) {
      const inv = x.output?.invariants;
      rows.push(`- ${x.scenario}: ${x.status === 'passed' ? Object.entries(inv ?? {}).map(([k, val]) => `${k} ${val}`).join(' / ') : x.status}`);
    }
    Object.assign(v, { scenarios: (r?.scenarios ?? []).join(', '), scenario_invariants: rows.join('\n') || 'なし', invariant_note: proc.vocab.invariant_note ?? '' });
  } else if (c.kind === 'report.findings') {
    const drafts = draftReports(ctx, q.flow_id);
    Object.assign(v, {
      drafts: drafts.map((d) => `- \`${d.file}\`(${d.feature})`).join('\n'),
      draft_body: drafts.map((d) => d.text).join('\n\n---\n\n'),
    });
  }
  return v;
}

// ════════════════════════════════════════════════════════
// 提出の検査と記録
// ════════════════════════════════════════════════════════

function stepActionMap(proc) {
  const out = new Map();
  for (const [k, v] of Object.entries(proc.vocab.pms_act_action ?? {})) if (v && typeof v === 'object' && v.step) out.set(k, v.step);
  return out;
}

function strings(obj, at = '$') {
  if (typeof obj === 'string') return [{ path: at, value: obj }];
  if (Array.isArray(obj)) return obj.flatMap((x, i) => strings(x, `${at}[${i}]`));
  if (obj && typeof obj === 'object') return Object.entries(obj).flatMap(([k, x]) => strings(x, `${at}.${k}`));
  return [];
}

/** ロケータの安定・一意の検査(setup.build と同じ基準) */
function checkLocators(ctx, recs, fragile, fail) {
  const { paths } = ctx;
  const testid = fs.existsSync(paths.abs(paths.testidRequests())) ? readText(paths.abs(paths.testidRequests())) : '';
  for (const r of recs) {
    if (!r.locator) continue;
    if (r.locator_class === 'css') {
      const fr = fragile.find((f) => f.seq === r.seq);
      const inner = r.locator.match(/locator\((['"`])(.*?)\1/)?.[2];
      if (!fr) fail('unstable_locator', `連番 ${r.seq} のロケータ ${r.locator} は安定でない(CSS・構造)のに、fragile に挙がっていません`);
      else if (!testid.includes(r.locator) && !(inner && testid.includes(inner))) fail('unstable_locator', `連番 ${r.seq} の暫定セレクタが ${paths.testidRequests()} にありません`);
    }
    if (r.unique !== true) fail('unstable_locator', `連番 ${r.seq} のロケータ ${r.locator} は一意に1要素へ解決されません`);
  }
}

/** 連番がこのカードの記録で、条件を満たすか */
function mineOf(bySeq, c, seq, what, fail, cond) {
  const r = bySeq.get(seq);
  if (!r) { fail('seq_missing', `${what} の連番 ${seq} の操作の記録がありません(pms act を通さない操作は記録に残らない)`); return null; }
  if (r.card !== c.id) { fail('seq_missing', `${what} の連番 ${seq} は別のカード ${r.card} の操作です`); return null; }
  if (!r.ok) { fail('seq_missing', `${what} の連番 ${seq} は失敗した操作です(${r.error ?? ''})`); return null; }
  const msg = cond(r);
  if (msg) { fail('seq_missing', `${what} の連番 ${seq} は ${msg}`); return null; }
  return r;
}

function invariantChecks(ctx, out, fail) {
  const keys = Object.keys(ctx.proc.vocab.invariant ?? {});
  const got = Object.keys(out.invariants ?? {});
  const miss = keys.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !keys.includes(k));
  if (miss.length) fail('schema', `invariants に ${miss.join(', ')} がありません(vocab.invariant の全キーを書く)`);
  if (extra.length) fail('schema', `invariants の ${extra.join(', ')} は vocab.invariant にありません`);
  for (const [k, v] of Object.entries(out.invariants ?? {})) {
    if (!/^(pass|fail|未実施(.+))$/u.test(String(v))) fail('schema', `invariants.${k} の値「${v}」は pass / fail / 未実施(理由) のいずれか`);
  }
  const fails = Object.entries(out.invariants ?? {}).filter(([, v]) => v === 'fail').map(([k]) => k);
  const viol = (out.violations ?? []).map((x) => x.inv);
  for (const k of fails) if (!viol.includes(k)) fail('red_flag', `invariants.${k} が fail なのに、violations にその内容がありません`);
  for (const k of viol) if (!fails.includes(k)) fail('red_flag', `violations の ${k} が invariants では fail になっていません`);
}

function signalOrigin(q, target) { return `${q.flow_id} / 10 / ${target}`; }

/** 申し送り・手順改善シグナルを書く(全種類のカードに共通) */
function writeNotes(ctx, q, c, out, target, track) {
  const { root, proc } = ctx;
  for (const h of out.handoffs ?? []) {
    const id = appendHandoff(root, {
      feature: c.feature ?? q.features[0], target: h.target, reason: h.reason, dest: proc.vocab.reason_code?.[h.reason]?.default_dest ?? '',
      means: h.means ?? '', origin: `${q.flow_id} / 作業10 / ${target}`, date: today(),
    });
    track.handoffs.push(id);
  }
  for (const s of out.procedure_signals ?? []) {
    track.signals.push(appendSignal(root, {
      origin: signalOrigin(q, target), location: s.location, type: s.type, event: s.event, impact: s.impact, response: s.response,
      proposal: s.proposal ?? '', version: proc.version, date: today(),
    }));
  }
}

function newTrack() { return { handoffs: [], signals: [], discrepancies: [], ext_added: [], ext_appended: [], ops_registered: [] }; }

// ── explore.step ─────────────────────────────────────
export function checkStep(ctx, q, c, out, fail, failures) {
  const { root, paths, store, proc } = ctx;
  if (out.result === 'cannot_proceed') return () => { stopCard(q, c, `cannot_proceed: ${out.notes}`, 'cannot_proceed'); chainStop(q, c); return []; };
  const def = defOf(ctx, c.scenario);
  const row = def?.steps.find((s) => s.id === c.step_id);
  // expected_changed(期待結果・判定基準を書き換えない。EXPECTED_IMMUTABLE)
  if (!row) fail('expected_changed', `scenarios.md にステップ ${c.step_id} の行がありません(行を消した・IDを変えた。期待結果・判定基準は変えない)`);
  else if (c.digest && row.digest !== c.digest) fail('expected_changed', `scenarios.md の ${c.step_id} の確認内容・期待結果が、キューを作ったときから変わっています(期待結果・判定基準は変えない。おかしいと思ったら human-check にする)`);
  for (const s of strings(out)) if (EXPECTED_CHANGE_RE.test(s.value)) fail('expected_changed', `${s.path} が期待結果・判定基準を変えたと述べています: 「${s.value.slice(0, 80)}」(変えてよいのは検証手段だけ。おかしいと思ったら human-check にして理由を書く)`);

  const acts = store.actRecords(q);
  const bySeq = new Map(acts.map((a) => [a.seq, a]));
  const mine = acts.filter((a) => a.card === c.id);
  const map = stepActionMap(proc);
  const blocked = out.verdict === 'blocked';
  // seqs(状態を変える操作)
  let prev = 0;
  const recs = [];
  for (const s of out.seqs) {
    const r = mineOf(bySeq, c, s, 'seqs', fail, (x) => (!map.has(x.action) ? `${x.action} です(snapshot・assert・screenshot は seqs に入れない)` : null));
    if (s <= prev) fail('seq_missing', `seqs が増える順になっていません(${prev} のあとに ${s})`);
    prev = Math.max(prev, s);
    if (r) recs.push(r);
  }
  for (const f of out.fragile ?? []) if (!out.seqs.includes(f.seq)) fail('seq_missing', `fragile の連番 ${f.seq} が seqs にありません`);
  // 検証(画面の assert・DB の SELECT)
  const vr = out.verification;
  const asserts = [];
  if (!blocked) {
    for (const s of vr.screen_seqs) {
      const r = mineOf(bySeq, c, s, 'verification.screen_seqs', fail, (x) => (x.action !== 'assert' ? `assert ではありません(${x.action})` : null));
      if (r) asserts.push(r);
    }
    const m = vr.method;
    if ((m === '画面' || m === '両方') && vr.screen_seqs.length === 0) fail('red_flag', `検証手段が ${m} なのに、画面の確認(pms act assert の連番 verification.screen_seqs)がありません`);
    if ((m === 'DB' || m === '両方') && !vr.db) fail('red_flag', `検証手段が ${m} なのに、DB の確認(verification.db の SELECT と結果)がありません`);
    if (vr.db && !/^\s*(--[^\n]*\n\s*)*(SELECT|WITH)\b/i.test(vr.db.query)) fail('lint', 'verification.db.query が SELECT ではありません(DB への操作は SELECT のみ。00 ■DB操作の安全規約・lint select_only)');
    else if (vr.db && /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|EXEC|CREATE)\b/i.test(vr.db.query)) fail('lint', 'verification.db.query に SELECT 以外の文があります(lint select_only)');
    if (m === 'DB' && blank(vr.reason)) fail('red_flag', '検証手段が DB 単独なのに、理由(verification.reason)がありません(00 ■判定と検証手段)');
    if (row && row.method && row.method !== m && !(row.method === '画面' && m === '両方') && blank(vr.reason)) fail('red_flag', `検証手段を ${row.method} から ${m} に変えたのに、理由(verification.reason)がありません`);
    if (blank(out.assertion_hint)) fail('red_flag', `assertion_hint がありません(決定的な手段がなければ「${NO_DETERMINISTIC}」と書く)`);
  }
  checkLocators(ctx, [...recs, ...asserts], out.fragile ?? [], fail);
  // 証跡
  const shots = [];
  for (const s of out.evidence) {
    const r = mineOf(bySeq, c, s, 'evidence', fail, (x) => (x.action !== 'screenshot' ? `screenshot ではありません(${x.action})` : null));
    if (r) shots.push(r);
  }
  for (const d of out.discrepancies) {
    if (d.evidence_seq != null) mineOf(bySeq, c, d.evidence_seq, 'discrepancies[].evidence_seq', fail, (x) => (x.action !== 'screenshot' ? `screenshot ではありません(${x.action})` : null));
  }
  if ((out.verdict === 'failed' || out.verdict === 'human-check') && out.evidence.length === 0) fail('verdict_evidence', `判定が ${out.verdict} なのに、証跡(pms act screenshot の連番 evidence)がありません`);
  // 健全性シグナル
  const times = mine.map((a) => [a.started_at, a.ended_at]).flat().filter((t) => TIMESTAMP_RE.test(String(t))).map((t) => new Date(t).getTime());
  if (out.health_signal) {
    if (out.verdict === 'passed') fail('red_flag', '健全性シグナルがあるのに判定が passed です(human-check にする。00 ■健全性シグナルと問い合わせ)');
    const at = new Date(out.health_signal.observed_at).getTime();
    if (!TIMESTAMP_RE.test(out.health_signal.observed_at) || Number.isNaN(at)) fail('health_time', `health_signal.observed_at(${out.health_signal.observed_at})が vocab.timestamp_format に合いません`);
    else if (!times.length) fail('health_time', 'このカードの操作の記録がないため、health_signal.observed_at を確かめられません(観測した操作を pms act で行う)');
    else if (at < Math.min(...times) || at > Math.max(...times)) fail('health_time', `health_signal.observed_at(${out.health_signal.observed_at})が、このカードの操作の時刻の範囲(${new Date(Math.min(...times)).toISOString()}〜${new Date(Math.max(...times)).toISOString()})に入りません`);
  }
  // 非決定値
  const nd = fs.existsSync(paths.abs(paths.ndCatalog())) ? readText(paths.abs(paths.ndCatalog())) : '';
  for (const n of out.nondeterministic) {
    if (n.catalog_id !== '未登録' && !nd.includes(n.catalog_id)) fail('red_flag', `nondeterministic の ${n.catalog_id} が非決定値カタログにありません(未登録なら 未登録 と書く。推測で強度を決めない)`);
  }
  // blocked の参照
  const b = out.blocked_by;
  if (b) {
    const reasons = Object.keys(proc.vocab.reason_code ?? {});
    if (!reasons.includes(b.reason)) fail('blocked_refs', `blocked_by.reason「${b.reason}」が vocab.reason_code にありません(${reasons.join(' / ')})`);
    if (b.reason === '禁止操作') {
      if (!/^(PROH-\d{3}|包括原則[1-4])$/.test(String(b.ref ?? ''))) fail('blocked_refs', 'blocked_by.reason が 禁止操作 なのに、ref に禁止ID(PROH-<3桁>)か包括原則の番号(包括原則1〜4)がありません');
      else if (/^PROH-/.test(b.ref) && !prohibitionLevels(root).has(b.ref)) fail('blocked_refs', `禁止ID ${b.ref} が禁止操作リスト(work/_common/prohibited-operations.md の禁止操作表)にありません`);
    }
    if (b.reason === '操作手段なし') {
      if (b.ext_demand == null) fail('blocked_refs', 'blocked_by.reason が 操作手段なし なのに、ext_demand(既存の需要ID か、外部操作需要リストに書く項目)がありません');
      else if (typeof b.ext_demand === 'string' && !ledgerIds(root, 'extDemand').has(b.ext_demand)) fail('blocked_refs', `需要ID ${b.ext_demand} が外部操作需要リストにありません`);
    }
    if (b.handoff && !ledgerIds(root, 'handoff').has(b.handoff)) fail('blocked_refs', `申し送りID ${b.handoff} が申し送り台帳にありません`);
    const order = (def?.steps ?? []).map((s) => s.id);
    if (!order.includes(b.resume_from) || order.indexOf(b.resume_from) < order.indexOf(c.step_id)) fail('blocked_refs', `blocked_by.resume_from(${b.resume_from})は、このステップ ${c.step_id} か、それより後のステップでなければなりません`);
  }
  // KB T05 に登録した操作
  for (const op of out.ops_registered) {
    if (!kbPages(root, op).some((p) => p.startsWith('kb/external-ops/'))) fail('red_flag', `ops_registered の ${op} が KB T05(kb/external-ops/)にありません(登録してからステップに使う)`);
  }

  // 書く予定の記録と lint
  const step = buildStep(ctx, c, out, recs, asserts, shots, mine);
  if (failures.length === 0) {
    const repo = {
      flow: q.flow_id, stage: '10', inFlow: (f) => f === q.flow_id,
      explorationRecords: [{ feature: c.feature, dirFeature: c.feature, file: paths.explorationLog(c.feature), flow: q.flow_id, id: c.scenario, sc: { id: c.scenario, steps: [step] } }],
      setupEntries: [],
    };
    for (const f of no_temp_locator(repo).findings) fail('lint', f.message);
  }
  const leaked = leakedSecrets(JSON.stringify({ step, out }), secretsToMask(root));
  if (leaked.length) fail('lint', `書く予定の内容に秘密情報の値があります(env_value_leak。キー ${leaked.join(', ')})`);

  return () => writeStep(ctx, q, c, out, step);
}

function buildStep(ctx, c, out, recs, asserts, shots, mine) {
  const map = stepActionMap(ctx.proc);
  const actions = recs.map((r) => {
    const s = stepOf(r, map);
    const fr = (out.fragile ?? []).find((f) => f.seq === r.seq);
    if (fr) s.fragile = fr.reason;
    return s;
  });
  const vr = out.verification;
  const step = { step_id: c.step_id, verdict: out.verdict };
  if (mine.length) {
    const st = mine.map((a) => a.started_at).filter(Boolean).sort();
    const en = mine.map((a) => a.ended_at).filter(Boolean).sort();
    step.started_at = st[0];
    step.ended_at = en[en.length - 1];
  } else if (out.verdict !== 'blocked') {
    step.started_at = c.issued_at;
    step.ended_at = timestamp();
  }
  step.actions = actions;
  if (out.verdict !== 'blocked') {
    step.verification = vr.method === 'DB' ? `DB(理由: ${vr.reason})` : vr.method;
    const vb = {};
    if (asserts.length) vb.screen = asserts.map((a) => establishedCheckOf(a)).join(' / ');
    if (vr.db) vb.db = `${vr.db.query.trim()} → ${vr.db.result}`;
    step.verified_by = vb;
    if (vr.reason && vr.method !== 'DB') step.verification_note = vr.reason;
    step.assertion_hint = out.assertion_hint.endsWith('\n') ? out.assertion_hint : `${out.assertion_hint}\n`;
  }
  if (out.nondeterministic.length) step.nondeterministic = out.nondeterministic.map((n) => ({ value: n.value, catalog_id: n.catalog_id, ...(n.strength ? { strength: n.strength } : {}) }));
  if (out.wait) step.wait = out.wait;
  if (out.health_signal) step.health_signal = out.health_signal;
  if (out.observed) step.observed = out.observed;
  if (shots.length) step.evidence = shots.map((s) => s.evidence);
  if (out.notes) step.notes = out.notes;
  step.act = { card: c.id, seqs: out.seqs, screen_seqs: vr?.screen_seqs ?? [], evidence_seqs: out.evidence };
  return step;
}

function writeStep(ctx, q, c, out, step) {
  const { root, paths, store, proc } = ctx;
  const track = newTrack();
  const wrote = [];
  const acts = store.actRecords(q);
  const bySeq = new Map(acts.map((a) => [a.seq, a]));
  for (const d of out.discrepancies) {
    track.disc ??= [];
    const id = appendDiscrepancy(root, {
      feature: c.feature, kind: d.kind, related: c.step_id, spec: d.spec, manual: d.manual, existing: d.existing_test,
      actual: d.actual, evidence: d.evidence_seq != null ? `${bySeq.get(d.evidence_seq)?.evidence ?? ''}` : '', assessment: d.assessment, notes: d.notes,
    });
    track.discrepancies.push(id);
    track.disc.push({ id, step: c.step_id, kind: d.kind, assessment: d.assessment });
  }
  if (out.blocked_by) {
    const b = out.blocked_by;
    let ext = typeof b.ext_demand === 'string' ? b.ext_demand : null;
    let handoff = b.handoff ?? null;
    if (!handoff) {
      const hid = peekHandoffId(root, c.feature);
      if (b.ext_demand && typeof b.ext_demand === 'object') {
        const e = b.ext_demand;
        const r = recordExtDemand(root, { operation: e.operation, target: e.target, gap: e.gap, requester: hid, alternative: e.alternative, prohibition: e.prohibition, date: today() });
        ext = r.id;
        (r.appended ? track.ext_appended : track.ext_added).push(r.id);
      }
      handoff = appendHandoff(root, {
        feature: c.feature, target: `${c.step_id} の実行: ${b.detail}`, reason: b.reason, dest: proc.vocab.reason_code?.[b.reason]?.default_dest ?? '',
        means: ext ?? (b.reason === '禁止操作' ? b.ref : b.ref ?? ''), origin: `${q.flow_id} / 作業10 / ${c.step_id}`, date: today(),
      });
      track.handoffs.push(handoff);
    }
    const bb = { reason: b.reason, handoff };
    if (b.reason === '禁止操作') bb.prohibition = b.ref;
    if (ext) bb.ext_demand = ext;
    else if (b.reason !== '禁止操作' && !blank(b.ref)) bb.ref = b.ref;
    bb.resume_from = b.resume_from;
    step.blocked_by = bb;
    step.notes = [step.notes, b.detail].filter(Boolean).join(' / ');
  }
  writeNotes(ctx, q, c, out, c.step_id, track);
  track.ops_registered.push(...out.ops_registered);
  const rel = writeScenario(ctx, q, c, (sc) => {
    sc.steps = [...(sc.steps ?? []).filter((s) => s.step_id !== c.step_id), orderStep(step)];
    sc.carried_data = { ...(sc.carried_data ?? {}), ...out.carried_data };
    if (track.discrepancies.length) sc.discrepancies = [...new Set([...(sc.discrepancies ?? []), ...track.discrepancies])];
    return sc;
  });
  wrote.push(rel);
  // blocked のあとのステップは実行しない(pms が記録だけを書く)
  if (out.verdict === 'blocked') {
    const rest = stepCards(q, c.round, c.scenario).filter((x) => Number(x.id.slice(2)) > Number(c.id.slice(2)) && !isDone(x));
    if (rest.length) {
      writeScenario(ctx, q, c, (sc) => {
        sc.steps = [...sc.steps.filter((s) => !rest.some((x) => x.step_id === s.step_id)), ...rest.map((x) => ({ step_id: x.step_id, verdict: 'blocked', blocked_by: { reason: FOLLOWS_BLOCKED } }))];
        return sc;
      });
      for (const x of rest) skipCard(q, x, `前のステップ ${c.step_id} が blocked`);
      wrote.push(`${paths.queue(q.flow_id)}(${rest.map((x) => x.id).join(', ')} を skipped)`);
    }
  }
  c.track = track;
  for (const id of [...track.discrepancies]) wrote.push(`${paths.discrepancies()}(${id})`);
  for (const id of track.handoffs) wrote.push(`${paths.handoff()}(${id})`);
  for (const id of track.signals) wrote.push(`${paths.signals()}(${id})`);
  for (const id of [...track.ext_added, ...track.ext_appended]) wrote.push(`${paths.extDemand()}(${id})`);
  return wrote;
}

// ── explore.close ────────────────────────────────────
export function checkClose(ctx, q, c, out, fail) {
  const { root } = ctx;
  if (out.result === 'cannot_proceed') return () => { stopCard(q, c, `cannot_proceed: ${out.notes}`, 'cannot_proceed'); return []; };
  invariantChecks(ctx, out, fail);
  for (const [i, r] of out.reflections.entries()) {
    if (r.target === 'none') continue;
    if (blank(r.path)) fail('red_flag', `reflections[${i}] に反映先のファイル(path)がありません`);
    else if (!fs.existsSync(path.join(root, r.path.split('#')[0]))) fail('red_flag', `reflections[${i}] の反映先 ${r.path} がありません(反映してから提出する)`);
  }
  return () => {
    const track = newTrack();
    writeNotes(ctx, q, c, out, c.scenario, track);
    const rel = writeScenario(ctx, q, c, (sc) => {
      sc.invariants = out.invariants;
      sc.manual_gap = out.manual_gap;
      sc.requires_setup = requiresSetup(ctx, q, c.scenario);
      return sc;
    });
    c.output = { invariants: out.invariants, violations: out.violations, reflections: out.reflections, manual_gap: out.manual_gap };
    c.track = track;
    return [rel, ...track.handoffs.map((id) => `${ctx.paths.handoff()}(${id})`), ...track.signals.map((id) => `${ctx.paths.signals()}(${id})`)];
  };
}

// ── explore.session_close ────────────────────────────
export function checkSessionClose(ctx, q, c, out, fail) {
  if (out.result === 'cannot_proceed') return () => { stopCard(q, c, `cannot_proceed: ${out.notes}`, 'cannot_proceed'); return []; };
  invariantChecks(ctx, out, fail);
  return () => {
    c.output = { invariants: out.invariants, violations: out.violations };
    return [`${ctx.paths.queue(q.flow_id)}(全体検査の結果)`];
  };
}

// ── report.findings ──────────────────────────────────
export function checkFindings(ctx, q, c, out, fail) {
  if (out.result === 'cannot_proceed') return () => { stopCard(q, c, `cannot_proceed: ${out.notes}`, 'cannot_proceed'); return []; };
  // シナリオ末尾の DB不変条件を実行したなら、優先レビュー推奨に INV を挙げる(00 ■DB不変条件。誤った INV は偽の失敗を撒く)
  const ranInv = q.cards.some((x) => x.kind === 'explore.close' && x.round === c.round && Object.values(x.output?.invariants ?? {}).some((v) => v === 'pass' || v === 'fail'));
  if (ranInv && !out.priority_review.some((p) => /INV/.test(`${p.item} ${p.reason}`))) fail('red_flag', 'DB不変条件(INV)を実行したのに、優先レビュー推奨(priority_review)に INV の SQL が挙がっていません(00 ■DB不変条件)');
  return () => {
    c.output = out;
    return [`${ctx.paths.queue(q.flow_id)}(所見)`];
  };
}
