// util.mjs — pms の共通の部品(時刻・ファイルの読み書き・置き場所・エラー)

import fs from 'node:fs';
import path from 'node:path';

/** 使い方・設定の誤り(終了コード 2) */
export class UsageError extends Error {}

export const FLOW_RE = /^F-\d{3}$/;
export const CARD_RE = /^C-\d{4}$/;
export const FEATURE_RE = /^[A-Za-z0-9]+$/;

/** 現在時刻(テストでは環境変数 PMS_NOW で固定できる) */
export function now() {
  const fixed = process.env.PMS_NOW;
  if (fixed) {
    const d = new Date(fixed);
    if (Number.isNaN(d.getTime())) throw new UsageError(`PMS_NOW の値が日時として読めません: ${fixed}`);
    return d;
  }
  return new Date();
}

/** vocab.timestamp_format(ISO 8601・秒まで・時差付き。例 2026-10-03T13:50:12+09:00)。時差は実行マシンの時計 */
export function timestamp(d = now()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** 台帳の起票日(YYYY-MM-DD) */
export function today(d = now()) {
  return timestamp(d).slice(0, 10);
}

export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function readJson(file, what = file) {
  let text;
  try { text = readText(file); } catch (e) { throw new UsageError(`${what} を読めません — ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new UsageError(`${what} が JSON として読めません — ${e.message}`); }
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj, null, 2) + '\n');
}

export function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/** JSON Lines を読む(読めない行は飛ばし、件数を返す) */
export function readJsonl(file) {
  if (!fs.existsSync(file)) return { rows: [], bad: 0 };
  const rows = [];
  let bad = 0;
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  return { rows, bad };
}

/** リポジトリの中の置き場所(00 ■進行役と記録の道具。tools/pms/README.md) */
export class Paths {
  constructor(root) { this.root = root; }
  abs(rel) { return path.join(this.root, rel); }
  rel(abs) { return path.relative(this.root, abs).split(path.sep).join('/'); }
  flowDir(flow) { return `work/_flows/${flow}`; }
  queue(flow) { return `${this.flowDir(flow)}/queue.json`; }
  card(flow, card) { return `${this.flowDir(flow)}/cards/${card}.md`; }
  out(flow, card) { return `${this.flowDir(flow)}/out/${card}.json`; }
  submitLog(flow) { return `${this.flowDir(flow)}/submit-log.jsonl`; }
  run(flow, card, n) { return `${this.flowDir(flow)}/runs/${card}-${n}.jsonl`; }
  context(flow) { return `${this.flowDir(flow)}/stage10-context.json`; }
  draft(flow, feature) { return `${this.flowDir(flow)}/report-draft-${feature}.md`; }
  flowMd(flow) { return `${this.flowDir(flow)}/flow.md`; }
  actLog(feature) { return `work/${feature}/exploration/act-log.jsonl`; }
  setupLog(feature) { return `work/${feature}/exploration/setup-log.yaml`; }
  explorationLog(feature) { return `work/${feature}/exploration/exploration-log.yaml`; }
  evidenceDir(feature) { return `work/${feature}/exploration/evidence`; }
  report(feature) { return `work/${feature}/exploration/report.md`; }
  status(feature) { return `work/${feature}/exploration/status.yaml`; }
  scenarios(feature) { return `work/${feature}/scenarios.md`; }
  handoff() { return 'work/_common/handoff-register.md'; }
  extDemand() { return 'work/_common/external-op-demand.md'; }
  stateDemand() { return 'work/_common/state-demand.md'; }
  testidRequests() { return 'work/_common/testid-requests.md'; }
  discrepancies() { return 'work/_common/discrepancies.md'; }
  signals() { return 'work/_common/procedure-improvement.md'; }
  prohibitedOps() { return 'work/_common/prohibited-operations.md'; }
  ndCatalog() { return 'work/_common/nondeterministic-catalog.md'; }
}

/** 手順版の番号(proc-v017 → 17) */
export function verNum(v) {
  const m = String(v ?? '').match(/^proc-v(\d{3})$/);
  return m ? Number(m[1]) : null;
}

export function flowNum(f) {
  const m = String(f ?? '').match(/^F-(\d+)$/);
  return m ? Number(m[1]) : -1;
}

export function blank(v) {
  return v == null || String(v).trim() === '';
}
