// store.mjs — タスクキュー(queue.json)・操作の記録(act-log.jsonl)・DB の確認の記録(db-log.jsonl)・提出の記録(submit-log.jsonl)

import fs from 'node:fs';
import { load as loadEnv, valuesOfKind, EnvError } from '../../env/lib/environments.mjs';
import { readJson, writeJson, readJsonl, appendLine, UsageError, FLOW_RE, CARD_RE } from './util.mjs';

export const CARD_STATUS = ['pending', 'issued', 'passed', 'stopped', 'skipped'];
// 終わったカード(合格・STOP・pms が記録だけを書いたもの)
export const DONE_STATUS = ['passed', 'stopped', 'skipped']; // vocab.pms_card_status と同じ(起動時に照合する)

export class Store {
  constructor(paths) { this.paths = paths; }

  hasQueue(flow) { return fs.existsSync(this.paths.abs(this.paths.queue(flow))); }

  loadQueue(flow) {
    if (!FLOW_RE.test(flow)) throw new UsageError(`--flow は F-<3桁> で指定してください: ${flow}`);
    const rel = this.paths.queue(flow);
    if (!fs.existsSync(this.paths.abs(rel))) {
      throw new UsageError(`${rel} がありません。先に node tools/pms/pms.mjs queue build --flow ${flow} --phase A を実行する(パートCまで作るときは --phase all)`);
    }
    const q = readJson(this.paths.abs(rel), rel);
    if (!Array.isArray(q.cards)) throw new UsageError(`${rel} に cards がありません`);
    return q;
  }

  saveQueue(q) { writeJson(this.paths.abs(this.paths.queue(q.flow_id)), q); }

  card(q, id) {
    if (!CARD_RE.test(String(id))) throw new UsageError(`--card は C-<4桁> で指定してください: ${id}`);
    const c = q.cards.find((x) => x.id === id);
    if (!c) throw new UsageError(`${q.flow_id} のキューにカード ${id} がありません`);
    return c;
  }

  nextCardId(q) {
    const max = q.cards.reduce((m, c) => Math.max(m, Number(c.id.slice(2))), 0);
    return `C-${String(max + 1).padStart(4, '0')}`;
  }

  /** フローの全機能の act-log の行(このフローのもの)。seq の順 */
  actRecords(q) {
    const out = [];
    for (const fc of q.features ?? []) {
      const { rows } = readJsonl(this.paths.abs(this.paths.actLog(fc)));
      for (const r of rows) if (r.flow === q.flow_id) out.push({ ...r, _feature: fc });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  nextSeq(q) {
    return this.actRecords(q).reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1;
  }

  appendAct(feature, row) { appendLine(this.paths.abs(this.paths.actLog(feature)), row); }

  appendDb(feature, row) { appendLine(this.paths.abs(this.paths.dbLog(feature)), row); }

  appendSubmit(flow, row) { appendLine(this.paths.abs(this.paths.submitLog(flow)), row); }

  submitRows(flow) { return readJsonl(this.paths.abs(this.paths.submitLog(flow))).rows; }
}

/**
 * 出力・記録から伏せる値。今回の操作で取り出した値と、環境情報の全環境の秘密情報(kind: secret)。
 * 3文字未満の値は、ほかの文字列と取り違えるため伏せない(警告を返す)
 */
export const MIN_MASK_LENGTH = 3;

export function secretsToMask(root) {
  try {
    const cfg = loadEnv(root);
    return valuesOfKind(cfg, 'secret', 1).map((v) => ({ key: v.key, value: v.value }));
  } catch (e) {
    if (e instanceof EnvError) return [];
    throw e;
  }
}

export function mask(text, values) {
  if (text == null) return text;
  let s = String(text);
  const sorted = [...values].filter((v) => v.value && v.value.length >= MIN_MASK_LENGTH).sort((a, b) => b.value.length - a.value.length);
  for (const v of sorted) s = s.split(v.value).join(`<env:${v.key}>`);
  return s;
}

/** オブジェクトの文字列をすべて伏せる */
export function maskDeep(obj, values) {
  if (typeof obj === 'string') return mask(obj, values);
  if (Array.isArray(obj)) return obj.map((x) => maskDeep(x, values));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, maskDeep(v, values)]));
  return obj;
}
