// stats.mjs — pms stats: カードの合格率・提出の回数・不合格の区分・出し直し・STOP と、記録の必須欄の充足率を集計する
//
// 入力は記録だけ(work/_flows/F-<番号>/queue.json・submit-log.jsonl、setup-log・exploration-log)。
// 実行形態は submit-log の runner(環境変数 PMS_RUNNER。未設定は b1)、出した記録(queue の history の runner)で分ける。

import fs from 'node:fs';
import { readJsonl, readJson, UsageError, FLOW_RE } from './util.mjs';
import { readEntries } from './setup-log.mjs';
import { readScenarios } from './exploration-log.mjs';

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function flowsIn(ctx, flow) {
  if (flow) return [flow];
  const dir = ctx.paths.abs('work/_flows');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => FLOW_RE.test(f) && fs.existsSync(ctx.paths.abs(ctx.paths.queue(f)))).sort();
}

function runnerOfCard(q, c, rows) {
  const ev = (q.history ?? []).find((h) => h.card === c.id && (h.event === 'issued' || h.event === 'reissued') && h.runner);
  return ev?.runner ?? rows.find((r) => r.card === c.id)?.runner ?? 'b1';
}

/** setup-log・exploration-log の必須欄の充足率 */
function fillRates(ctx, q) {
  const f = {};
  const tick = (key, ok) => { f[key] ??= { filled: 0, total: 0 }; f[key].total++; if (ok) f[key].filled++; };
  for (const fc of q.features ?? []) {
    const sl = ctx.paths.setupLog(fc);
    for (const e of readEntries(ctx.paths.abs(sl), sl, q.flow_id)) {
      if (e.classification === 'built-by-ui') {
        tick('setup.built-by-ui.steps', Array.isArray(e.steps) && e.steps.length > 0);
        for (const s of e.steps ?? []) if (s.action !== 'goto' && s.action !== 'external') tick('setup.built-by-ui.steps[].locator', !!s.locator);
        tick('setup.built-by-ui.act', !!e.act?.card);
        tick('setup.built-by-ui.established_check', !!String(e.established_check ?? '').trim());
      } else if (e.classification === 'provided' && e.state_id !== 'S-CLEAN-ENV') {
        tick('setup.provided.steps', Array.isArray(e.steps) && e.steps.length > 0);
        tick('setup.provided.reused_from', !!e.reused_from?.flow_id);
      }
    }
    const el = ctx.paths.explorationLog(fc);
    for (const sc of readScenarios(ctx.paths.abs(el), el, q.flow_id)) {
      tick('exploration.carried_data', sc.carried_data != null);
      for (const s of sc.steps ?? []) {
        if (s.verdict === 'blocked') {
          if (s.blocked_by?.reason !== '前ステップが blocked') tick('exploration.blocked.resume_from', !!s.blocked_by?.resume_from);
          continue;
        }
        for (const k of ['started_at', 'ended_at', 'assertion_hint', 'act']) tick(`exploration.steps.${k}`, s[k] != null && s[k] !== '');
        tick('exploration.steps.actions', Array.isArray(s.actions));
        if (s.verdict === 'failed' || s.verdict === 'human-check') tick('exploration.steps.evidence(failed・human-check)', (s.evidence ?? []).length > 0);
      }
    }
  }
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { ...v, rate: pct(v.filled, v.total) }]));
}

/**
 * @param {{flow?: string, since?: string}} opt
 */
export function stats(ctx, opt) {
  if (!opt.flow && !opt.since) throw new UsageError('--flow か --since(YYYY-MM-DD)を指定する');
  if (opt.since && Number.isNaN(new Date(opt.since).getTime())) throw new UsageError(`--since が日付として読めません: ${opt.since}`);
  const since = opt.since ? new Date(opt.since).getTime() : null;
  const inRange = (t) => since == null || (t && new Date(t).getTime() >= since);
  const groups = new Map();
  const g = (kind, runner) => {
    const k = `${kind}\u0000${runner}`;
    if (!groups.has(k)) groups.set(k, { kind, runner, cards: 0, first_pass: 0, submits: 0, rejections: {}, reissues: 0, stops: 0, stop_codes: {} });
    return groups.get(k);
  };
  const records = {};
  const flows = [];
  for (const flow of flowsIn(ctx, opt.flow)) {
    const q = readJson(ctx.paths.abs(ctx.paths.queue(flow)), ctx.paths.queue(flow));
    const rows = readJsonl(ctx.paths.abs(ctx.paths.submitLog(flow))).rows;
    let used = false;
    for (const c of q.cards ?? []) {
      if (!c.issued_count && !rows.some((r) => r.card === c.id)) continue; // AIに出していない(skipped・未出)
      const mine = rows.filter((r) => r.card === c.id);
      if (!inRange(c.issued_at ?? mine[0]?.at ?? c.created_at)) continue;
      used = true;
      const x = g(c.kind, runnerOfCard(q, c, rows));
      x.cards++;
      if (mine[0]?.ok) x.first_pass++;
      x.submits += mine.length;
      for (const r of mine) if (!r.ok) for (const cat of r.categories ?? []) x.rejections[cat] = (x.rejections[cat] ?? 0) + 1;
      x.reissues += Math.max(0, (c.issued_count ?? 0) - 1);
      if (c.status === 'stopped' && !c.stop?.chained_from) {
        x.stops++;
        const code = c.stop?.code ?? 'cannot_proceed';
        x.stop_codes[code] = (x.stop_codes[code] ?? 0) + 1;
      }
    }
    if (used) {
      flows.push(flow);
      for (const [k, v] of Object.entries(fillRates(ctx, q))) {
        records[k] ??= { filled: 0, total: 0 };
        records[k].filled += v.filled;
        records[k].total += v.total;
      }
    }
  }
  const byKind = [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.runner.localeCompare(b.runner)).map((x) => ({
    ...x, first_pass_rate: pct(x.first_pass, x.cards), avg_submits: x.cards ? Math.round((x.submits / x.cards) * 100) / 100 : null,
  }));
  return {
    flows, since: opt.since ?? null, by_kind: byKind,
    records: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, { ...v, rate: pct(v.filled, v.total) }])),
  };
}

export function statsText(s) {
  const L = [`対象のフロー: ${s.flows.join(', ') || 'なし'}${s.since ? `(${s.since} 以降)` : ''}`, ''];
  L.push('| 種類 | 実行形態 | 枚数 | 初回合格率 | 平均の提出回数 | 不合格の区分 | 出し直し | STOP |', '|---|---|---|---|---|---|---|---|');
  for (const x of s.by_kind) {
    L.push(`| ${x.kind} | ${x.runner} | ${x.cards} | ${x.first_pass_rate ?? '-'}% | ${x.avg_submits ?? '-'} | ${Object.entries(x.rejections).map(([k, v]) => `${k} ${v}`).join(', ') || 'なし'} | ${x.reissues} | ${x.stops}${x.stops ? `(${Object.entries(x.stop_codes).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''} |`);
  }
  L.push('', '| 記録の必須欄 | 充足 | 全体 | 率 |', '|---|---|---|---|');
  for (const [k, v] of Object.entries(s.records)) L.push(`| ${k} | ${v.filled} | ${v.total} | ${v.rate ?? '-'}% |`);
  return L.join('\n');
}
