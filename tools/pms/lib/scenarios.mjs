// scenarios.md(stages.md 付録C)の読み取り — フローの対象シナリオと requires

import fs from 'node:fs';
import path from 'node:path';
import { headings, isBlank, tables } from '../../lint/lib/markdown.mjs';
import { readText } from './util.mjs';

/** work/ 直下の機能ディレクトリ(_ で始まるものを除く) */
export function featureDirs(root) {
  const dir = path.join(root, 'work');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name).sort();
}

/**
 * 全シナリオの定義。
 * @returns {{id, feature, file, flows: string[], requires: string[], requiresFound: boolean, fields: object, steps: object[]}[]}
 *   flows = 「策定方式」の行に書かれたフローID(そのシナリオを作ったフロー)と、文書の先頭の flow_id
 *   fields = 「- **<名前>**: <値>」の行(目的・合格条件・持ち回るデータ・使用する外部操作 など)
 *   steps = ステップの表の行({id, order, name, check, expected, method, basis, digest})。順序の列で並べる
 */
export function scenarioDefs(root) {
  const out = [];
  for (const fc of featureDirs(root)) {
    const rel = `work/${fc}/scenarios.md`;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const lines = readText(abs).split('\n');
    const hs = headings(lines);
    hs.forEach((h, idx) => {
      const m = h.title.match(/^(SC-[A-Za-z0-9]+-\d+)\s*[:：]/);
      if (!m) return;
      const next = hs.slice(idx + 1).find((x) => x.level <= h.level);
      const body = lines.slice(h.line + 1, next ? next.line : lines.length);
      let requires = [];
      let requiresFound = false;
      const flows = [];
      const fields = {};
      for (const l of body) {
        const fm = l.match(/^\s*[-*]\s*\*\*([^*]+)\*\*\s*[:：]\s*(.*)$/);
        if (fm && !(fm[1].trim() in fields)) fields[fm[1].trim()] = fm[2].trim();
        const rm = l.match(/^\s*[-*]\s*(?:\*\*)?requires(?:\*\*)?\s*[:：]\s*(.*)$/);
        if (rm && !requiresFound) {
          requiresFound = true;
          requires = rm[1].split(/[,、]/).map((x) => x.replace(/`/g, '').trim()).filter((x) => x && !isBlank(x) && x !== 'なし');
        }
        const sm = l.match(/^\s*[-*]\s*(?:\*\*)?策定方式(?:\*\*)?\s*[:：]\s*(.*)$/);
        if (sm) for (const f of sm[1].matchAll(/F-\d{3}/g)) flows.push(f[0]);
      }
      out.push({ id: m[1], feature: fc, file: rel, flows, requires, requiresFound, fields, steps: stepRows(body, m[1]) });
    });
  }
  return out;
}

/**
 * フローの対象シナリオ。既定は「策定方式」の行がそのフローIDを挙げるシナリオ(このフローで作ったもの)。
 * ids を渡したときはそのシナリオ(再探索フロー・パートPのように、前のフローのシナリオを扱うとき)
 */
export function targetScenarios(root, flow, ids = null) {
  const defs = scenarioDefs(root);
  if (ids && ids.length) {
    const found = defs.filter((d) => ids.includes(d.id));
    const missing = ids.filter((id) => !found.some((d) => d.id === id));
    return { scenarios: found, missing };
  }
  return { scenarios: defs.filter((d) => d.flows.includes(flow)), missing: [] };
}

const COLS = { name: '項目名', check: '確認内容', expected: '期待結果', method: '検証手段', basis: '根拠' };

/** ステップの表の行。digest は期待結果・判定基準に当たる列(確認内容・期待結果)の写し(書き換えの検出に使う) */
function stepRows(body, scId) {
  const out = [];
  for (const t of tables(body)) {
    const col = t.header.find((c) => /^Step\s*ID$/i.test(c) || c === 'ステップID');
    if (!col) continue;
    t.rows.forEach((r, k) => {
      const id = String(r.obj[col] ?? '').replace(/`/g, '').trim();
      if (!id.startsWith(scId + '-')) return;
      const row = { id, order: Number(r.obj['順序']), k };
      for (const [key, name] of Object.entries(COLS)) row[key] = String(r.obj[name] ?? '').trim();
      row.digest = `${row.check}\u0000${row.expected}`;
      if (!out.some((x) => x.id === id)) out.push(row);
    });
  }
  if (out.every((r) => Number.isFinite(r.order))) out.sort((a, b) => a.order - b.order || a.k - b.k);
  return out.map(({ k, ...r }) => r);
}
