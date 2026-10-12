// coverage.mjs — シナリオの範囲の記録
//   operation_inventory_complete(proc-v036 以降の manual_usecase のフロー。INFO)
//
// 方式 manual_usecase のスロット2の「操作の棚卸し」の表(scenarios.md の「## 操作の棚卸し(<フローID>)」)が、
// 全行で実在のステップID か HO-ID を指し、同一経路の申し送りが代表のステップを指しているかを見る。
// 手順版は作業10の status.yaml の procedure_version で判定する。

import { sectionLines, tables, idsIn } from '../lib/markdown.mjs';
import { verNum } from './exploration.mjs';

const INVENTORY_SINCE = 36; // proc-v036 で追加(IMP-020・024)
const STEP_RE = /SC-[A-Za-z0-9]+-\d+-S\d+/g;
const HO_RE = /HO-[A-Za-z0-9]+-\d{3}/g;

export function operation_inventory_complete(repo) {
  const findings = [];
  const notes = [];
  const add = (file, message) => findings.push({ file, message });

  const steps = new Set();
  for (const d of repo.scenarioDefs.values()) for (const s of d.steps) steps.add(s);
  const handoffs = new Map(repo.handoffRows.rows.map((r) => [String(r.obj['ID'] ?? '').trim(), r]));

  let checked = 0;
  for (const s of repo.statusFor('10', repo.flow)) {
    const v = verNum(s.data?.procedure_version);
    if (!s.flow || !s.feature || v === null || v < INVENTORY_SINCE) continue;
    if (s.data?.context_updates?.scenario_source !== 'manual_usecase') continue;
    checked++;
    const rel = `work/${s.feature}/scenarios.md`;
    if (!repo.exists(rel)) { add(rel, `${s.flow}: scenarios.md がありません`); continue; }
    const title = new RegExp(`^操作の棚卸し\\s*[((]\\s*${s.flow}\\s*[))]\\s*$`);
    const sec = sectionLines(repo.read(rel), title);
    if (!sec) { add(rel, `「## 操作の棚卸し(${s.flow})」の節がありません(方式 manual_usecase のスロット2)`); continue; }
    const t = tables(sec.lines, sec.offset).find((x) => x.header.includes('扱い'));
    if (!t || t.rows.length === 0) { add(rel, `「操作の棚卸し(${s.flow})」に列「扱い」の表(行のあるもの)がありません`); continue; }
    for (const row of t.rows) {
      const where = `${rel}:${row.line}`;
      const op = String(row.obj['操作'] ?? '').trim() || '(操作なし)';
      const cell = row.obj['扱い'];
      const stepIds = idsIn(cell, STEP_RE);
      const hoIds = idsIn(cell, HO_RE);
      if (stepIds.length + hoIds.length === 0) { add(where, `「${op}」の扱いにステップID も HO-ID もありません`); continue; }
      for (const id of stepIds) if (!steps.has(id)) add(where, `「${op}」の扱いの ${id} が scenarios.md のステップにありません`);
      for (const id of hoIds) {
        const ho = handoffs.get(id);
        if (!ho) { add(where, `「${op}」の扱いの ${id} が申し送り台帳にありません`); continue; }
        if (String(ho.obj['理由コード'] ?? '').trim() !== '同一経路') continue;
        const reps = idsIn(ho.obj['想定手段'], STEP_RE);
        if (reps.length === 0) add(where, `「${op}」の ${id} は 同一経路 だが、想定手段に代表のステップIDがありません(vocab.discrimination の 同一経路の代表)`);
        else for (const r of reps) if (!steps.has(r)) add(where, `「${op}」の ${id} の想定手段の ${r} が scenarios.md のステップにありません`);
      }
    }
  }
  if (checked === 0) notes.push('対象のフロー(proc-v036 以降の manual_usecase の作業10)はありません');
  return { findings, notes };
}
