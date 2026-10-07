// pms.mjs — 進行役 pms の記録の検査(00 ■進行役と記録の道具)
//   act_log_linked / phase_a_queue_complete
//
// どちらも proc-v017 以降のフローだけに当てる(作業10の status.yaml の procedure_version で判定する)。

import { verNum } from './exploration.mjs';

const PMS_SINCE = 17; // proc-v017 で追加
const DONE = ['passed', 'stopped'];

function blank(v) {
  return v == null || String(v).trim() === '';
}

/** 作業10の status.yaml(機能ディレクトリ・フロー)の手順版。status.yaml がなければ undefined */
function stage10Version(repo, feature, flow) {
  const st = repo.statusFiles.find((x) => x.rel === `work/${feature}/exploration/status.yaml` && x.flow === flow && x.data);
  return st ? verNum(st.data.procedure_version) : undefined;
}

/** proc-v017 以降で始めた作業10のフロー(status.yaml のあるもの) */
function pmsFlows(repo) {
  const out = new Map(); // フロー → 機能ディレクトリの一覧
  for (const s of repo.statusFor('10', repo.flow)) {
    const v = verNum(s.data?.procedure_version);
    if (!s.flow || v === null || v < PMS_SINCE) continue;
    if (!out.has(s.flow)) out.set(s.flow, []);
    out.get(s.flow).push(s.feature);
  }
  return out;
}

// 記録の操作 → setup-log の steps[].action(vocab.pms_act_action の step)
function stepMap(repo) {
  const m = new Map();
  for (const [k, v] of Object.entries(repo.vocab.pms_act_action ?? {})) if (v && typeof v === 'object' && v.step) m.set(k, String(v.step));
  return m;
}

// ════════════════════════════════════════════════════════
// act_log_linked
// ════════════════════════════════════════════════════════
export function act_log_linked(repo) {
  const findings = [];
  const notes = [];
  const add = (file, message) => findings.push({ file, message });
  const map = stepMap(repo);
  const byFlow = new Map(); // フロー → Map<seq, 記録>
  for (const a of repo.actRecords) {
    if (!a.r || !a.r.flow) continue;
    if (!byFlow.has(a.r.flow)) byFlow.set(a.r.flow, new Map());
    byFlow.get(a.r.flow).set(Number(a.r.seq), a.r);
  }
  let checked = 0;
  for (const s of repo.setupEntries) {
    if (!repo.inFlow(s.flow) || s.e.classification !== 'built-by-ui') continue;
    const v = stage10Version(repo, s.feature, s.flow);
    if (v === undefined || v === null || v < PMS_SINCE) continue;
    checked++;
    const where = `${s.file}(${s.e.state_id ?? 'state_id なし'} / ${s.flow})`;
    const act = s.e.act;
    if (!act || typeof act !== 'object' || blank(act.card) || !Array.isArray(act.seqs)) {
      add(where, 'act(card・seqs・established_check_seq)がありません(built-by-ui のエントリは pms が pms act の記録から書く。§10 フェーズA)');
      continue;
    }
    const recs = byFlow.get(s.flow) ?? new Map();
    const steps = Array.isArray(s.e.steps) ? s.e.steps : [];
    if (steps.length !== act.seqs.length) add(where, `steps の数(${steps.length})と act.seqs の数(${act.seqs.length})が違います`);
    act.seqs.forEach((seq, i) => {
      const r = recs.get(Number(seq));
      if (!r) { add(where, `act.seqs の ${seq} が ${s.flow} の操作の記録(act-log.jsonl)にありません`); return; }
      if (r.card !== act.card) add(where, `act.seqs の ${seq} は別のカード ${r.card} の記録です(act.card は ${act.card})`);
      if (r.ok !== true) add(where, `act.seqs の ${seq} は失敗した操作の記録です`);
      const st = steps[i];
      if (!st) return;
      const want = map.get(r.action);
      if (!want) { add(where, `act.seqs の ${seq} の記録の操作 ${r.action} は steps にする操作ではありません`); return; }
      if (String(st.action) !== want) add(where, `steps[${i}] の action ${st.action} が記録(${seq}: ${r.action} → ${want})と違います`);
      const target = want === 'goto' ? ['detail', r.value] : want === 'external' ? ['operation_id', r.operation_id] : ['locator', r.locator];
      if (String(st[target[0]] ?? '') !== String(target[1] ?? '')) add(where, `steps[${i}] の ${target[0]} が記録(${seq}: ${target[1] ?? 'なし'})と違います`);
      if (want !== 'goto' && want !== 'external' && r.value != null && String(st.value ?? '') !== String(r.value)) add(where, `steps[${i}] の value が記録(${seq})と違います`);
    });
    if (act.established_check_seq == null) add(where, 'act に established_check_seq がありません');
    else {
      const r = recs.get(Number(act.established_check_seq));
      if (!r) add(where, `act.established_check_seq ${act.established_check_seq} が操作の記録にありません`);
      else if (r.card !== act.card || r.action !== 'assert' || r.ok !== true) add(where, `act.established_check_seq ${act.established_check_seq} は、カード ${act.card} の成功した assert の記録ではありません`);
    }
  }
  notes.push(`proc-v017 以降のフローの built-by-ui のエントリ ${checked} 件を確認`);
  return { findings, notes };
}

// ════════════════════════════════════════════════════════
// phase_a_queue_complete
// ════════════════════════════════════════════════════════
export function phase_a_queue_complete(repo) {
  const findings = [];
  const notes = [];
  for (const [flow] of pmsFlows(repo)) {
    const q = repo.flowQueues.get(flow);
    const rel = `work/_flows/${flow}/queue.json`;
    if (!q) { findings.push({ file: rel, message: `${flow} のフェーズAのキューがありません(node tools/pms/pms.mjs queue build --flow ${flow} --phase A。§10 フェーズA)` }); continue; }
    const cards = Array.isArray(q.data.cards) ? q.data.cards : [];
    const open = cards.filter((c) => !DONE.includes(c?.status));
    for (const c of open) findings.push({ file: rel, message: `カード ${c?.id ?? '?'}(${c?.kind ?? '?'} / ${c?.state_id ?? '?'})が ${c?.status ?? '状態なし'} のままです(合格か STOP になるまで pms next を続ける)` });
    const stopped = cards.filter((c) => c?.status === 'stopped');
    notes.push(`${flow}: カード ${cards.length} 枚(合格 ${cards.length - open.length - stopped.length}・STOP ${stopped.length})`);
  }
  return { findings, notes };
}
