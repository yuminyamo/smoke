// exploration.mjs — 探索記録・セットアップ記録の検査
//   requires_covered / blocked_recorded / verdict_enum / no_temp_locator

import fs from 'node:fs';

const JUDGED = ['passed', 'failed', 'human-check'];
const FOLLOWS_BLOCKED = '前ステップが blocked';
// fixture で作らない状態(ゴールデンイメージの復元そのもの)。作業20の fixture の検査から外す
const NO_FIXTURE_STATES = new Set(['S-CLEAN-ENV']);

function stepsOf(sc) {
  return Array.isArray(sc.steps) ? sc.steps.filter((s) => s && typeof s === 'object') : [];
}

function blank(v) {
  return v == null || String(v).trim() === '';
}

// ════════════════════════════════════════════════════════
// requires_covered
// ════════════════════════════════════════════════════════
export function requires_covered(repo) {
  const findings = [];
  const notes = [];
  const add = (file, message) => findings.push({ file, message });
  const defs = repo.scenarioDefs;

  // ── 作業10: 対象の全シナリオ(blocked を含む)の requires の全状態が、同じフローの setup-log にある
  if (repo.stage !== '20') {
    const byFlow = new Map(); // flow → Map<state, entry[]>
    for (const s of repo.setupEntries) {
      if (!s.flow) continue;
      if (!byFlow.has(s.flow)) byFlow.set(s.flow, new Map());
      const m = byFlow.get(s.flow);
      const id = s.e.state_id;
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(s);
    }
    for (const r of repo.latestRecords()) {
      const where = `${r.file}(${r.id ?? 'id なし'} / ${r.flow ?? 'フロー不明'})`;
      const def = r.id ? defs.get(r.id) : null;
      if (!def) { add(where, `scenarios.md にシナリオ ${r.id} の定義がないため、requires を確かめられません`); continue; }
      if (!def.requiresFound) { add(def.file, `${r.id} に requires の行がありません(付録C)`); continue; }
      if (blank(r.sc.requires_setup)) add(where, 'requires_setup がありません(blocked のシナリオでも前提状態の整備を記録する。付録A)');
      const states = byFlow.get(r.flow) ?? new Map();
      for (const st of def.requires) {
        const entries = states.get(st);
        if (!entries || entries.length === 0) {
          add(where, `requires の ${st} が ${r.flow} の setup-log にありません${r.sc.verdict === 'blocked' ? '(シナリオが blocked でも前提状態は整備して記録する。§10 フェーズA)' : ''}`);
          continue;
        }
        const e = entries[entries.length - 1];
        const cls = e.e.classification;
        if (cls === 'blocked') {
          if (r.sc.verdict !== 'blocked') add(where, `${st} は setup-log で blocked(整備不可)なのに、シナリオの判定が ${r.sc.verdict ?? 'なし'} です`);
        } else if (blank(e.e.established_check)) {
          add(e.file, `${st}(${r.flow})の setup-log に established_check がありません`);
        }
      }
    }
  }

  // ── 作業20: コード化した全シナリオの requires の全状態に、established check を持つ fixture がある
  const flows20 = new Set();
  if (repo.stage === '20' && repo.flow) flows20.add(repo.flow);
  else if (repo.stage !== '10') for (const s of repo.statusFor('20', repo.flow)) if (s.flow) flows20.add(s.flow);
  for (const f of [...flows20].sort()) {
    let codified = repo.matrixRows.filter((m) => m.obj['フロー'] === f && /✅/.test(m.obj['コード化'] ?? '')).map((m) => m.obj['シナリオID']);
    let source = '突合表';
    if (codified.length === 0) {
      codified = [...repo.statusFor('10', f), ...repo.statusFor('15', f)].flatMap((s) => s.data?.context_updates?.codeable_items ?? []);
      source = '作業10・15の codeable_items';
    }
    codified = [...new Set(codified.map((x) => String(x).replace(/`/g, '').trim()))];
    if (codified.length === 0) { notes.push(`${f}: コード化したシナリオが見つかりません(突合表・codeable_items とも空)`); continue; }
    notes.push(`${f}: コード化したシナリオ ${codified.length} 件(${source})の fixture を確認`);
    for (const id of codified) {
      const def = defs.get(id);
      if (!def) { add('traceability/', `${f} でコード化した ${id} の定義が scenarios.md にありません`); continue; }
      for (const st of def.requires) {
        if (NO_FIXTURE_STATES.has(st)) continue;
        const candidates = repo.setupEntries.filter((s) => s.e.state_id === st && s.e.classification !== 'blocked');
        if (candidates.length === 0) { add(def.file, `${id} の requires の ${st} を作るセットアップが setup-log にありません(コード化不能・要差し戻し)`); continue; }
        const withCheck = candidates.filter((s) => !blank(s.e.established_check));
        if (withCheck.length === 0) { add(candidates[candidates.length - 1].file, `${id} の requires の ${st} の setup-log に established_check がありません`); continue; }
        const e = withCheck[withCheck.length - 1];
        const fx = String(e.e.fixture ?? '').trim();
        if (fx === '') { add(e.file, `${id} の requires の ${st} の setup-log に fixture の記録がありません`); continue; }
        const [p, sym] = fx.split('#');
        const rel = 'tests/' + p.replace(/^\.?\/?(tests\/)?/, '');
        if (!repo.exists(rel)) { add(e.file, `${id} の requires の ${st} の fixture ${fx} のファイル ${rel} がありません`); continue; }
        if (sym && !new RegExp(`\\b${sym.replace(/[^\w$]/g, '')}\\b`).test(fs.readFileSync(repo.abs(rel), 'utf8'))) {
          add(rel, `${id} の requires の ${st} の fixture ${sym} が ${rel} に見つかりません`);
        }
      }
    }
  }
  return { findings, notes };
}

// ════════════════════════════════════════════════════════
// blocked_recorded
// ════════════════════════════════════════════════════════
export function blocked_recorded(repo) {
  const findings = [];
  const notes = [];
  const add = (file, message) => findings.push({ file, message });
  const reasonKeys = Object.keys(repo.vocab.reason_code ?? {});
  const defs = repo.scenarioDefs;
  const prohibitionSteps = new Map(); // `${flow}\0${dirFeature}` → Set<stepId>

  for (const r of repo.latestRecords()) {
    const where = `${r.file}(${r.id ?? 'id なし'} / ${r.flow ?? 'フロー不明'})`;
    const steps = stepsOf(r.sc);
    const byId = new Map(steps.map((s) => [s.step_id, s]));
    const def = r.id ? defs.get(r.id) : null;
    // ステップの順: scenarios.md の定義があればそれ、なければ記録の順
    const order = def && def.steps.length ? def.steps : steps.map((s) => s.step_id);
    const firstIdx = order.findIndex((id) => byId.get(id)?.verdict === 'blocked');

    if (r.sc.verdict === 'blocked' && firstIdx < 0) {
      add(where, 'シナリオが blocked なのに、blocked のステップ(blocked_by 付き)が記録されていません');
      continue;
    }
    if (firstIdx < 0) continue;

    // blocked のステップより前: 判定付きで記録されている
    for (const id of order.slice(0, firstIdx)) {
      const s = byId.get(id);
      if (!s) add(where, `blocked のステップ ${order[firstIdx]} より前の ${id} が記録されていません(実行できたところまでは探索して記録する)`);
      else if (!JUDGED.includes(String(s.verdict))) add(where, `blocked のステップより前の ${id} の判定が ${s.verdict ?? 'なし'} です(${JUDGED.join(' / ')} のいずれか)`);
    }

    // blocked のステップ
    let seenFull = false;
    for (let k = firstIdx; k < order.length; k++) {
      const id = order[k];
      const s = byId.get(id);
      if (!s) continue; // 後続の未記録は許す
      if (s.verdict !== 'blocked') {
        add(where, `${id} は blocked のステップ ${order[firstIdx]} より後なのに判定が ${s.verdict ?? 'なし'} です`);
        continue;
      }
      const b = s.blocked_by;
      if (!b || typeof b !== 'object') { add(where, `${id} に blocked_by がありません`); seenFull = true; continue; }
      const reason = String(b.reason ?? '').trim();
      if (reason === FOLLOWS_BLOCKED && seenFull) continue;
      if (reason === FOLLOWS_BLOCKED) { add(where, `最初の blocked のステップ ${id} の blocked_by.reason が「${FOLLOWS_BLOCKED}」です(理由コードを書く)`); seenFull = true; continue; }
      seenFull = true;
      if (!reasonKeys.includes(reason)) add(where, `${id} の blocked_by.reason「${reason || 'なし'}」が vocab.reason_code にありません`);
      const ids = order.concat(steps.map((x) => x.step_id));
      if (blank(b.resume_from)) add(where, `${id} の blocked_by に resume_from がありません`);
      else if (!ids.includes(String(b.resume_from))) add(where, `${id} の blocked_by.resume_from ${b.resume_from} がこのシナリオのステップではありません`);
      const needsHandoff = reason === '操作手段なし' || reason === '禁止操作';
      if (needsHandoff && !/^HO-[A-Za-z0-9]+-\d+$/.test(String(b.handoff ?? ''))) add(where, `${id} の blocked_by に申し送りID(handoff: HO-…)がありません`);
      if (!needsHandoff && blank(b.handoff) && blank(b.ext_demand) && blank(b.prohibition)) add(where, `${id} の blocked_by に参照(申し送りIDなど)がありません`);
      if (reason === '操作手段なし' && !/^EXT-\d{3}$/.test(String(b.ext_demand ?? ''))) add(where, `${id} の blocked_by に需要ID(ext_demand: EXT-<3桁>)がありません`);
      if (reason === '禁止操作') {
        if (!/^(PROH-\d{3}|包括原則[1-4])$/.test(String(b.prohibition ?? ''))) add(where, `${id} の blocked_by に禁止ID(prohibition: PROH-<3桁> または 包括原則<番号>)がありません`);
        const key = `${r.flow}\u0000${r.dirFeature}`;
        if (!prohibitionSteps.has(key)) prohibitionSteps.set(key, new Set());
        prohibitionSteps.get(key).add(id);
      }
    }
  }

  // 「禁止操作」で blocked にしたステップと、作業10の status.yaml の blocked_by_prohibition が一致すること
  const flowFeatures = new Set(repo.latestRecords().map((r) => `${r.flow}\u0000${r.dirFeature}`));
  for (const key of flowFeatures) {
    const [flow, fc] = key.split('\u0000');
    const rel = `work/${fc}/exploration/status.yaml`;
    const st = repo.statusFiles.find((s) => s.rel === rel);
    const logged = prohibitionSteps.get(key) ?? new Set();
    if (!st || !st.data || st.flow !== flow) {
      if (logged.size) notes.push(`${flow} / ${fc}: 作業10の status.yaml(${flow})がないため blocked_by_prohibition と突き合わせていません`);
      continue;
    }
    const listed = new Set((st.data.context_updates?.blocked_by_prohibition ?? []).map(String));
    for (const id of logged) if (!listed.has(id)) add(rel, `「禁止操作」で blocked にした ${id} が blocked_by_prohibition にありません(作業20の前の照合から漏れる)`);
    for (const id of listed) if (!logged.has(id)) add(rel, `blocked_by_prohibition の ${id} は、探索記録で「禁止操作」の blocked になっていません`);
  }
  return { findings, notes };
}

// ════════════════════════════════════════════════════════
// verdict_enum
// ════════════════════════════════════════════════════════
export function verdict_enum(repo) {
  const findings = [];
  const allowed = Object.keys(repo.vocab.verdict ?? {});
  for (const r of repo.explorationRecords) {
    if (!repo.inFlow(r.flow)) continue;
    const where = `${r.file}(${r.id ?? 'id なし'} / ${r.flow ?? 'フロー不明'})`;
    if (!allowed.includes(String(r.sc.verdict))) findings.push({ file: where, message: `シナリオの verdict「${r.sc.verdict ?? 'なし'}」が vocab.verdict(${allowed.join(' / ')})にありません` });
    for (const s of stepsOf(r.sc)) {
      if (!allowed.includes(String(s.verdict))) findings.push({ file: where, message: `${s.step_id ?? 'step_id なし'} の verdict「${s.verdict ?? 'なし'}」が vocab.verdict にありません` });
    }
  }
  return { findings };
}

// ════════════════════════════════════════════════════════
// no_temp_locator
// ════════════════════════════════════════════════════════
// playwright-cli の snapshot の要素参照(e15 など)。ref=e15 の形も含む
const TEMP_REF = /(?:^|[^\w$.\-])(?:(?:aria-)?ref\s*[=:]\s*)?e\d{1,6}(?![\w])/;

export function no_temp_locator(repo) {
  const findings = [];
  const check = (where, stepLabel, actions) => {
    for (const a of Array.isArray(actions) ? actions : []) {
      if (!a || typeof a !== 'object' || a.locator == null) continue;
      const loc = String(a.locator);
      if (TEMP_REF.test(loc)) findings.push({ file: where, message: `${stepLabel} の locator に snapshot の一時ID が含まれています: ${loc}` });
    }
  };
  for (const r of repo.explorationRecords) {
    if (!repo.inFlow(r.flow)) continue;
    const where = `${r.file}(${r.id ?? 'id なし'} / ${r.flow ?? 'フロー不明'})`;
    for (const s of stepsOf(r.sc)) check(where, s.step_id ?? 'ステップ', s.actions);
  }
  for (const s of repo.setupEntries) {
    if (!repo.inFlow(s.flow)) continue;
    check(`${s.file}(${s.e.state_id ?? 'state_id なし'} / ${s.flow ?? 'フロー不明'})`, s.e.state_id ?? 'セットアップ', s.e.steps);
  }
  return { findings };
}

// ════════════════════════════════════════════════════════
// health_recorded
// ════════════════════════════════════════════════════════
// 健全性シグナル(00 ■健全性シグナルと問い合わせ)の記録と、作業10・15の status.yaml との一致
const HEALTH_SINCE = 7; // proc-v007 で追加
const TIMESTAMP_SINCE = 14; // proc-v014 で追加(健全性シグナルのあるステップの started_at と observed_at。作業15がログを集める時間範囲に使う)
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function verNum(v) {
  const m = String(v ?? '').match(/^proc-v(\d{3})$/);
  return m ? Number(m[1]) : null;
}

function signalSteps(sc) {
  return stepsOf(sc).filter((s) => s.health_signal != null);
}

export function health_recorded(repo) {
  const findings = [];
  const notes = [];
  const add = (file, message) => findings.push({ file, message });
  const kinds = Object.keys(repo.vocab.health_signal_kind ?? {});
  const limit = Number(repo.vocab.default?.inquiry_limit ?? 3);

  // ── 記録そのもの(シナリオごとの最新の記録)
  for (const r of repo.latestRecords()) {
    const where = `${r.file}(${r.id ?? 'id なし'} / ${r.flow ?? 'フロー不明'})`;
    const sig = signalSteps(r.sc);
    for (const s of sig) {
      const hs = s.health_signal;
      const label = s.step_id ?? 'step_id なし';
      if (!hs || typeof hs !== 'object' || Array.isArray(hs)) add(where, `${label} の health_signal はマッピング(kind・detail)でなければなりません(付録A)`);
      else {
        if (!kinds.includes(String(hs.kind))) add(where, `${label} の health_signal.kind「${hs.kind ?? 'なし'}」が vocab.health_signal_kind(${kinds.join(' / ')})にありません`);
        if (blank(hs.detail)) add(where, `${label} の health_signal に detail(要点)がありません`);
      }
      if (s.verdict === 'passed') add(where, `${label} は健全性シグナルがあるのに判定が passed です(passed にせず human-check にする)`);
    }
    if (sig.length && r.sc.verdict === 'passed') add(where, '健全性シグナルのあるステップがあるのに、シナリオの判定が passed です');
    if (r.sc.health_fix != null) {
      const hf = r.sc.health_fix;
      if (sig.length) add(where, 'health_fix の付いた記録に health_signal があります(解消していない記録は追記しない)');
      if (!hf || typeof hf !== 'object' || Array.isArray(hf) || hf.inquiries == null || blank(hf.cause) || blank(hf.change)) {
        add(where, 'health_fix に inquiries・cause・change がありません(付録A)');
      } else if (Number(hf.inquiries) > limit) {
        add(where, `health_fix.inquiries が ${hf.inquiries} です(上限 ${limit} 回。vocab.default.inquiry_limit)`);
      }
    }
  }

  // ── 作業10・15の status.yaml との一致(機能ディレクトリ × フロー)
  const keys = new Set(repo.explorationRecords.filter((r) => repo.inFlow(r.flow)).map((r) => `${r.flow}\u0000${r.dirFeature}`));
  for (const key of [...keys].sort()) {
    const [flow, fc] = key.split('\u0000');
    const st10 = repo.statusFiles.find((s) => s.rel === `work/${fc}/exploration/status.yaml` && s.flow === flow && s.data);
    if (!st10) continue; // status_yaml_valid が扱う
    const ver = verNum(st10.data.procedure_version);
    if (ver !== null && ver < HEALTH_SINCE) continue;
    const cu10 = st10.data.context_updates ?? {};
    const rid = st10.data.env_restore?.restore_id ?? null;
    const st15 = repo.statusFiles.find((s) => s.rel === `work/${fc}/health/status.yaml` && s.flow === flow && s.data);
    const current15 = !!(st15 && rid && String(st15.data.stage10_restore_id ?? '') === String(rid));

    // 作業10が見た記録: 作業15がこの作業10のあとに追記した記録(health_fix)は除く
    const seen = new Map();
    for (const r of repo.explorationRecords) {
      if (r.flow !== flow || r.dirFeature !== fc) continue;
      if (current15 && r.sc.health_fix != null) continue;
      seen.set(r.id, r);
    }
    const logged = new Set([...seen.values()].filter((r) => signalSteps(r.sc).length > 0).map((r) => String(r.id)));
    const rel10 = st10.rel;
    const items = Array.isArray(cu10.health_signal_items) ? cu10.health_signal_items.map(String) : null;
    if (cu10.health_signal === 'found' && logged.size === 0) add(rel10, 'health_signal が found なのに、探索記録に健全性シグナルのあるシナリオがありません');
    if (cu10.health_signal === 'none' && logged.size > 0) add(rel10, `health_signal が none なのに、探索記録に健全性シグナルがあります(${[...logged].join(', ')})`);
    if (items) {
      for (const id of logged) if (!items.includes(id)) add(rel10, `健全性シグナルのある ${id} が health_signal_items にありません`);
      for (const id of items) if (!logged.has(id)) add(rel10, `health_signal_items の ${id} は、探索記録に健全性シグナルがありません`);
    }
    if (ver === null || ver >= TIMESTAMP_SINCE) {
      for (const r of seen.values()) {
        for (const s of signalSteps(r.sc)) {
          const where = `${r.file}(${r.id ?? 'id なし'} / ${flow})`;
          const label = s.step_id ?? 'step_id なし';
          if (!TIMESTAMP.test(String(s.started_at ?? ''))) add(where, `${label} に started_at がない、または書式(vocab.timestamp_format。例 2026-10-03T13:50:12+09:00)に合いません(作業15がログを集める時間範囲に使う)`);
          const obs = s.health_signal && typeof s.health_signal === 'object' ? s.health_signal.observed_at : null;
          if (!TIMESTAMP.test(String(obs ?? ''))) add(where, `${label} の health_signal に observed_at がない、または書式(vocab.timestamp_format)に合いません(作業15がログを集める時間範囲に使う)`);
        }
      }
    }

    if (!st15) continue;
    if (!current15) { notes.push(`${st15.rel}: stage10_restore_id が作業10の restore_id と違うため(前の作業10のあとの実施)、突き合わせていません`); continue; }
    const cu15 = st15.data.context_updates ?? {};
    const full = new Map();
    for (const r of repo.explorationRecords) if (r.flow === flow && r.dirFeature === fc) full.set(String(r.id), r);
    for (const id of (Array.isArray(cu15.codeable_items) ? cu15.codeable_items : []).map(String)) {
      const r = full.get(id);
      if (!r) add(st15.rel, `codeable_items の ${id} の探索記録がありません`);
      else if (r.sc.health_fix == null || r.sc.verdict !== 'passed') add(st15.rel, `codeable_items の ${id} の最新の記録が、health_fix の付いた passed ではありません`);
    }
    const ho = cu15.health_outcomes && typeof cu15.health_outcomes === 'object' ? Object.keys(cu15.health_outcomes).map(String) : null;
    if (ho && items) {
      for (const id of items) if (!ho.includes(id)) add(st15.rel, `作業10の health_signal_items の ${id} に、health_outcomes の結果がありません`);
      for (const id of ho) if (!items.includes(id)) add(st15.rel, `health_outcomes の ${id} は、作業10の health_signal_items にありません`);
    }
    for (const [id, v] of Object.entries(cu15.health_outcomes ?? {})) {
      const r = full.get(String(id));
      if (v === 'resolved' && !(r && r.sc.health_fix != null)) add(st15.rel, `${id} は resolved なのに、health_fix の付いた記録が追記されていません`);
      if (v !== 'resolved' && r && r.sc.health_fix != null) add(st15.rel, `${id} は ${v} なのに、health_fix の付いた記録があります`);
    }
    const inq = cu15.inquiries && typeof cu15.inquiries === 'object' ? cu15.inquiries : {};
    for (const [id, n] of Object.entries(inq)) {
      if (Number(n) > limit) add(st15.rel, `${id} の問い合わせが ${n} 回です(上限 ${limit} 回。vocab.default.inquiry_limit)`);
    }
  }
  return { findings, notes };
}
