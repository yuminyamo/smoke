// setup-log.mjs — setup-log.yaml(stages.md 付録B)の読み書き
//
// 1つのファイルに複数のフローの文書(--- で区切る)があってよい。pms は対象のフローの文書だけを書き直し、
// ほかのフローの文書は1文字も変えない。同じフローの文書の中では、state_id ごとにエントリを置き換える。

import fs from 'node:fs';
import { parseYamlDocs } from '../../lint/lib/yaml-lite.mjs';
import { emitDoc } from './yaml-write.mjs';
import { readText, writeText, UsageError } from './util.mjs';

/** ファイルを文書ごとの文字列に分ける(区切りの行は含めない) */
function splitDocs(text) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = [];
  for (const l of lines) {
    if (/^---\s*$/.test(l)) { chunks.push(cur.join('\n')); cur = []; } else cur.push(l);
  }
  chunks.push(cur.join('\n'));
  return chunks;
}

function parseChunk(chunk, rel) {
  if (!chunk.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) return null;
  try { return parseYamlDocs(chunk)[0] ?? null; } catch (e) { throw new UsageError(`${rel} を YAML として読めません — ${e.message}`); }
}

/** フローの setup-log のエントリ(なければ []) */
export function readEntries(abs, rel, flow) {
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const chunk of splitDocs(readText(abs))) {
    const doc = parseChunk(chunk, rel);
    if (!doc || typeof doc !== 'object') continue;
    for (const e of Array.isArray(doc.setups) ? doc.setups : []) {
      if (e && typeof e === 'object' && (e.flow_id ?? doc.flow_id) === flow) out.push(e);
    }
  }
  return out;
}

/** 全フローのエントリ(流用元を探すため) */
export function readAllEntries(abs, rel) {
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const chunk of splitDocs(readText(abs))) {
    const doc = parseChunk(chunk, rel);
    if (!doc || typeof doc !== 'object') continue;
    for (const e of Array.isArray(doc.setups) ? doc.setups : []) {
      if (e && typeof e === 'object') out.push({ flow: e.flow_id ?? doc.flow_id ?? null, e });
    }
  }
  return out;
}

/**
 * フローの文書のエントリを1つ書く(同じ state_id があれば置き換える)。
 * @param {string} abs  setup-log.yaml の絶対パス
 * @param {object} entry 付録B のエントリ
 */
export function upsertEntry(abs, rel, { feature, flow }, entry) {
  const text = fs.existsSync(abs) ? readText(abs) : '';
  const chunks = text ? splitDocs(text) : [];
  let idx = -1;
  let doc = null;
  chunks.forEach((c, i) => {
    const d = parseChunk(c, rel);
    if (d && typeof d === 'object' && d.flow_id === flow && idx < 0) { idx = i; doc = d; }
  });
  if (!doc) doc = { feature_code: feature, flow_id: flow, setups: [] };
  if (!Array.isArray(doc.setups)) doc.setups = [];
  const at = doc.setups.findIndex((e) => e && e.state_id === entry.state_id);
  if (at >= 0) doc.setups[at] = entry; else doc.setups.push(entry);
  const body = emitDoc({ feature_code: doc.feature_code ?? feature, flow_id: flow, setups: doc.setups });
  let out;
  if (idx >= 0) {
    chunks[idx] = body.replace(/\n$/, '');
    out = chunks.join('\n---\n');
  } else if (chunks.length && chunks.some((c) => c.trim())) {
    out = text.replace(/\n*$/, '\n') + '---\n' + body;
  } else {
    out = body;
  }
  writeText(abs, out.endsWith('\n') ? out : out + '\n');
}

/** 1つのエントリ(なければ null) */
export function findEntry(abs, rel, flow, stateId) {
  return readEntries(abs, rel, flow).find((e) => e.state_id === stateId) ?? null;
}
