// submit.mjs — pms submit: AI の出力(JSON)を検査し、合格なら記録(setup-log・台帳)を書く

import fs from 'node:fs';
import path from 'node:path';
import { validate } from './schema.mjs';
import { FIX, stringFields, vagueWords, normLocator, codeGroup, lintEntry, leakedSecrets } from './checks.mjs';
import { readAllEntries, findEntry } from './setup-log.mjs';
import { appendHandoff, peekHandoffId, recordExtDemand, markStateProvisioned, stateDemandRow } from './ledgers.mjs';
import { PMS, writeSetup, stopCard, chainStop, fixtureFile, LOGIN_STATES, READINESS_TEST, submitCommand, targetOf } from './queue.mjs';
import { checkStep, checkClose, checkSessionClose, checkFindings } from './explore.mjs';
import { secretsToMask } from './store.mjs';
import { readText, timestamp, today, UsageError, TIMESTAMP_RE, blank } from './util.mjs';

// 記録の操作(vocab.pms_act_action)→ setup-log の steps[].action
function stepActionMap(proc) {
  const out = new Map();
  for (const [k, v] of Object.entries(proc.vocab.pms_act_action ?? {})) if (v && typeof v === 'object' && v.step) out.set(k, v.step);
  return out;
}

/** 記録1行 → setup-log の step(付録B) */
export function stepOf(rec, map) {
  const action = map.get(rec.action);
  if (action === 'goto') return { action, detail: rec.value };
  if (action === 'external') return { action, operation_id: rec.operation_id };
  const s = { action, locator: rec.locator };
  if (rec.value != null) s.value = rec.value;
  return s;
}

const COND = { visible: 'が表示される', hidden: 'が表示されない', text: 'に文言が表示される' };
export function establishedCheckOf(rec) {
  const a = rec.assert ?? {};
  return a.condition === 'text' ? `${rec.locator} に「${a.text}」が表示される` : `${rec.locator} ${COND[a.condition] ?? ''}`.trim();
}

// あいまい語を見ない欄(コマンド・所在・時刻・SQL・観測した値そのもの)
export const SKIP_STRINGS = new Set(['command', 'flow', 'fixture', 'started_at', 'ended_at', 'observed_at', 'query', 'result', 'path', 'location', 'value', 'carried_data', 'catalog_id', 'condition']);

/**
 * @returns {{ code: number, out: object }} 0 = 合格(cannot_proceed の受け付けを含む)/ 1 = 不合格
 */
export function submit(ctx, opt) {
  const { root, paths, store, proc, cfg } = ctx;
  const q = store.loadQueue(opt.flow);
  if (!opt.card) throw new UsageError('--card がありません');
  const c = store.card(q, opt.card);
  if (c.status === 'passed') throw new UsageError(`${c.id} は合格済みです。${PMS} next --flow ${q.flow_id} で次のカードを出す`);
  if (c.status === 'stopped') throw new UsageError(`${c.id} は人間の確認待ち(STOP)です。${PMS} next --flow ${q.flow_id} を実行する`);
  if (c.status !== 'issued') throw new UsageError(`${c.id} はまだ出していません。${PMS} next --flow ${q.flow_id} を実行する`);
  const fileRel = opt.file ?? paths.out(q.flow_id, c.id);

  const failures = [];
  const fail = (category, message) => failures.push({ category, message, fix: FIX[category] });
  let out = null;
  const abs = path.isAbsolute(fileRel) ? fileRel : path.join(root, fileRel);
  if (!fs.existsSync(abs)) fail('schema', `出力のファイル ${fileRel} がありません(カードの「出力」の形の JSON を書いてから提出する)`);
  else {
    try { out = JSON.parse(readText(abs)); } catch (e) { fail('schema', `出力のファイル ${fileRel} が JSON として読めません — ${e.message}`); }
  }

  let plan = null; // 合格したときに行うこと
  if (out !== null) {
    for (const v of validate(proc.schema(c.kind), out, proc.vocab)) {
      fail(/短すぎ|長すぎ/.test(v.message) ? 'red_flag' : 'schema', `${v.path}: ${v.message}`);
    }
    if (!failures.some((f) => f.category === 'schema')) {
      // あいまい語(MAKER の red-flagging)
      const words = proc.values('pms_vague_words');
      for (const s of stringFields(out, SKIP_STRINGS)) {
        const hits = vagueWords(s.value, words);
        if (hits.length) fail('red_flag', `${s.path} にあいまいな語(${hits.join('・')})があります: 「${s.value.slice(0, 80)}」`);
      }
      const check = {
        'setup.build': checkBuild, 'setup.reuse': checkReuse, 'setup.code': checkCode,
        'explore.step': checkStep, 'explore.close': checkClose, 'explore.session_close': checkSessionClose, 'report.findings': checkFindings,
      }[c.kind];
      plan = check(ctx, q, c, out, fail, failures);
    }
  }

  c.submits = (c.submits ?? 0) + 1;
  const ok = failures.length === 0;
  store.appendSubmit(q.flow_id, {
    at: timestamp(), card: c.id, kind: c.kind, state_id: c.state_id ?? null, target: targetOf(c), attempt: c.submits, issued_count: c.issued_count,
    ok, result: out?.result ?? null, categories: [...new Set(failures.map((f) => f.category))], runner: process.env.PMS_RUNNER || 'b1',
  });

  if (!ok) {
    c.rejections = (c.rejections ?? 0) + 1;
    let stopped = false;
    if (c.rejections >= cfg.max_rejections) {
      stopCard(q, c, `提出の不合格が上限(${cfg.max_rejections} 回。config/pms.json の max_rejections)に達した。最後の不合格: ${failures.map((f) => f.category).join(', ')}`, 'reject_limit');
      chainStop(q, c);
      stopped = true;
    }
    store.saveQueue(q);
    return {
      code: 1,
      out: {
        ok: false, card: c.id, attempt: c.submits, rejections: c.rejections, stopped, failures,
        next: stopped ? `${PMS} next --flow ${q.flow_id}` : submitCommand(q, c, paths),
        hint: stopped ? 'このカードは人間の確認待ちになった。pms next を実行する' : '理由に挙がったところだけを直して、もう一度提出する',
      },
    };
  }

  const wrote = plan ? plan() : [];
  if (c.status === 'issued') {
    c.status = 'passed';
    c.passed_at = timestamp();
    c.result = out.result;
    q.history.push({ at: c.passed_at, card: c.id, event: 'passed', result: out.result });
  }
  store.saveQueue(q);
  return {
    code: 0,
    out: {
      ok: true, card: c.id, result: out.result, status: c.status, wrote,
      next: `${PMS} next --flow ${q.flow_id}`,
      hint: c.status === 'stopped' ? 'cannot_proceed を受け付けた。カードは人間の確認待ちになった' : '合格した。次のカードを出す',
    },
  };
}

// ════════════════════════════════════════════════════════
// setup.build
// ════════════════════════════════════════════════════════
function checkBuild(ctx, q, c, out, fail, failures) {
  const { root, paths, store, proc } = ctx;
  if (out.result === 'cannot_proceed') return () => { stopCard(q, c, `cannot_proceed: ${out.notes}`, 'cannot_proceed'); return []; };

  if (out.result === 'blocked') {
    const b = out.blocked;
    if (b.reason === '禁止操作' && !/^(PROH-\d{3}|包括原則[1-4])$/.test(String(b.ref ?? ''))) fail('red_flag', 'blocked.reason が 禁止操作 なのに、blocked.ref に禁止ID(PROH-<3桁>)か包括原則の番号(包括原則1〜4)がありません');
    if (b.reason === '操作手段なし' && !b.ext_demand) fail('red_flag', 'blocked.reason が 操作手段なし なのに、blocked.ext_demand(外部操作需要リストに書く項目)がありません');
    return () => writeBlocked(ctx, q, c, b);
  }

  // built
  const acts = store.actRecords(q);
  const bySeq = new Map(acts.map((a) => [a.seq, a]));
  const map = stepActionMap(proc);
  let prev = 0;
  const recs = [];
  for (const s of out.seqs) {
    const r = bySeq.get(s);
    if (!r) { fail('seq_missing', `連番 ${s} の操作の記録がありません(pms act を通さない操作は記録に残らない)`); continue; }
    if (r.card !== c.id) { fail('seq_missing', `連番 ${s} は別のカード ${r.card} の操作です`); continue; }
    if (!r.ok) fail('seq_missing', `連番 ${s} は失敗した操作です(${r.error ?? ''})`);
    if (!map.has(r.action)) fail('seq_missing', `連番 ${s} は ${r.action} です(状態を作る操作ではない。snapshot・assert は seqs に入れない)`);
    if (s <= prev) fail('seq_missing', `seqs が増える順になっていません(${prev} のあとに ${s})`);
    prev = Math.max(prev, s);
    recs.push(r);
  }
  for (const f of out.fragile ?? []) if (!out.seqs.includes(f.seq)) fail('seq_missing', `fragile の連番 ${f.seq} が seqs にありません`);
  const est = bySeq.get(out.established_check_seq);
  if (!est) fail('seq_missing', `established_check_seq ${out.established_check_seq} の記録がありません`);
  else {
    if (est.card !== c.id) fail('seq_missing', `established_check_seq ${est.seq} は別のカード ${est.card} の操作です`);
    if (est.action !== 'assert') fail('seq_missing', `established_check_seq ${est.seq} は assert ではありません(${est.action})`);
    else if (!est.ok) fail('seq_missing', `established_check_seq ${est.seq} の assert は条件を満たしていません`);
    if (out.seqs.length && est.seq < Math.max(...out.seqs)) fail('seq_missing', `established_check_seq ${est.seq} が最後の操作 ${Math.max(...out.seqs)} より前です(状態を作ったあとに確かめる)`);
  }

  // 安定ロケータ
  const testid = fs.existsSync(paths.abs(paths.testidRequests())) ? readText(paths.abs(paths.testidRequests())) : '';
  const checkLoc = (r, label) => {
    if (!r.locator) return;
    if (r.locator_class === 'css') {
      const fr = (out.fragile ?? []).find((f) => f.seq === r.seq);
      const inner = r.locator.match(/locator\((['"`])(.*?)\1/)?.[2];
      if (!fr) fail('unstable_locator', `${label} ${r.seq} のロケータ ${r.locator} は安定でない(CSS・構造)のに、fragile に挙がっていません`);
      else if (!testid.includes(r.locator) && !(inner && testid.includes(inner))) fail('unstable_locator', `${label} ${r.seq} の暫定セレクタが ${paths.testidRequests()} にありません`);
    }
    if (r.unique !== true) fail('unstable_locator', `${label} ${r.seq} のロケータ ${r.locator} は一意に1要素へ解決されません`);
  };
  recs.forEach((r) => checkLoc(r, '連番'));
  if (est && est.card === c.id) checkLoc(est, 'established_check_seq');

  // 書く予定の setup-log のエントリと lint
  const rebuildNote = c.rebuild?.reason === 'broken' ? `既存の fixture ${c.rebuild.fixture}(${c.rebuild.flow_id})で状態が成立しなかったため作り直した`
    : c.rebuild ? `過去の記録(${c.rebuild.flow_id})に操作列か安定ロケータがないため記録を取り直した` : null;
  const steps = recs.map((r) => {
    const s = stepOf(r, map);
    const fr = (out.fragile ?? []).find((f) => f.seq === r.seq);
    if (fr) s.fragile = fr.reason;
    return s;
  });
  const entry = {
    state_id: c.state_id, classification: 'built-by-ui', flow: '', fixture: '', steps,
    established_check: est ? establishedCheckOf(est) : '',
    verified: false, cleanup: '',
    act: { card: c.id, seqs: out.seqs, established_check_seq: out.established_check_seq },
    notes: [out.notes, rebuildNote].filter(Boolean).join(' / '),
  };
  const rel = paths.setupLog(c.feature);
  // lint は、ほかの検査に合格したときだけ当てる(連番の誤りのまま当てると、同じ原因の指摘が重なる)
  const before = failures.length;
  if (before === 0) for (const m of lintEntry({ feature: c.feature, flow: q.flow_id, version: proc.version, entry, file: rel })) fail('lint', m);
  const leaked = leakedSecrets(JSON.stringify(entry), secretsToMask(root));
  if (leaked.length) fail('lint', `書く予定の内容に秘密情報の値があります(env_value_leak。キー ${leaked.join(', ')})`);

  return () => {
    writeSetup(ctx, c.feature, q.flow_id, entry);
    // 続く setup.code のカード
    const code = { id: store.nextCardId(q), phase: 'A', kind: 'setup.code', state_id: c.state_id, feature: c.feature, scenarios: c.scenarios, status: 'pending', issued_count: 0, rejections: 0, created_at: timestamp(), build_card: c.id };
    if (c.rebuild) code.rebuild = c.rebuild;
    q.cards.push(code);
    return [rel, `${paths.queue(q.flow_id)}(${code.id} setup.code を追加)`];
  };
}

function writeBlocked(ctx, q, c, b) {
  const { root, paths, proc } = ctx;
  const date = today();
  const wrote = [];
  const handoffId = peekHandoffId(root, c.feature);
  let ext = null;
  if (b.reason === '操作手段なし' && b.ext_demand) {
    const e = b.ext_demand;
    ext = recordExtDemand(root, {
      operation: e.operation, target: e.target, gap: e.gap, requester: handoffId,
      alternative: e.alternative, prohibition: e.prohibition, date,
    });
    wrote.push(`${paths.extDemand()}(${ext.id}${ext.appended ? ' に要求元を追記' : ' を追加'})`);
  }
  const means = ext ? ext.id : b.reason === '禁止操作' ? b.ref : (b.ref ?? '');
  const id = appendHandoff(root, {
    feature: c.feature,
    target: `前提状態 ${c.state_id} の整備: ${b.detail}`,
    reason: b.reason, dest: proc.vocab.reason_code?.[b.reason]?.default_dest ?? '',
    means, origin: `${q.flow_id} / 作業10 / ${c.state_id}(${c.scenarios.join(', ')})`, date,
  });
  if (id !== handoffId) throw new Error(`申し送りIDの採番が食い違いました(${handoffId} / ${id})`);
  wrote.push(`${paths.handoff()}(${id})`);
  const blockedBy = { reason: b.reason, handoff: id };
  if (ext) blockedBy.ext_demand = ext.id;
  if (b.reason === '禁止操作') blockedBy.prohibition = b.ref;
  else if (!ext && !blank(b.ref)) blockedBy.ref = b.ref;
  wrote.push(writeSetup(ctx, c.feature, q.flow_id, { state_id: c.state_id, classification: 'blocked', blocked_by: blockedBy, notes: b.detail }));
  // pms report が status.yaml の ext_demand_added・ext_demand_appended に数える
  c.track = { handoffs: [id], signals: [], discrepancies: [], ext_added: ext && !ext.appended ? [ext.id] : [], ext_appended: ext?.appended ? [ext.id] : [], ops_registered: [] };
  return wrote;
}

// ════════════════════════════════════════════════════════
// setup.reuse
// ════════════════════════════════════════════════════════
function checkRuns(c, out, n, fail) {
  if (!Array.isArray(out.runs) || out.runs.length !== n) { fail('runs', `runs は ${n} 回分(${n} 個)を書く(今は ${out.runs?.length ?? 0} 個)`); return false; }
  for (const [i, r] of out.runs.entries()) {
    if (!TIMESTAMP_RE.test(r.started_at) || !TIMESTAMP_RE.test(r.ended_at)) fail('runs', `runs[${i}] の started_at・ended_at が vocab.timestamp_format に合いません`);
    else if (c.issued_at && new Date(r.started_at) < new Date(c.issued_at)) fail('red_flag', `runs[${i}] の started_at(${r.started_at})がカードを出した時刻(${c.issued_at})より前です(このカードで実行した結果を書く)`);
  }
  return true;
}

function checkReuse(ctx, q, c, out, fail) {
  const { root, paths, store } = ctx;
  if (out.result === 'cannot_proceed') return () => { stopCard(q, c, `cannot_proceed: ${out.notes}`, 'cannot_proceed'); return []; };
  const src = c.reuse;
  const entry = findEntry(paths.abs(src.setup_log), src.setup_log, src.flow_id, c.state_id);
  if (!entry) fail('reuse_source', `流用元 ${src.flow_id} の ${c.state_id} のエントリが ${src.setup_log} にありません`);
  else if (!fixtureFile(root, entry.fixture)) fail('reuse_source', `流用元の fixture ${entry.fixture} のファイルがありません`);
  if (checkRuns(c, out, 1, fail)) {
    const code = out.runs[0].exit_code;
    if (out.result === 'reused' && code !== 0) fail('runs', `result が reused なのに、実行の終了コードが ${code} です(成立しなければ broken)`);
    if (out.result === 'broken' && code === 0) fail('runs', 'result が broken なのに、実行の終了コードが 0 です(成立したなら reused)');
  }
  if (!entry) return null;

  if (out.result === 'broken') {
    return () => {
      const b = {
        id: store.nextCardId(q), phase: 'A', kind: 'setup.build', state_id: c.state_id, feature: c.feature, scenarios: c.scenarios,
        status: 'pending', issued_count: 0, rejections: 0, created_at: timestamp(),
        rebuild: { reason: 'broken', flow_id: src.flow_id, fixture: entry.fixture ?? null, flow: entry.flow ?? null, reuse_card: c.id },
      };
      q.cards.push(b);
      return [`${paths.queue(q.flow_id)}(${b.id} 作り直しの setup.build を追加)`];
    };
  }
  return () => {
    const e = {
      state_id: c.state_id, classification: 'provided', flow: entry.flow ?? '', fixture: entry.fixture ?? '',
      steps: entry.steps, established_check: entry.established_check ?? '', verified: true,
      cleanup: entry.cleanup ?? '', reused_from: { flow_id: src.flow_id, feature_code: src.feature },
      notes: out.notes ?? '',
    };
    const wrote = [writeSetup(ctx, c.feature, q.flow_id, e)];
    const sd = markStateProvisioned(root, c.state_id, entry.fixture);
    if (sd) { c.provisioned = sd; wrote.push(`${paths.stateDemand()}(${sd} を 整備済)`); }
    return wrote;
  };
}

// ════════════════════════════════════════════════════════
// setup.code
// ════════════════════════════════════════════════════════
function checkCode(ctx, q, c, out, fail) {
  const { root, paths, store } = ctx;
  if (out.result === 'cannot_proceed') return () => { stopCard(q, c, `cannot_proceed: ${out.notes}`, 'cannot_proceed'); return []; };
  const rel = paths.setupLog(c.feature);
  const entry = findEntry(paths.abs(rel), rel, q.flow_id, c.state_id);
  if (!entry) { fail('code_mismatch', `${rel} に ${q.flow_id} の ${c.state_id} のエントリがありません`); return null; }

  const target = (spec, what) => {
    const [p, sym] = String(spec).split('#');
    const file = 'tests/' + p.replace(/^\.?\/?(tests\/)?/, '');
    if (!fs.existsSync(path.join(root, file))) { fail('code_mismatch', `${what} ${spec} のファイル ${file} がありません`); return null; }
    if (!new RegExp(`\\b${sym.replace(/[^\w$]/g, '')}\\b`).test(readText(path.join(root, file)))) fail('code_mismatch', `${what} の ${sym} が ${file} に見つかりません`);
    return file;
  };
  const flowFile = target(out.flow, 'シナリオ部品');
  const fxFile = target(out.fixture, 'fixture');
  if (c.rebuild) {
    if (c.rebuild.fixture && out.fixture !== c.rebuild.fixture) fail('code_mismatch', `作り直しでは fixture を同じ名前のまま直す(${c.rebuild.fixture}。出力は ${out.fixture})`);
    if (c.rebuild.flow && out.flow !== c.rebuild.flow) fail('code_mismatch', `作り直しでは部品を同じ名前のまま直す(${c.rebuild.flow}。出力は ${out.flow})`);
  }
  if (flowFile && fxFile) {
    const group = codeGroup(root, [flowFile, fxFile]);
    const all = normLocator([...group.values()].join('\n'));
    const flowText = normLocator(group.get(flowFile) ?? '');
    let pos = 0;
    let ordered = true;
    for (const [i, s] of (entry.steps ?? []).entries()) {
      if (!s.locator) continue;
      const loc = normLocator(s.locator);
      if (!all.includes(loc)) { fail('code_mismatch', `setup-log の steps[${i}] のロケータ ${s.locator} が部品・fixture のコード(${[...group.keys()].join(', ')})にありません`); continue; }
      const at = flowText.indexOf(loc, pos);
      if (at < 0) ordered = false; else pos = at;
    }
    void ordered; // 部品がページオブジェクトを呼ぶときは、部品のファイルの中の順は確かめられない
    const est = store.actRecords(q).find((a) => a.seq === entry.act?.established_check_seq);
    if (est?.locator && !all.includes(normLocator(est.locator))) fail('code_mismatch', `established check のロケータ ${est.locator} が fixture・部品のコードにありません(fixture に established check を実装する)`);
  }
  if (LOGIN_STATES.has(c.state_id) && !fs.existsSync(path.join(root, READINESS_TEST))) fail('code_mismatch', `ログイン状態を整備したのに、起動確認テスト ${READINESS_TEST} がありません`);
  if (checkRuns(c, out, 2, fail) === false) return null;

  return () => {
    const verified = out.runs.every((r) => r.exit_code === 0);
    const e = { ...entry, flow: out.flow, fixture: out.fixture, verified, cleanup: out.cleanup };
    if (!verified) e.notes = [entry.notes, '2回の実行のどちらかが失敗した(verified: false。作業20の最初の確認対象)'].filter(Boolean).join(' / ');
    if (out.notes) e.notes = [e.notes, out.notes].filter(Boolean).join(' / ');
    const wrote = [writeSetup(ctx, c.feature, q.flow_id, e)];
    if (verified) {
      const sd = markStateProvisioned(root, c.state_id, out.fixture);
      if (sd) { c.provisioned = sd; wrote.push(`${paths.stateDemand()}(${sd} を 整備済)`); }
    } else if (stateDemandRow(root, c.state_id)) {
      wrote.push(`${paths.stateDemand()}(確認できなかったため 採用 のまま)`);
    }
    return wrote;
  };
}

export { readAllEntries };
