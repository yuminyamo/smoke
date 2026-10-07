// queue.mjs — タスクキュー: queue build(カードを作る)/ next(次のカードを出す)/ status / reopen

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { targetScenarios, featureDirs } from './scenarios.mjs';
import { readAllEntries, upsertEntry } from './setup-log.mjs';
import { adoptedStates, stateDemandRow, appendHandoff } from './ledgers.mjs';
import { classifyLocator, ENV_SCRIPT } from './cli.mjs';
import { timestamp, today, writeText, UsageError, flowNum, blank, readText } from './util.mjs';
import { TEMP_REF } from './checks.mjs';

export const PMS = 'node tools/pms/pms.mjs';
// ゴールデンイメージの復元そのものである状態。カードにせず、工程0の復元を記録する(lint の requires_covered と同じ扱い)
export const RESTORE_STATES = new Set(['S-CLEAN-ENV']);
// ログイン状態(初めて整備したら起動確認テストも作る。§10 フェーズA)
export const LOGIN_STATES = new Set(['S-ADMIN-LOGIN', 'S-USER-LOGIN']);
export const READINESS_TEST = 'tests/readiness/server-ready.setup.ts';

const TODO = {
  'setup.build': (c) => `状態 ${c.state_id} を pms act の画面操作で作り、pms act assert で成立を確かめて提出する`,
  'setup.code': (c) => `状態 ${c.state_id} のシナリオ部品と fixture を書き、2回実行して提出する`,
  'setup.reuse': (c) => `状態 ${c.state_id} の既存の fixture を1回実行し、成立したかを提出する`,
};

export function todoOf(card) { return TODO[card.kind](card); }

export function submitCommand(q, card, paths) {
  return `${PMS} submit --flow ${q.flow_id} --card ${card.id} --file ${paths.out(q.flow_id, card.id)}`;
}

/** steps の locator が安定か(付録B: 安定ロケータ、またはページオブジェクト/部品のメソッド参照) */
export function stepLocatorStable(loc) {
  const s = String(loc ?? '').trim().replace(/^page\./, '');
  if (s === '' || TEMP_REF.test(s)) return false;
  if (/^getBy/.test(s)) return classifyLocator(s) === 'stable';
  return /^[A-Z][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+(\(\))?$/.test(s); // LoginPage.userId など
}

function stepsRecorded(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.every((s) => {
    if (!s || typeof s !== 'object' || blank(s.action)) return false;
    if (s.action === 'goto') return !blank(s.detail);
    if (s.action === 'external') return !blank(s.operation_id);
    return stepLocatorStable(s.locator);
  });
}

/** fixture の記録(fixtures/auth.ts#userLogin)のファイルが tests/ にあるか */
export function fixtureFile(root, fx) {
  const p = String(fx ?? '').split('#')[0].trim();
  if (!p) return null;
  const rel = 'tests/' + p.replace(/^\.?\/?(tests\/)?/, '');
  return fs.existsSync(path.join(root, rel)) ? rel : null;
}

/**
 * 過去のフローの流用元(同じ state_id の built-by-ui、または流用元を辿れる provided で verified: true、fixture のファイルがある)。
 * 最も新しいフローのもの。
 */
export function findReuseSource(root, paths, stateId, flow) {
  const cands = [];
  for (const fc of featureDirs(root)) {
    const rel = paths.setupLog(fc);
    for (const { flow: f, e } of readAllEntries(paths.abs(rel), rel)) {
      if (e.state_id !== stateId || !f || f === flow || e.verified !== true) continue;
      const ok = e.classification === 'built-by-ui' || (e.classification === 'provided' && e.reused_from && !blank(e.reused_from.flow_id));
      if (!ok || !fixtureFile(root, e.fixture)) continue;
      cands.push({ flow: f, feature: fc, rel, entry: e });
    }
  }
  cands.sort((a, b) => flowNum(b.flow) - flowNum(a.flow));
  return cands[0] ?? null;
}

// ════════════════════════════════════════════════════════
// queue build
// ════════════════════════════════════════════════════════
export function buildQueue(ctx, { flow, phase, scenarioIds }) {
  const { root, paths, store, proc } = ctx;
  if (phase !== 'A') throw new UsageError(`--phase は A だけを扱います(段1。探索のカードは段2で加える): ${phase}`);
  if (store.hasQueue(flow)) throw new UsageError(`${paths.queue(flow)} が既にあります(キューは作り直さない。人間がカードを戻すときは reopen を使う)`);
  const { scenarios, missing } = targetScenarios(root, flow, scenarioIds);
  if (missing.length) throw new UsageError(`scenarios.md にないシナリオです: ${missing.join(', ')}`);
  if (scenarios.length === 0) throw new UsageError(`${flow} の対象シナリオがありません(scenarios.md の「策定方式」の行に ${flow} を書いたシナリオ。前のフローのシナリオを扱うときは --scenarios で指定する)`);

  const warnings = [];
  const states = new Map(); // 状態ID → { feature, scenarios[] }
  for (const sc of scenarios) {
    if (!sc.requiresFound) warnings.push(`${sc.id} に requires の行がありません(付録C)`);
    for (const st of sc.requires) {
      if (!states.has(st)) states.set(st, { feature: sc.feature, scenarios: [] });
      states.get(st).scenarios.push(sc.id);
    }
  }
  const base = Object.keys(proc.vocab.initial_state_set ?? {});
  const adopted = adoptedStates(root);
  const q = {
    flow_id: flow, phase: 'A', procedure_version: proc.version, created_at: timestamp(),
    features: [...new Set(scenarios.map((s) => s.feature))],
    scenarios: scenarios.map((s) => ({ id: s.id, feature: s.feature, requires: s.requires })),
    cards: [], auto: [], warnings, history: [],
  };
  const add = (card) => {
    const c = { id: store.nextCardId(q), status: 'pending', issued_count: 0, rejections: 0, created_at: timestamp(), ...card };
    q.cards.push(c);
    return c;
  };

  for (const [st, info] of states) {
    const base_ = { state_id: st, feature: info.feature, scenarios: info.scenarios };
    if (!base.includes(st) && !adopted.has(st)) {
      // 初期状態セットにない(パートBの記載ルール8・lint requires_in_state_set により通常は起きない)
      const handoff = appendHandoff(root, {
        feature: info.feature,
        target: `前提状態 ${st} が初期状態セットにない(要求元 ${info.scenarios.join(', ')})`,
        reason: '初期状態外', dest: proc.vocab.reason_code?.['初期状態外']?.default_dest ?? '',
        origin: `${flow} / 作業10 / ${info.scenarios.join(', ')}`, date: today(),
      });
      writeSetup(ctx, info.feature, flow, {
        state_id: st, classification: 'blocked', blocked_by: { reason: '初期状態外', handoff },
        notes: 'pms が記録した(初期状態セットにない状態。カードにしない)',
      });
      q.auto.push({ ...base_, classification: 'blocked', reason: '初期状態外', handoff });
      warnings.push(`${st} は初期状態セットにないため、setup-log に blocked(初期状態外)と申し送り ${handoff} を書いた(要求元 ${info.scenarios.join(', ')}。パートCで blocked にする)`);
      continue;
    }
    if (RESTORE_STATES.has(st)) {
      writeSetup(ctx, info.feature, flow, {
        state_id: st, classification: 'provided',
        established_check: '工程0のゴールデンイメージの復元と起動完了の確認(status.yaml の env_restore)',
        verified: true, provided_by: '工程0のゴールデンイメージの復元',
        notes: 'pms が記録した(復元そのものであり fixture を作らない)',
      });
      q.auto.push({ ...base_, classification: 'provided', reason: '工程0の復元' });
      continue;
    }
    const src = findReuseSource(root, paths, st, flow);
    if (src && stepsRecorded(src.entry.steps)) {
      add({ kind: 'setup.reuse', ...base_, reuse: { flow_id: src.flow, feature: src.feature, setup_log: src.rel } });
    } else if (src) {
      add({ kind: 'setup.build', ...base_, rebuild: { reason: 'old_record', flow_id: src.flow, fixture: src.entry.fixture ?? null, flow: src.entry.flow ?? null } });
    } else {
      add({ kind: 'setup.build', ...base_ });
    }
  }
  store.saveQueue(q);
  return q;
}

export function writeSetup(ctx, feature, flow, entry) {
  const rel = ctx.paths.setupLog(feature);
  upsertEntry(ctx.paths.abs(rel), rel, { feature, flow }, entry);
  return rel;
}

// ════════════════════════════════════════════════════════
// カードの本文
// ════════════════════════════════════════════════════════
function mdTable(obj) {
  const keys = Object.keys(obj).filter((k) => !blank(obj[k]));
  if (!keys.length) return 'なし';
  return ['| 欄 | 値 |', '|---|---|', ...keys.map((k) => `| ${k} | ${String(obj[k]).replace(/\|/g, '\\|')} |`)].join('\n');
}

function kbPages(root, stateId) {
  const out = [];
  const idx = 'kb/00_索引.md';
  if (fs.existsSync(path.join(root, idx))) out.push(idx);
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== '_archived') walk(p); }
      else if (e.name.endsWith('.md') && readText(p).includes(stateId)) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'kb'));
  return [...new Set(out)];
}

function envKeys(root) {
  const r = spawnSync(process.execPath, [ENV_SCRIPT, '--root', root, 'list'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const attrs = j.attributes ?? j.keys ?? [];
    if (Array.isArray(attrs)) return attrs.map((a) => (typeof a === 'string' ? a : `${a.key}${a.kind ? `(${a.kind})` : ''}`));
    return Object.entries(attrs).map(([k, v]) => `${k}${v?.kind ? `(${v.kind})` : ''}`);
  } catch { return null; }
}

function list(items) { return items.length ? items.map((x) => `- ${x}`).join('\n') : 'なし'; }

/** カードの入力(pms が機械的に埋めるもの) */
function cardVars(ctx, q, c, reissue) {
  const { root, paths, store, proc } = ctx;
  const acts = store.actRecords(q);
  const last = [...acts].reverse().find((a) => a.url_after);
  const definition = proc.vocab.initial_state_set?.[c.state_id] ?? stateDemandRow(root, c.state_id)?.['定義(業務語)'] ?? '(定義なし)';
  const sd = stateDemandRow(root, c.state_id);
  const keys = envKeys(root);
  const v = {
    card_id: c.id, flow_id: q.flow_id, kind: c.kind, state_id: c.state_id, feature: c.feature,
    definition, scenarios: c.scenarios.join(', '),
    state_demand: sd ? mdTable(sd) : 'なし(基本の状態。vocab.initial_state_set)',
    established_check_idea: sd?.['established check の案'] || 'なし(自分で決める)',
    kb_pages: list(kbPages(root, c.state_id)),
    current_url: last ? last.url_after : 'まだ画面を開いていない(open から始める)',
    env_keys: keys ? list(keys) : '取得できない(node tools/env/env.mjs list で確かめる)',
    out_file: paths.out(q.flow_id, c.id),
    submit: submitCommand(q, c, paths),
    act: `${PMS} act --flow ${q.flow_id} --card ${c.id}`,
    reissue: '',
    rebuild: 'なし',
  };
  if (reissue) {
    const mine = acts.filter((a) => a.card === c.id);
    v.reissue = `> **前回は提出されなかった(${c.issued_count} 回目)。** このカードで記録済みの操作: `
      + (mine.length ? mine.map((a) => `${a.seq}(${a.action}${a.ok ? '' : '・失敗'})`).join(', ') : 'なし')
      + '。記録済みの操作は使ってよい(必要なら snapshot で画面を確かめてから続ける)';
  }
  if (c.rebuild) {
    const r = c.rebuild;
    v.rebuild = r.reason === 'broken'
      ? `既存の fixture \`${r.fixture}\`(${r.flow_id})では状態が成立しなかった(カード ${r.reuse_card})。作り直す。`
      : `過去の記録(${r.flow_id}。fixture \`${r.fixture}\`)に操作列か安定ロケータがないため、記録を取り直す。`;
    if (c.kind === 'setup.code') v.rebuild += ` **fixture と部品は同じ名前のまま直す**(fixture \`${r.fixture ?? 'なし'}\`、部品 \`${r.flow ?? 'なし'}\`)。`;
  }
  if (c.kind === 'setup.code') Object.assign(v, codeVars(ctx, q, c, acts));
  if (c.kind === 'setup.reuse') Object.assign(v, reuseVars(ctx, q, c));
  return v;
}

/** setup.code: 記録から作ったコードの下書き(値は envValue で読む形に置き換える) */
export function codeDraft(acts, seqs, estSeq) {
  const bySeq = new Map(acts.map((a) => [a.seq, a]));
  const lines = [];
  for (const s of seqs) {
    const a = bySeq.get(s);
    if (!a) continue;
    let code = a.code ?? `// ${a.action}`;
    code = code.replace(/'<env:([^>']+)>'|"<env:([^>"]+)>"/g, (_, k1, k2) => `envValue('${k1 ?? k2}')`);
    lines.push(`// seq ${a.seq}: ${a.intent ?? a.action}`, code);
  }
  const e = bySeq.get(estSeq);
  if (e) lines.push(`// seq ${e.seq}: established check — ${e.intent ?? ''}`, e.code ?? '');
  return lines.join('\n');
}

function codeVars(ctx, q, c, acts) {
  const { root, paths } = ctx;
  const rel = paths.setupLog(c.feature);
  const entry = readAllEntries(paths.abs(rel), rel).find((x) => x.flow === q.flow_id && x.e.state_id === c.state_id)?.e ?? {};
  const ls = (d) => {
    const abs = path.join(root, d);
    return fs.existsSync(abs) ? fs.readdirSync(abs).filter((f) => /\.(ts|js)$/.test(f)).map((f) => `${d}/${f}`) : [];
  };
  return {
    setup_entry: '```json\n' + JSON.stringify({ steps: entry.steps ?? [], established_check: entry.established_check ?? '' }, null, 2) + '\n```',
    draft: '```ts\n' + codeDraft(acts, entry.act?.seqs ?? [], entry.act?.established_check_seq) + '\n```',
    existing_code: list([...ls('tests/flows'), ...ls('tests/fixtures'), ...ls('tests/pages')]),
    readiness: !LOGIN_STATES.has(c.state_id)
      ? 'ログイン状態ではない(起動確認テストは作らない)'
      : fs.existsSync(path.join(root, READINESS_TEST))
        ? `ログイン状態。起動確認テスト \`${READINESS_TEST}\` は既にある(作らない)`
        : `ログイン状態。起動確認テスト \`${READINESS_TEST}\` がないので作る(R-SETC-3)`,
  };
}

function reuseVars(ctx, q, c) {
  const { root, paths } = ctx;
  const src = c.reuse;
  const entry = readAllEntries(paths.abs(src.setup_log), src.setup_log).find((x) => x.flow === src.flow_id && x.e.state_id === c.state_id)?.e ?? {};
  // 過去の setup.code の実行のコマンドを例にする
  let example = null;
  const outDir = path.join(root, paths.flowDir(src.flow_id), 'out');
  const qf = path.join(root, paths.queue(src.flow_id));
  if (fs.existsSync(qf) && fs.existsSync(outDir)) {
    try {
      const pq = JSON.parse(fs.readFileSync(qf, 'utf8'));
      const code = (pq.cards ?? []).filter((x) => x.kind === 'setup.code' && x.state_id === c.state_id && x.status === 'passed').pop();
      if (code) example = JSON.parse(fs.readFileSync(path.join(outDir, `${code.id}.json`), 'utf8')).runs?.[0]?.command ?? null;
    } catch { /* 例がなくても進める */ }
  }
  return {
    source_flow: src.flow_id,
    source_entry: '```json\n' + JSON.stringify({ fixture: entry.fixture, flow: entry.flow, steps: entry.steps, established_check: entry.established_check }, null, 2) + '\n```',
    run_example: example ? `\`${example}\`(${src.flow_id} の setup.code で実行したコマンド)` : `記録がない。fixture \`${entry.fixture}\` を使う最小のテストを1回実行する(例 \`npx playwright test <その fixture を使う spec> --workers=1\`)`,
  };
}

export function renderCard(ctx, q, c, reissue = false) {
  const body = ctx.proc.render(c.kind, cardVars(ctx, q, c, reissue));
  writeText(ctx.paths.abs(ctx.paths.card(q.flow_id, c.id)), body);
  return body;
}

// ════════════════════════════════════════════════════════
// next / status / reopen
// ════════════════════════════════════════════════════════
function stopOutput(q, c, ctx) {
  return {
    state: 'STOP', flow: q.flow_id, card: c.id, kind: c.kind, state_id: c.state_id, reason: c.stop?.reason ?? '',
    message: `カード ${c.id}(${c.kind} / ${c.state_id})は人間の確認待ちです: ${c.stop?.reason ?? ''}。利用者にこの文を伝えて指示を待つ。`
      + `利用者が続けてよいと答えたら ${PMS} next --flow ${q.flow_id} で残りのカードを続ける(人間がカードをやり直させるときは ${PMS} reopen --flow ${q.flow_id} --card ${c.id})`,
    remaining: q.cards.filter((x) => x.status === 'pending' || x.status === 'issued').length,
    next: `${PMS} next --flow ${q.flow_id}`,
  };
}

export function stopCard(q, c, reason) {
  c.status = 'stopped';
  c.stop = { reason, at: timestamp(), reported: false };
  q.history.push({ at: c.stop.at, card: c.id, event: 'stopped', reason });
}

/** @returns {{out: object, code: number}} code 0 = カード / done、3 = STOP */
export function nextCard(ctx, flow) {
  const { store, cfg } = ctx;
  const q = store.loadQueue(flow);
  const issued = q.cards.find((c) => c.status === 'issued');
  if (issued) {
    if (issued.issued_count >= cfg.max_issues) {
      stopCard(q, issued, `出した回数が上限(${cfg.max_issues} 回。config/pms.json の max_issues)に達したが、合格した提出がない`);
    } else {
      issued.issued_count++;
      issued.issued_at = timestamp();
      const body = renderCard(ctx, q, issued, true);
      store.saveQueue(q);
      return { code: 0, out: cardOutput(ctx, q, issued, body) };
    }
  }
  const stopped = q.cards.find((c) => c.status === 'stopped' && !c.stop?.reported);
  if (stopped) {
    stopped.stop.reported = true;
    store.saveQueue(q);
    return { code: 3, out: stopOutput(q, stopped, ctx) };
  }
  const pending = q.cards.find((c) => c.status === 'pending');
  if (pending) {
    pending.status = 'issued';
    pending.issued_count = 1;
    pending.issued_at = timestamp();
    q.history.push({ at: pending.issued_at, card: pending.id, event: 'issued' });
    const body = renderCard(ctx, q, pending, false);
    store.saveQueue(q);
    return { code: 0, out: cardOutput(ctx, q, pending, body) };
  }
  store.saveQueue(q);
  const st = q.cards.filter((c) => c.status === 'stopped').map((c) => ({ card: c.id, kind: c.kind, state_id: c.state_id, reason: c.stop?.reason ?? '' }));
  return {
    code: 0,
    out: {
      state: 'done', flow: q.flow_id, phase: q.phase,
      passed: q.cards.filter((c) => c.status === 'passed').length, stopped: st,
      message: `フェーズAのカードはすべて終わった${st.length ? `(人間の確認待ち ${st.length} 枚: ${st.map((x) => x.card).join(', ')}。報告書の固有セクション1に書く)` : ''}。探索の進め方(パートC)へ進む`,
      next: null,
    },
  };
}

function cardOutput(ctx, q, c, body) {
  return {
    state: 'card', flow: q.flow_id, card: c.id, kind: c.kind, state_id: c.state_id, issued_count: c.issued_count,
    card_file: ctx.paths.card(q.flow_id, c.id), out_file: ctx.paths.out(q.flow_id, c.id),
    now: { flow: q.flow_id, card: c.id, kind: c.kind, state_id: c.state_id, todo: todoOf(c) },
    body,
    next: c.kind === 'setup.build' ? `${PMS} act --flow ${q.flow_id} --card ${c.id} snapshot` : submitCommand(q, c, ctx.paths),
  };
}

export function statusOf(ctx, flow) {
  const q = ctx.store.loadQueue(flow);
  const count = (s) => q.cards.filter((c) => c.status === s).length;
  const cur = q.cards.find((c) => c.status === 'issued');
  return {
    flow: q.flow_id, phase: q.phase, procedure_version: q.procedure_version,
    cards: q.cards.length,
    counts: { pending: count('pending'), issued: count('issued'), passed: count('passed'), stopped: count('stopped') },
    current: cur ? { card: cur.id, kind: cur.kind, state_id: cur.state_id, issued_count: cur.issued_count, rejections: cur.rejections, todo: todoOf(cur) } : null,
    stopped: q.cards.filter((c) => c.status === 'stopped').map((c) => ({ card: c.id, kind: c.kind, state_id: c.state_id, reason: c.stop?.reason ?? '' })),
    auto: q.auto, warnings: q.warnings,
    complete: count('pending') + count('issued') === 0,
    next: cur ? (cur.kind === 'setup.build' ? `${PMS} act --flow ${flow} --card ${cur.id} snapshot` : submitCommand(q, cur, ctx.paths)) : count('pending') ? `${PMS} next --flow ${flow}` : null,
  };
}

/** 人間の操作: STOP のカードを出す前に戻す(出した回数・不合格の回数を 0 に戻す) */
export function reopenCard(ctx, flow, id) {
  const q = ctx.store.loadQueue(flow);
  const c = ctx.store.card(q, id);
  if (c.status !== 'stopped') throw new UsageError(`${id} は STOP(stopped)ではありません(状態 ${c.status})`);
  c.status = 'pending';
  c.issued_count = 0;
  c.rejections = 0;
  q.history.push({ at: timestamp(), card: id, event: 'reopened', previous_stop: c.stop });
  delete c.stop;
  ctx.store.saveQueue(q);
  return { ok: true, flow, card: id, status: 'pending', next: `${PMS} next --flow ${flow}` };
}
