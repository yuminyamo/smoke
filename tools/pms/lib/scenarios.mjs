// scenarios.md(stages.md 付録C)の読み取り — フローの対象シナリオと requires

import fs from 'node:fs';
import path from 'node:path';
import { headings, isBlank } from '../../lint/lib/markdown.mjs';
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
 * @returns {{id, feature, file, flows: string[], requires: string[], requiresFound: boolean}[]}
 *   flows = 「策定方式」の行に書かれたフローID(そのシナリオを作ったフロー)と、文書の先頭の flow_id
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
      for (const l of body) {
        const rm = l.match(/^\s*[-*]\s*(?:\*\*)?requires(?:\*\*)?\s*[:：]\s*(.*)$/);
        if (rm && !requiresFound) {
          requiresFound = true;
          requires = rm[1].split(/[,、]/).map((x) => x.replace(/`/g, '').trim()).filter((x) => x && !isBlank(x) && x !== 'なし');
        }
        const sm = l.match(/^\s*[-*]\s*(?:\*\*)?策定方式(?:\*\*)?\s*[:：]\s*(.*)$/);
        if (sm) for (const f of sm[1].matchAll(/F-\d{3}/g)) flows.push(f[0]);
      }
      out.push({ id: m[1], feature: fc, file: rel, flows, requires, requiresFound });
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
