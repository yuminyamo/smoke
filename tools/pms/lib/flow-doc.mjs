// flow-doc.mjs — フローごとの YAML 文書(--- で区切る)を持つ記録ファイルの読み書き(setup-log・exploration-log)
//
// 1つのファイルに複数のフローの文書があってよい。pms は対象のフローの文書だけを書き直し(なければ末尾に足す)、
// ほかのフローの文書は1文字も変えない。

import fs from 'node:fs';
import { parseYamlDocs } from '../../lint/lib/yaml-lite.mjs';
import { emitDoc } from './yaml-write.mjs';
import { readText, writeText, UsageError } from './util.mjs';

/** ファイルを文書ごとの文字列に分ける(区切りの行は含めない) */
export function splitDocs(text) {
  const chunks = [];
  let cur = [];
  for (const l of text.split('\n')) {
    if (/^---\s*$/.test(l)) { chunks.push(cur.join('\n')); cur = []; } else cur.push(l);
  }
  chunks.push(cur.join('\n'));
  return chunks;
}

export function parseChunk(chunk, rel) {
  if (!chunk.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) return null;
  try { return parseYamlDocs(chunk)[0] ?? null; } catch (e) { throw new UsageError(`${rel} を YAML として読めません — ${e.message}`); }
}

/** ファイルの全文書(読めない・空の文書は除く) */
export function readDocs(abs, rel) {
  if (!fs.existsSync(abs)) return [];
  return splitDocs(readText(abs)).map((c) => parseChunk(c, rel)).filter((d) => d && typeof d === 'object');
}

/**
 * フローの文書を書き直す。
 * @param {(doc: object|null) => object} mutate 今の文書(なければ null)を受け取り、書く文書を返す
 */
export function writeFlowDoc(abs, rel, flow, mutate) {
  const text = fs.existsSync(abs) ? readText(abs) : '';
  const chunks = text ? splitDocs(text) : [];
  let idx = -1;
  let doc = null;
  chunks.forEach((c, i) => {
    const d = parseChunk(c, rel);
    if (d && typeof d === 'object' && d.flow_id === flow && idx < 0) { idx = i; doc = d; }
  });
  const body = emitDoc(mutate(doc));
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
