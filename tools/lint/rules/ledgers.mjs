// ledgers.mjs — 台帳・KB との突き合わせ
//   reason_code_enum / ext_demand_linked / operation_registered

import { idsIn, sectionLines } from '../lib/markdown.mjs';

const FOLLOWS_BLOCKED = '前ステップが blocked';

function handoffInScope(repo, row) {
  if (!repo.flow) return true;
  return new RegExp(`\\b${repo.flow}\\b`).test(row.obj['発生元'] ?? '');
}

function blockedSteps(repo) {
  const out = [];
  for (const r of repo.latestRecords()) {
    for (const s of Array.isArray(r.sc.steps) ? r.sc.steps : []) {
      if (s && typeof s === 'object' && s.blocked_by && typeof s.blocked_by === 'object') {
        out.push({ where: `${r.file}(${r.id} / ${r.flow})`, step: s, b: s.blocked_by });
      }
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════
// reason_code_enum
// ════════════════════════════════════════════════════════
export function reason_code_enum(repo) {
  const findings = [];
  const allowed = Object.keys(repo.vocab.reason_code ?? {});
  const h = repo.handoffRows;
  for (const row of h.rows) {
    if (!handoffInScope(repo, row)) continue;
    const code = String(row.obj['理由コード'] ?? '').replace(/`/g, '').trim();
    if (!allowed.includes(code)) findings.push({ file: `${h.rel}:${row.line}`, message: `${row.obj['ID'] || '(ID なし)'} の理由コード「${code || '空欄'}」が vocab.reason_code にありません(自由記述禁止)` });
  }
  for (const x of blockedSteps(repo)) {
    const reason = String(x.b.reason ?? '').trim();
    if (reason !== FOLLOWS_BLOCKED && !allowed.includes(reason)) {
      findings.push({ file: x.where, message: `${x.step.step_id} の blocked_by.reason「${reason || 'なし'}」が vocab.reason_code にありません` });
    }
  }
  return { findings };
}

// ════════════════════════════════════════════════════════
// ext_demand_linked
// ════════════════════════════════════════════════════════
export function ext_demand_linked(repo) {
  const findings = [];
  const notes = [];
  const add = (file, message) => findings.push({ file, message });
  const d = repo.extDemandRows;
  const demandIds = new Set(d.rows.map((r) => String(r.obj['需要ID'] ?? '').trim()).filter(Boolean));
  const h = repo.handoffRows;
  const handoffById = new Map(h.rows.map((r) => [String(r.obj['ID'] ?? '').trim(), r]));
  if (!d.exists) notes.push(`${d.rel} がありません`);

  for (const row of h.rows) {
    if (!handoffInScope(repo, row)) continue;
    if (String(row.obj['理由コード'] ?? '').trim() !== '操作手段なし') continue;
    const where = `${h.rel}:${row.line}`;
    const ids = idsIn(row.obj['想定手段'], /EXT-\d{3}/g);
    if (ids.length === 0) { add(where, `${row.obj['ID']}(操作手段なし)の想定手段に需要ID(EXT-<3桁>)がありません`); continue; }
    for (const id of ids) if (!demandIds.has(id)) add(where, `${row.obj['ID']} が参照する ${id} が外部操作需要リストにありません`);
  }

  for (const x of blockedSteps(repo)) {
    if (String(x.b.reason ?? '').trim() !== '操作手段なし') continue;
    const ext = String(x.b.ext_demand ?? '').trim();
    if (!/^EXT-\d{3}$/.test(ext)) add(x.where, `${x.step.step_id}(操作手段なし)の blocked_by に需要ID(ext_demand)がありません`);
    else if (!demandIds.has(ext)) add(x.where, `${x.step.step_id} が参照する ${ext} が外部操作需要リストにありません`);
    const ho = String(x.b.handoff ?? '').trim();
    if (!ho) add(x.where, `${x.step.step_id}(操作手段なし)の blocked_by に申し送りID(handoff)がありません`);
    else if (!handoffById.has(ho)) add(x.where, `${x.step.step_id} が参照する ${ho} が申し送り台帳にありません`);
    else if (String(handoffById.get(ho).obj['理由コード'] ?? '').trim() !== '操作手段なし') add(x.where, `${x.step.step_id} が参照する ${ho} の理由コードが「操作手段なし」ではありません`);
  }
  return { findings, notes };
}

// ════════════════════════════════════════════════════════
// operation_registered
// ════════════════════════════════════════════════════════
export function operation_registered(repo) {
  const findings = [];
  const notes = [];
  const add = (file, message) => findings.push({ file, message });

  const used = new Map(); // opId → [where]
  for (const r of repo.latestRecords()) {
    for (const s of Array.isArray(r.sc.steps) ? r.sc.steps : []) {
      for (const a of Array.isArray(s?.actions) ? s.actions : []) {
        if (!a || typeof a !== 'object' || a.operation_id == null) continue;
        const id = String(a.operation_id).trim();
        if (!used.has(id)) used.set(id, []);
        used.get(id).push(`${r.file}(${s.step_id} / ${r.flow})`);
      }
    }
  }
  if (used.size === 0) return { findings, notes: ['外部操作を使ったステップはありません'] };

  const index = repo.kbOpsIndex;
  const proh = repo.prohibitedRows;
  const levelById = new Map(proh.rows.map((r) => [String(r.obj['禁止ID'] ?? '').trim(), String(r.obj['禁止レベル'] ?? '').trim()]));
  if (proh.state !== 'filled') notes.push(`禁止操作リストは ${proh.state}(禁止操作なしとして扱う)`);

  for (const [op, wheres] of [...used].sort()) {
    const where = wheres[0] + (wheres.length > 1 ? ` ほか ${wheres.length - 1} 件` : '');
    if (!/^OP-[A-Z0-9]+-\d{3}$/.test(op)) { add(where, `operation_id「${op}」が書式(OP-<対象略号>-<3桁>)に合いません`); continue; }
    if (!index) { add(where, `${op} を使っていますが、KB T05 の操作索引(kb/external-ops/00_操作索引.md)がありません`); continue; }
    if (!index.ids.has(op)) { add(where, `${op} が KB T05 の操作索引に登録されていません(登録前の操作をステップに使わない)`); continue; }
    const entry = repo.kbOpEntry(op);
    if (!entry) { add(index.rel, `${op} の KB T05 のエントリ(kb/external-ops/ の操作ファイル)が見つかりません`); continue; }
    const sec = sectionLines(entry.text, /禁止操作リストとの適合/);
    if (!sec) { add(entry.rel, `${op} のエントリに「禁止操作リストとの適合」の節がありません(該当行IDまたは「該当なし」を書く)`); continue; }
    const cited = new Set();
    for (const l of sec.lines) {
      if (/該当なし|該当しない/.test(l)) continue;
      for (const m of l.matchAll(/PROH-\d{3}/g)) cited.add(m[0]);
    }
    if (cited.size === 0 && !sec.lines.some((l) => /該当なし|該当しない/.test(l))) {
      add(entry.rel, `${op} のエントリの「禁止操作リストとの適合」に、該当行IDも「該当なし」もありません`);
      continue;
    }
    if (proh.state !== 'filled') continue;
    for (const pid of cited) {
      const level = levelById.get(pid);
      if (level === undefined) add(entry.rel, `${op} の適合確認が参照する ${pid} が禁止操作リストにありません(リストの変更後に確認し直していない可能性)`);
      else if (level === '禁止' || level === '要許可') add(where, `${op} は禁止操作リストの ${pid}(${level})に該当します`);
    }
  }
  return { findings, notes };
}
