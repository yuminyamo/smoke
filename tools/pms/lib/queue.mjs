// queue.mjs — タスクキュー: queue build(カードを作る)/ next(次のカードを出す)/ status / reopen

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { targetScenarios, featureDirs } from './scenarios.mjs';
import { readAllEntries, upsertEntry } from './setup-log.mjs';
import { adoptedStates, stateDemandRow, appendHandoff } from './ledgers.mjs';
import { classifyLocator, ENV_SCRIPT } from './cli.mjs';
import { timestamp, today, writeText, UsageError, flowNum, blank, readText, readJson } from './util.mjs';
import { TEMP_REF } from './checks.mjs';
import { DONE_STATUS } from './store.mjs';
import { validate } from './schema.mjs';
import { exploreCards, prepareExplore, exploreVars, EXPLORE_TODO } from './explore.mjs';
import { cardType, promptOf } from './agents.mjs';

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
  ...EXPLORE_TODO,
};

export function todoOf(card) { return TODO[card.kind](card); }

// 画面操作(pms act)を使うカードの種類
export const ACT_KINDS = new Set(['setup.build', 'explore.step']);
// フェーズ(A = 初期状態の準備 / C = 探索と報告)。段1のキューのカードは phase を持たない(A として扱う)
export const PHASES = ['A', 'C'];
export function phaseOf(card) { return card.phase ?? 'A'; }

/** カードの対象(状態ID・ステップID・シナリオID・ラウンド) */
export function targetOf(c) {
  return c.state_id ?? c.step_id ?? c.scenario ?? (c.round ? `ラウンド${c.round}` : '');
}

/** カードを出す順: フェーズ(A → C)、次に作った順(カードIDの順) */
export function cardOrder(a, b) {
  return PHASES.indexOf(phaseOf(a)) - PHASES.indexOf(phaseOf(b)) || Number(a.id.slice(2)) - Number(b.id.slice(2));
}

export function isDone(c) { return DONE_STATUS.includes(c.status); }

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
  const { root, paths, store } = ctx;
  if (!['A', 'C', 'all'].includes(phase)) throw new UsageError(`--phase は A / C / all のいずれか: ${phase}`);
  const { scenarios, missing } = targetScenarios(root, flow, scenarioIds);
  if (missing.length) throw new UsageError(`scenarios.md にないシナリオです: ${missing.join(', ')}`);
  if (scenarios.length === 0) throw new UsageError(`${flow} の対象シナリオがありません(scenarios.md の「策定方式」の行に ${flow} を書いたシナリオ。前のフローのシナリオを扱うときは --scenarios で指定する)`);

  const existing = store.hasQueue(flow) ? store.loadQueue(flow) : null;
  const hasA = !!existing && existing.cards.some((c) => phaseOf(c) === 'A');
  const wantA = phase === 'A' || (phase === 'all' && !hasA);
  const wantC = phase === 'C' || phase === 'all';
  if (phase === 'A' && existing) throw new UsageError(`${paths.queue(flow)} が既にあります(フェーズAのキューは作り直さない。人間がカードを戻すときは reopen を使う)`);
  let context = null;
  if (wantC) {
    context = readContext(ctx, flow);
    const open = existing?.cards.filter((c) => phaseOf(c) === 'C' && !isDone(c)) ?? [];
    if (open.length) throw new UsageError(`${flow} のパートCのカードが終わっていません(${open.map((c) => c.id).join(', ')})。終わってから新しいラウンドを作る`);
  }
  const q = existing ?? {
    flow_id: flow, phase: 'A', procedure_version: ctx.proc.version, created_at: timestamp(),
    features: [], scenarios: [], cards: [], auto: [], warnings: [], history: [], rounds: [],
  };
  q.rounds ??= [];
  for (const f of new Set(scenarios.map((s) => s.feature))) if (!q.features.includes(f)) q.features.push(f);
  for (const s of scenarios) if (!q.scenarios.some((x) => x.id === s.id)) q.scenarios.push({ id: s.id, feature: s.feature, requires: s.requires });
  const added = [];
  if (wantA) added.push(...buildPhaseA(ctx, q, flow, scenarios));
  if (wantC) added.push(...exploreCards(ctx, q, scenarios, context));
  q.phase = [...new Set(q.cards.map(phaseOf))].sort().join('+') || 'A';
  store.saveQueue(q);
  return { q, added };
}

/** パートCに要る作業10の開始時の事実(work/_flows/F-<番号>/stage10-context.json。チャットの作業10が工程0〜パートBの結果を写す) */
export function readContext(ctx, flow) {
  const rel = ctx.paths.context(flow);
  if (!fs.existsSync(ctx.paths.abs(rel))) throw new UsageError(`${rel} がありません。工程0〜パートBの結果(環境ID・復元・開始前シナリオ・禁止操作リスト・台帳に書いたID)を procedure/schemas/stage10-context.json の形で書いてから queue build を実行する(stages.md §10 パートC)`);
  const data = readJson(ctx.paths.abs(rel), rel);
  const errs = validate(ctx.proc.schemaFile('stage10-context.json'), data, ctx.proc.vocab);
  if (errs.length) throw new UsageError(`${rel} が procedure/schemas/stage10-context.json に合いません: ${errs.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join(' / ')}`);
  return data;
}

function buildPhaseA(ctx, q, flow, scenarios) {
  const { root, paths, store, proc } = ctx;
  const warnings = q.warnings;
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
  const added = [];
  const add = (card) => {
    const c = { id: store.nextCardId(q), phase: 'A', status: 'pending', issued_count: 0, rejections: 0, created_at: timestamp(), ...card };
    q.cards.push(c);
    added.push(c);
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
  return added;
}

export function writeSetup(ctx, feature, flow, entry) {
  const rel = ctx.paths.setupLog(feature);
  upsertEntry(ctx.paths.abs(rel), rel, { feature, flow }, entry);
  return rel;
}

// ════════════════════════════════════════════════════════
// カードの本文
// ════════════════════════════════════════════════════════
export function mdTable(obj) {
  const keys = Object.keys(obj).filter((k) => !blank(obj[k]));
  if (!keys.length) return 'なし';
  return ['| 欄 | 値 |', '|---|---|', ...keys.map((k) => `| ${k} | ${String(obj[k]).replace(/\|/g, '\\|')} |`)].join('\n');
}

export function kbPages(root, ...needles) {
  const out = [];
  const idx = 'kb/00_索引.md';
  if (fs.existsSync(path.join(root, idx))) out.push(idx);
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== '_archived') walk(p); }
      else if (e.name.endsWith('.md') && needles.some((n) => n && readText(p).includes(n))) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'kb'));
  return [...new Set(out)];
}

export function envKeys(root) {
  const r = spawnSync(process.execPath, [ENV_SCRIPT, '--root', root, 'list'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const attrs = j.attributes ?? j.keys ?? [];
    if (Array.isArray(attrs)) return attrs.map((a) => (typeof a === 'string' ? a : `${a.key}${a.kind ? `(${a.kind})` : ''}`));
    return Object.entries(attrs).map(([k, v]) => `${k}${v?.kind ? `(${v.kind})` : ''}`);
  } catch { return null; }
}

export function list(items) { return items.length ? items.map((x) => `- ${x}`).join('\n') : 'なし'; }

/** カードの入力(pms が機械的に埋めるもの) */
function cardVars(ctx, q, c, reissue) {
  const { root, paths, store } = ctx;
  const acts = store.actRecords(q);
  const last = [...acts].reverse().find((a) => a.url_after);
  const keys = envKeys(root);
  const v = {
    card_id: c.id, flow_id: q.flow_id, kind: c.kind, feature: c.feature ?? '',
    current_url: last ? last.url_after : 'まだ画面を開いていない(open から始める)',
    env_keys: keys ? list(keys) : '取得できない(node tools/env/env.mjs list で確かめる)',
    out_file: paths.out(q.flow_id, c.id),
    submit: submitCommand(q, c, paths),
    act: `${PMS} act --flow ${q.flow_id} --card ${c.id}`,
    reissue: '',
  };
  if (reissue) {
    const mine = acts.filter((a) => a.card === c.id);
    const lastSubmit = store.submitRows(q.flow_id).filter((r) => r.card === c.id).pop();
    v.reissue = `> **このカードを出すのは ${c.issued_count} 回目である。** `
      + (lastSubmit && !lastSubmit.ok ? `前回の提出は不合格だった(区分: ${lastSubmit.categories.join(', ')})。理由のところだけを直して提出する。` : '前回は合格する提出がないまま終わった。')
      + ' このカードで記録済みの操作: '
      + (mine.length ? mine.map((a) => `${a.seq}(${a.action}${a.ok ? '' : '・失敗'})`).join(', ') : 'なし')
      + '。記録済みの操作は使ってよい(必要なら snapshot で画面を確かめてから続ける)';
  }
  if (c.kind.startsWith('setup.')) Object.assign(v, setupVars(ctx, q, c, acts));
  else Object.assign(v, exploreVars(ctx, q, c, acts));
  return v;
}

function setupVars(ctx, q, c, acts) {
  const { root, proc } = ctx;
  const definition = proc.vocab.initial_state_set?.[c.state_id] ?? stateDemandRow(root, c.state_id)?.['定義(業務語)'] ?? '(定義なし)';
  const sd = stateDemandRow(root, c.state_id);
  const v = {
    state_id: c.state_id, definition, scenarios: c.scenarios.join(', '),
    state_demand: sd ? mdTable(sd) : 'なし(基本の状態。vocab.initial_state_set)',
    established_check_idea: sd?.['established check の案'] || 'なし(自分で決める)',
    kb_pages: list(kbPages(root, c.state_id)),
    rebuild: 'なし',
  };
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
function stopOutput(q, c) {
  return {
    state: 'STOP', flow: q.flow_id, card: c.id, kind: c.kind, state_id: c.state_id ?? null, target: targetOf(c),
    code: c.stop?.code ?? null, reason: c.stop?.reason ?? '',
    message: `カード ${c.id}(${c.kind} / ${targetOf(c)})は人間の確認待ちです: ${c.stop?.reason ?? ''}。利用者にこの文を伝えて指示を待つ。`
      + `利用者が続けてよいと答えたら ${PMS} next --flow ${q.flow_id} で残りのカードを続ける(人間がカードをやり直させるときは ${PMS} reopen --flow ${q.flow_id} --card ${c.id})`,
    remaining: q.cards.filter((x) => x.status === 'pending' || x.status === 'issued').length,
    next: `${PMS} next --flow ${q.flow_id}`,
  };
}

/** カードを STOP(人間の確認待ち)にする。code は vocab.pms_stop_reason */
export function stopCard(q, c, reason, code = 'cannot_proceed', extra = {}) {
  c.status = 'stopped';
  c.stop = { code, reason, at: timestamp(), reported: false, ...extra };
  q.history.push({ at: c.stop.at, card: c.id, event: 'stopped', code, reason });
}

/** カードを skipped(pms が記録だけを書き、AIに出さない)にする */
export function skipCard(q, c, reason) {
  c.status = 'skipped';
  c.skipped = { reason, at: timestamp() };
  q.history.push({ at: c.skipped.at, card: c.id, event: 'skipped', reason });
}

function runner() { return process.env.PMS_RUNNER || 'b1'; }

function issue(ctx, q, c, reissue, brief) {
  if (!reissue) {
    c.status = 'issued';
    c.issued_count = 1;
  } else c.issued_count++;
  c.issued_at = timestamp();
  q.history.push({ at: c.issued_at, card: c.id, event: reissue ? 'reissued' : 'issued', runner: runner() });
  const body = renderCard(ctx, q, c, reissue);
  ctx.store.saveQueue(q);
  return { code: 0, out: cardOutput(ctx, q, c, brief ? null : body) };
}

/**
 * @param {{phases?: string[], brief?: boolean}} opts phases を渡すと、そのフェーズのカードだけを扱う(pms run --phase)。
 *   brief なら出力に本文(body)を載せない(B1 の入口のエージェントの会話にカードの本文を溜めないため。本文は card_file にある)
 * @returns {{out: object, code: number}} code 0 = カード / done、3 = STOP
 */
export function nextCard(ctx, flow, { phases = null, brief = false } = {}) {
  const { store, cfg } = ctx;
  const q = store.loadQueue(flow);
  const inScope = (c) => !phases || phases.includes(phaseOf(c));
  if (phases) {
    const earlier = q.cards.filter((c) => !inScope(c) && !isDone(c) && PHASES.indexOf(phaseOf(c)) < Math.min(...phases.map((p) => PHASES.indexOf(p))));
    if (earlier.length) throw new UsageError(`フェーズ${phaseOf(earlier[0])}のカードが残っています(${earlier.map((c) => c.id).join(', ')})。--phase ${phaseOf(earlier[0])} か all で先に行う`);
  }
  const issued = q.cards.find((c) => c.status === 'issued' && inScope(c));
  if (issued) {
    if (issued.issued_count >= cfg.max_issues) {
      stopCard(q, issued, `出した回数が上限(${cfg.max_issues} 回。config/pms.json の max_issues)に達したが、合格した提出がない`, 'issue_limit');
      chainStop(q, issued);
    } else {
      return issue(ctx, q, issued, true, brief);
    }
  }
  for (;;) {
    const stopped = q.cards.find((c) => c.status === 'stopped' && !c.stop?.reported && inScope(c));
    if (stopped) {
      stopped.stop.reported = true;
      store.saveQueue(q);
      return { code: 3, out: stopOutput(q, stopped) };
    }
    const pending = q.cards.filter((c) => c.status === 'pending' && inScope(c)).sort(cardOrder)[0];
    if (!pending) break;
    // 探索のカードは、出す前に前提状態と前のステップを確かめる(blocked なら pms が記録だけを書く)
    const prep = pending.kind.startsWith('explore.') || pending.kind === 'report.findings' ? prepareExplore(ctx, q, pending) : 'issue';
    if (prep === 'issue') return issue(ctx, q, pending, false, brief);
    // skipped・stopped になった。続けて次を見る
  }
  store.saveQueue(q);
  const scope = q.cards.filter(inScope);
  const st = scope.filter((c) => c.status === 'stopped').map((c) => ({ card: c.id, kind: c.kind, target: targetOf(c), code: c.stop?.code ?? null, reason: c.stop?.reason ?? '' }));
  const hasC = scope.some((c) => phaseOf(c) === 'C');
  return {
    code: 0,
    out: {
      state: 'done', flow: q.flow_id, phase: q.phase,
      passed: scope.filter((c) => c.status === 'passed').length,
      skipped: scope.filter((c) => c.status === 'skipped').length,
      stopped: st,
      message: (hasC ? 'カードはすべて終わった' : 'フェーズAのカードはすべて終わった')
        + (st.length ? `(人間の確認待ち ${st.length} 枚: ${st.map((x) => x.card).join(', ')}。報告書の固有セクション1に書く)` : '')
        + (hasC ? `。${PMS} report --flow ${q.flow_id} で報告書と status.yaml を作る` : '。探索(パートC)へ進む'),
      next: hasC ? `${PMS} report --flow ${q.flow_id}` : null,
    },
  };
}

/** 探索のステップのカードが STOP になったら、同じシナリオの後続のステップも人間の確認待ちにする(前のステップの結果を引き継ぐため) */
export function chainStop(q, c) {
  if (c.kind !== 'explore.step') return;
  for (const x of q.cards) {
    if (x.kind === 'explore.step' && x.round === c.round && x.scenario === c.scenario && Number(x.id.slice(2)) > Number(c.id.slice(2)) && x.status === 'pending') {
      stopCard(q, x, `前のステップ ${c.step_id}(${c.id})が人間の確認待ちのため`, c.stop?.code ?? 'cannot_proceed', { chained_from: c.id });
      x.stop.reported = true; // 伝えるのは元のカードの1回だけ
    }
  }
}

export function nextCommand(q, c, paths) {
  return ACT_KINDS.has(c.kind) ? `${PMS} act --flow ${q.flow_id} --card ${c.id} snapshot` : submitCommand(q, c, paths);
}

function cardOutput(ctx, q, c, body) {
  const cardFile = ctx.paths.card(q.flow_id, c.id);
  return {
    state: 'card', flow: q.flow_id, card: c.id, kind: c.kind, state_id: c.state_id ?? null, target: targetOf(c), issued_count: c.issued_count,
    card_file: cardFile, out_file: ctx.paths.out(q.flow_id, c.id),
    // B1: 入口のエージェント pms-runner は、agent のサブエージェントに prompt をそのまま渡す(対応表を覚えなくてよいように)
    agent: cardType(ctx, c.kind).agent,
    prompt: promptOf(q.flow_id, c.id, cardFile),
    now: { flow: q.flow_id, card: c.id, kind: c.kind, state_id: c.state_id ?? null, target: targetOf(c), todo: todoOf(c) },
    ...(body == null ? {} : { body }),
    next: nextCommand(q, c, ctx.paths),
  };
}

/** パートCのカードが全部終わったのに、そのあとで報告書を作っていない(B1 では pms run の代わりに入口 skill が pms report を実行する) */
function reportPending(q) {
  if (!q.cards.some((c) => phaseOf(c) === 'C') || q.cards.some((c) => !isDone(c))) return false;
  const lastReport = q.history.findLastIndex((h) => h.event === 'report');
  const lastCard = q.history.findLastIndex((h) => h.card);
  return lastReport < lastCard;
}

export function statusOf(ctx, flow) {
  const q = ctx.store.loadQueue(flow);
  const count = (s) => q.cards.filter((c) => c.status === s).length;
  const cur = q.cards.find((c) => c.status === 'issued');
  const byPhase = {};
  for (const p of PHASES) {
    const cs = q.cards.filter((c) => phaseOf(c) === p);
    if (cs.length) byPhase[p] = { cards: cs.length, open: cs.filter((c) => !isDone(c)).length };
  }
  return {
    flow: q.flow_id, phase: q.phase, procedure_version: q.procedure_version,
    cards: q.cards.length,
    counts: { pending: count('pending'), issued: count('issued'), passed: count('passed'), stopped: count('stopped'), skipped: count('skipped') },
    phases: byPhase,
    rounds: (q.rounds ?? []).map((r) => ({ round: r.round, scenarios: r.scenarios, recheck_of: r.recheck_of ?? null, reexplore_of: r.reexplore_of ?? null })),
    current: cur ? { card: cur.id, kind: cur.kind, state_id: cur.state_id ?? null, target: targetOf(cur), issued_count: cur.issued_count, rejections: cur.rejections, todo: todoOf(cur) } : null,
    stopped: q.cards.filter((c) => c.status === 'stopped').map((c) => ({ card: c.id, kind: c.kind, state_id: c.state_id ?? null, target: targetOf(c), code: c.stop?.code ?? null, reason: c.stop?.reason ?? '' })),
    auto: q.auto, warnings: q.warnings,
    complete: count('pending') + count('issued') === 0,
    report_pending: reportPending(q),
    next: cur ? nextCommand(q, cur, ctx.paths) : count('pending') ? `${PMS} next --flow ${flow}` : null,
  };
}

/** 人間の操作: STOP のカードを出す前に戻す(出した回数・不合格の回数を 0 に戻す)。続けて止めた後続のステップも戻す */
export function reopenCard(ctx, flow, id) {
  const q = ctx.store.loadQueue(flow);
  const c = ctx.store.card(q, id);
  if (c.status !== 'stopped') throw new UsageError(`${id} は STOP(stopped)ではありません(状態 ${c.status})`);
  const reopened = [];
  for (const x of [c, ...q.cards.filter((y) => y.status === 'stopped' && y.stop?.chained_from === id)]) {
    x.status = 'pending';
    x.issued_count = 0;
    x.rejections = 0;
    q.history.push({ at: timestamp(), card: x.id, event: 'reopened', previous_stop: x.stop });
    delete x.stop;
    reopened.push(x.id);
  }
  ctx.store.saveQueue(q);
  return { ok: true, flow, card: id, reopened, status: 'pending', next: `${PMS} next --flow ${flow}` };
}
