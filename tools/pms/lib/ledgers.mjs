// ledgers.mjs — 台帳への書き込みの共通の部品(申し送り台帳・外部操作需要リスト・状態需要リスト)
//
// 段1(フェーズA)では pms submit と pms queue build が使う。段2以降のカードも同じ部品で書く。
// 表の形は記入用テンプレート(procedure/templates/91・93・96)の「## 台帳」の表に合わせる。
// 台帳のファイルがなければ、テンプレートを写して作る(テンプレートの空の行は、最初の行を足すときに外す)。
// 書くのは事実だけである(00 ■申し送り台帳・■外部操作 外部操作需要リスト・■状態(前提条件)の扱い・■手順改善シグナル)。
// 段2で手順改善シグナル(テンプレート94の「1. シグナル」の表)と不整合レポート(DISC。00 ■不整合レポート(DISC)規約の書式)を加えた。
// 優先度・採否など人間が書く欄には書かない。

import fs from 'node:fs';
import path from 'node:path';
import { tableInSection, isBlank } from '../../lint/lib/markdown.mjs';
import { readText, writeText, UsageError } from './util.mjs';

const LEDGERS = {
  handoff: { rel: 'work/_common/handoff-register.md', template: '91_', idCol: 'ID', content: ['対象', '理由コード'] },
  extDemand: { rel: 'work/_common/external-op-demand.md', template: '93_', idCol: '需要ID', content: ['外部操作(業務語)', '操作対象'] },
  stateDemand: { rel: 'work/_common/state-demand.md', template: '96_', idCol: '需要ID', content: ['状態ID', '定義(業務語)'] },
  signals: { rel: 'work/_common/procedure-improvement.md', template: '94_', idCol: 'SIG-ID', content: ['事象(事実)', '手順箇所'], section: /^1\.\s*シグナル/ },
};

function formatError(def) {
  const sec = def.section ? '1. シグナル' : '台帳';
  return `${def.rel} の「## ${sec}」の節に列 ${def.idCol} の表がありません。記入用テンプレート ${def.template.replace(/_$/, '')} の見出しと表の列のまま書き直す(既存の行は、その表に移す。00 ■文書の5層構成・R-HO-3)`;
}

function cell(v) {
  return String(v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

class Ledger {
  constructor(root, kind) {
    this.root = root;
    this.def = LEDGERS[kind];
    this.abs = path.join(root, this.def.rel);
  }

  load() {
    if (!fs.existsSync(this.abs)) {
      const dir = path.join(this.root, 'procedure', 'templates');
      const name = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.startsWith(this.def.template)) : null;
      if (!name) throw new UsageError(`${this.def.rel} がなく、記入用テンプレート ${this.def.template}*.md も見つかりません`);
      this.text = readText(path.join(dir, name));
      this.created = true;
    } else {
      this.text = readText(this.abs);
      this.created = false;
    }
    this.lines = this.text.split('\n');
    this.table = tableInSection(this.text, this.def.section ?? '台帳', this.def.idCol);
    if (!this.table) throw new UsageError(formatError(this.def));
    return this;
  }

  get rows() {
    return this.table.rows.filter((r) => this.def.content.some((c) => !isBlank(r.obj[c])));
  }

  /** 行を足す(テンプレートの空の行は外す) */
  append(obj) {
    const header = this.table.header;
    const line = `| ${header.map((h) => cell(obj[h])).join(' | ')} |`;
    const placeholders = this.table.rows.filter((r) => this.def.content.every((c) => isBlank(r.obj[c])));
    for (const p of [...placeholders].sort((a, b) => b.line - a.line)) this.lines.splice(p.line - 1, 1);
    this.reparse();
    const rows = this.table.rows;
    // row.line は 1 始まり。最後の行の次(表に行がなければ区切り行の次)に足す
    const at = rows.length ? rows[rows.length - 1].line : this.table.line + 1;
    this.lines.splice(at, 0, line);
    this.reparse();
  }

  /** 既存の行の欄を書き換える */
  update(row, changes) {
    const header = this.table.header;
    const obj = { ...row.obj, ...changes };
    this.lines[row.line - 1] = `| ${header.map((h) => cell(obj[h])).join(' | ')} |`;
    this.reparse();
  }

  reparse() {
    this.text = this.lines.join('\n');
    this.table = tableInSection(this.text, this.def.section ?? '台帳', this.def.idCol);
  }

  save() { writeText(this.abs, this.text); }
}

function maxNumber(rows, col, re) {
  let max = 0;
  for (const r of rows) {
    const m = String(r.obj[col] ?? '').match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 申し送り台帳に1行足す。
 * @returns {string} 採番した申し送りID(HO-<機能コード>-<3桁>)
 */
export function appendHandoff(root, { feature, target, reason, dest, means = '', origin, date }) {
  const l = new Ledger(root, 'handoff').load();
  const id = nextHandoffId(l, feature);
  l.append({ ID: id, 対象: target, 理由コード: reason, 引き継ぎ先: dest, 想定手段: means, 発生元: origin, 起票日: date, 状態: 'open' });
  l.save();
  return id;
}

function nextHandoffId(l, feature) {
  const n = maxNumber(l.rows, 'ID', new RegExp(`^HO-${feature}-(\\d+)$`)) + 1;
  return `HO-${feature}-${String(n).padStart(3, '0')}`;
}

/** 次に採番する申し送りID(外部操作需要リストの要求元に先に書くため) */
export function peekHandoffId(root, feature) {
  return nextHandoffId(new Ledger(root, 'handoff').load(), feature);
}

/**
 * 外部操作需要リストに記録する。同じ外部操作(業務語)と操作対象の行があれば要求元を追記するだけにする
 * (00 ■外部操作 外部操作需要リスト 重複防止)。
 * @returns {{id: string, appended: boolean}} appended = 既存の行への要求元の追記
 */
export function recordExtDemand(root, { operation, target, gap, requester, alternative, prohibition, date }) {
  const l = new Ledger(root, 'extDemand').load();
  const norm = (s) => String(s ?? '').replace(/\s+/g, '').trim();
  const same = l.rows.find((r) => norm(r.obj['外部操作(業務語)']) === norm(operation) && norm(r.obj['操作対象']) === norm(target));
  if (same) {
    const id = String(same.obj['需要ID']).trim();
    const cur = String(same.obj['要求元'] ?? '').trim();
    const list = isBlank(cur) ? [] : cur.split(/\s*[,、]\s*/);
    if (!list.includes(requester)) {
      l.update(same, { 要求元: [...list, requester].join(', ') });
      l.save();
    }
    return { id, appended: true };
  }
  const n = maxNumber(l.rows, '需要ID', /^EXT-(\d+)$/) + 1;
  const id = `EXT-${String(n).padStart(3, '0')}`;
  l.append({
    需要ID: id, '外部操作(業務語)': operation, 操作対象: target, 状態: '未整備', 不足の区分: gap,
    要求元: requester, 代替手段: alternative, 禁止操作との関係: prohibition, 起票日: date,
  });
  l.save();
  return { id, appended: false };
}

/** 状態需要リストの、状態IDの行(なければ null) */
export function stateDemandRow(root, stateId) {
  if (!fs.existsSync(path.join(root, LEDGERS.stateDemand.rel))) return null;
  const l = new Ledger(root, 'stateDemand').load();
  const row = l.rows.find((r) => String(r.obj['状態ID']).replace(/`/g, '').trim() === stateId);
  return row ? { ...row.obj } : null;
}

/** 状態需要リストで 採用 / 整備済 の状態ID(初期状態セットの追加分) */
export function adoptedStates(root) {
  if (!fs.existsSync(path.join(root, LEDGERS.stateDemand.rel))) return new Map();
  const l = new Ledger(root, 'stateDemand').load();
  const out = new Map();
  for (const r of l.rows) {
    const status = String(r.obj['状態'] ?? '').trim();
    if (status === '採用' || status === '整備済') out.set(String(r.obj['状態ID']).replace(/`/g, '').trim(), { ...r.obj });
  }
  return out;
}

/**
 * 状態需要リストの 採用 の行を 整備済 にし、fixture の所在を書く(機械的な書き換え)
 * @returns {string|null} 書き換えた需要ID
 */
export function markStateProvisioned(root, stateId, fixture) {
  if (!fs.existsSync(path.join(root, LEDGERS.stateDemand.rel))) return null;
  const l = new Ledger(root, 'stateDemand').load();
  const row = l.rows.find((r) => String(r.obj['状態ID']).replace(/`/g, '').trim() === stateId);
  if (!row || String(row.obj['状態']).trim() !== '採用') return null;
  l.update(row, { 状態: '整備済', fixture });
  l.save();
  return String(row.obj['需要ID']).trim();
}

/**
 * 手順改善シグナルを1行足す(テンプレート94の「1. シグナル」の表。振り分け・IMP は作業40が書く)。
 * @returns {string} 採番した SIG-ID(SIG-<4桁>)
 */
export function appendSignal(root, { origin, location, type, source = '自己申告', event, impact, response, proposal = '', version, date }) {
  const l = new Ledger(root, 'signals').load();
  const n = maxNumber(l.rows, 'SIG-ID', /^SIG-(\d+)$/) + 1;
  const id = `SIG-${String(n).padStart(4, '0')}`;
  l.append({
    'SIG-ID': id, '発生(フロー/作業/項目)': origin, 手順箇所: location, 種別: type, 出所: source, '事象(事実)': event,
    影響: impact, '採った対応・解釈': response, '改善案(任意)': proposal ?? '', 手順版: version, 振り分け: '', IMP: '', 状態: '未処理', 記録日: date,
  });
  l.save();
  return id;
}

const DISC_FILE = 'work/_common/discrepancies.md';

/** DISC の既存のID(全機能) */
export function discrepancyIds(root) {
  const abs = path.join(root, DISC_FILE);
  if (!fs.existsSync(abs)) return [];
  return [...readText(abs).matchAll(/^##\s+(DISC-[A-Za-z0-9]+-\d+)\s*$/gm)].map((m) => m[1]);
}

/**
 * 不整合を1件記録する(00 ■不整合レポート(DISC)規約の書式。ファイルがなければレビューヘッダ付きで作る)。
 * @returns {string} 採番した DISC-ID(DISC-<機能コード>-<3桁>)
 */
export function appendDiscrepancy(root, { feature, kind, related, spec, manual, existing, actual, evidence, assessment, notes }) {
  const abs = path.join(root, DISC_FILE);
  const text = fs.existsSync(abs) ? readText(abs) : '---\nreview_status: unreviewed\n---\n\n# 不整合レポート(DISC)\n';
  let max = 0;
  for (const id of discrepancyIds(root)) {
    const m = id.match(new RegExp(`^DISC-${feature}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  const id = `DISC-${feature}-${String(max + 1).padStart(3, '0')}`;
  const line = (k, v) => `- **${k}**: ${String(v ?? '').replace(/\r?\n/g, ' ').trim() || '記載なし'}`;
  const block = [
    `## ${id}`, '',
    line('種別', kind), line('関連項目', related), line('仕様書の記載', spec), line('マニュアルの記載', manual),
    ...(existing ? [line('既存テストの記載', existing)] : []),
    line('実画面の挙動', actual), line('証跡', evidence), line('分類(AIの見立て)', assessment), line('備考', notes || 'pms が探索のカードの出力から記録した'),
  ].join('\n');
  writeText(abs, `${text.replace(/\n*$/, '\n')}\n${block}\n`);
  return id;
}

/** 禁止操作リストの禁止IDと禁止レベル(ファイルがない・表がなければ空の Map) */
export function prohibitionLevels(root) {
  const abs = path.join(root, 'work/_common/prohibited-operations.md');
  if (!fs.existsSync(abs)) return new Map();
  const t = tableInSection(readText(abs), '禁止操作表', '禁止ID');
  const out = new Map();
  for (const r of t?.rows ?? []) {
    const id = String(r.obj['禁止ID'] ?? '').replace(/`/g, '').trim();
    if (/^PROH-\d{3}$/.test(id) && !isBlank(r.obj['操作'])) out.set(id, String(r.obj['禁止レベル'] ?? '').replace(/`/g, '').trim());
  }
  return out;
}

/** 台帳の行のID(申し送り・外部操作需要) */
export function ledgerIds(root, kind) {
  if (!fs.existsSync(path.join(root, LEDGERS[kind].rel))) return new Set();
  const l = new Ledger(root, kind).load();
  return new Set(l.rows.map((r) => String(r.obj[LEDGERS[kind].idCol] ?? '').trim()).filter(Boolean));
}

/** 申し送り台帳の、発生元にフローIDを含む行({ID, 理由コード, 対象, 発生元}) */
export function handoffsOfFlow(root, flow) {
  if (!fs.existsSync(path.join(root, LEDGERS.handoff.rel))) return [];
  const l = new Ledger(root, 'handoff').load();
  return l.rows.filter((r) => new RegExp(`\\b${flow}\\b`).test(r.obj['発生元'] ?? '')).map((r) => ({ ...r.obj }));
}

/**
 * 作業場所にある台帳が、pms の読める形(テンプレートの見出しと表)かを確かめる。
 * AI が手で作った台帳の形の崩れを、カードを行う前(queue build)に見つけるため。
 * @returns {string[]} 読めない台帳ごとのメッセージ(ないファイルは数えない)
 */
export function ledgerFormatErrors(root) {
  const out = [];
  for (const def of Object.values(LEDGERS)) {
    if (!fs.existsSync(path.join(root, def.rel))) continue;
    if (!tableInSection(readText(path.join(root, def.rel)), def.section ?? '台帳', def.idCol)) out.push(formatError(def));
  }
  return out;
}
