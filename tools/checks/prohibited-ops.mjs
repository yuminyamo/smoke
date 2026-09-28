#!/usr/bin/env node
// prohibited-ops.mjs — 禁止操作リスト(work/_common/prohibited-operations.md)の記入状態と版を取得し、
// 作業10の status.yaml と照合する(00_common.md ■外部操作 / lint prohibition_recheck)。
//
//   node tools/checks/prohibited-ops.mjs                          記入状態と版を出力する(作業10の工程0のあと)
//   node tools/checks/prohibited-ops.mjs --compare <status.yaml>  作業10の記録と照合する(作業20の開始前)
//   オプション: --file <path>  禁止操作リストの所在(既定: <root>/work/_common/prohibited-operations.md)
//               --root <dir>   リポジトリのルート(既定: このスクリプトの2階層上)
//
// 記入状態(vocab.prohibited_ops_state):
//   filled   「## 禁止操作表」の表に、操作欄が記入された行が1行以上ある
//   unfilled ファイルはあるが、その表に操作欄が記入された行がない(記入例の表は数えない)→ 禁止操作なしとして扱う
//   absent   ファイルがない → 禁止操作なしとして扱う
//
// 終了コード:
//   0 = 問題なし(--compare では作業20を始めてよい)
//   3 = 再判定が必要(作業10が「禁止操作」で blocked にしたステップがあり、その後にリストが変わった)
//   2 = 照合できない(ファイルの形式が想定と違う、status.yaml に必要な項目がない等。人間に伝える)
// 出力: 標準出力に1行の JSON(status.yaml への転記用)。人間向けの説明は標準エラー出力。
// 依存: Node.js 18 以上のみ(外部パッケージ不要)。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = { compare: null, file: null, root: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) bail(`${a} の値がありません`);
    return v;
  };
  if (a === '--compare') opt.compare = next();
  else if (a === '--file') opt.file = next();
  else if (a === '--root') opt.root = next();
  else if (a === '-h' || a === '--help') { help(); process.exit(0); }
  else bail(`不明な引数: ${a}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(opt.root ?? path.join(scriptDir, '..', '..'));
const FILE = path.resolve(ROOT, opt.file ?? path.join('work', '_common', 'prohibited-operations.md'));
const REL = path.relative(ROOT, FILE).split(path.sep).join('/');

const cur = inspect(FILE);

if (!opt.compare) {
  print({ file: REL, state: cur.state, digest: cur.digest, filled_rows: cur.filled_rows });
  if (cur.state === 'filled') note(`記入済み(${cur.filled_rows} 行)。表のとおりに扱います。`);
  else note(`${cur.state === 'absent' ? 'ファイルがありません' : '未記入です'}。禁止操作なしとして扱います(包括原則は常に適用します。00 ■外部操作)。`);
  process.exit(0);
}

const st = readStatus(path.resolve(opt.compare));
const base = { file: REL, recorded_digest: st.digest, current_digest: cur.digest, current_state: cur.state, steps: st.blocked };

if (st.blocked.length === 0) {
  print({ result: 'ok', reason: 'no_blocked_by_prohibition', ...base });
  note('作業10で「禁止操作」により blocked にしたステップはありません。作業20を始めてよい。');
  process.exit(0);
}
if (st.digest === cur.digest) {
  print({ result: 'ok', reason: 'unchanged', ...base });
  note(`禁止操作リストは作業10のときから変わっていません(blocked ${st.blocked.length} 件は blocked のまま)。作業20を始めてよい。`);
  process.exit(0);
}
print({ result: 'recheck_required', ...base });
note(`禁止操作リストが作業10のあとで変わっています(${st.digest} → ${cur.digest})。`);
note(`「禁止操作」で blocked にしたステップ ${st.blocked.length} 件: ${st.blocked.join(', ')}`);
note('作業20を始めず、作業10のパートP(禁止操作の再判定)を行ってください(context.prohibition_recheck=yes)。');
process.exit(3);

// ════════════════════════════════════════════════════════

function inspect(file) {
  if (!fs.existsSync(file)) return { state: 'absent', digest: 'absent', filled_rows: 0 };
  const text = normalize(fs.readFileSync(file, 'utf8'));
  const digest = 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+禁止操作表\s*$/.test(l));
  if (start < 0) bail(`${REL}: 見出し「## 禁止操作表」が見つかりません(テンプレート90の形式に合わせてください)`);
  let header = null;
  let filled = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,3}\s/.test(l)) break; // 次の見出し(「### 記入例」を含む)で表の範囲を終える
    const t = l.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (!header) { header = cells; continue; }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // 区切り行
    const idx = header.indexOf('操作');
    const op = cells[idx >= 0 ? idx : 1] ?? '';
    if (op !== '' && op !== '-') filled++;
  }
  if (!header) bail(`${REL}: 「## 禁止操作表」の下に表がありません`);
  return { state: filled > 0 ? 'filled' : 'unfilled', digest, filled_rows: filled };
}

function readStatus(p) {
  if (!fs.existsSync(p)) bail(`status.yaml がありません: ${p}`);
  const lines = normalize(fs.readFileSync(p, 'utf8')).split('\n').map(stripComment);
  const i = lines.findIndex((l) => /^prohibited_ops:\s*$/.test(l));
  if (i < 0) bail(`${p}: 最上位の prohibited_ops がありません(作業10が禁止操作リストの版を記録していない。proc-v004 より前の版で始めたフローなら、そのフローでは照合できません)`);
  let digest = null;
  let state = null;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') continue;
    if (!/^\s/.test(l)) break;
    let m;
    if ((m = l.match(/^\s+digest:\s*(.+)$/))) digest = unquote(m[1].trim());
    else if ((m = l.match(/^\s+state:\s*(.+)$/))) state = unquote(m[1].trim());
  }
  if (!digest) bail(`${p}: prohibited_ops.digest がありません`);
  const blocked = readList(lines, 'blocked_by_prohibition');
  if (blocked === null) bail(`${p}: context_updates.blocked_by_prohibition がありません(該当がなければ [] と書く)`);
  return { digest, state, blocked };
}

// YAML のリスト(インライン [a, b] またはブロック形式 - a)を読む簡易版
function readList(lines, key) {
  const re = new RegExp(`^(\\s*)${key}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[2].trim();
    if (rest.startsWith('[')) {
      let buf = rest;
      let j = i;
      while (!buf.includes(']') && j + 1 < lines.length) buf += ' ' + lines[++j].trim();
      if (!buf.includes(']')) return null;
      const inner = buf.slice(buf.indexOf('[') + 1, buf.lastIndexOf(']'));
      return inner.split(',').map((s) => unquote(s.trim())).filter(Boolean);
    }
    if (rest === '') {
      const out = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') continue;
        const mm = l.match(/^(\s*)-\s*(.+)$/);
        if (!mm || mm[1].length < indent) break;
        out.push(unquote(mm[2].trim()));
      }
      return out;
    }
    return null;
  }
  return null;
}

function stripComment(l) {
  if (/^\s*#/.test(l)) return '';
  const idx = l.search(/\s#/);
  return idx >= 0 ? l.slice(0, idx) : l;
}

function unquote(s) {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}

function normalize(s) {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function print(obj) {
  console.log(JSON.stringify(obj));
}

function note(msg) {
  console.error(msg);
}

function bail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(2);
}

function help() {
  console.log(`使い方:
  node tools/checks/prohibited-ops.mjs                          記入状態と版を出力する
  node tools/checks/prohibited-ops.mjs --compare <status.yaml>  作業10の記録と照合する(0: 開始してよい / 3: 再判定が必要 / 2: 照合できない)
オプション:
  --file <path>   禁止操作リストの所在(既定: work/_common/prohibited-operations.md)
  --root <dir>    リポジトリのルート(既定: このスクリプトの2階層上)`);
}
