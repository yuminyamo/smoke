#!/usr/bin/env node
// flow-reset.mjs — 完了したフローの成果物を退避して、同じ対象機能の回帰テスト作成を新しいフローでやり直せる状態に戻す
// (手順書の改善・KB の蓄積の効果を、同じ機能で確かめるため。手順: docs/006_フローの再実行手順.md)
//
//   node tools/flow-reset/flow-reset.mjs --flow F-001             何を退避・削除するかを表示する(何も変えない)
//   node tools/flow-reset/flow-reset.mjs --flow F-001 --apply     実際に退避する
//   オプション: --flow は繰り返し指定できる(同じ機能コードを対象にしたフローはまとめて退避する必要がある)
//               --root <dir>   リポジトリのルート(既定: このスクリプトの2階層上)
//
// 退避するもの(work/.archive/<日時>-<フローID>/ へ、リポジトリ内の相対パスを保ったまま移す):
//   work/_flows/<フローID>/ ・ work/<機能コード>/ ・ tests/specs/<機能コード小文字>/ ・ traceability/<機能コード>-matrix.md
//   退避後に他の機能の成果物が残らない(全フローの退避)ときは、共有のテスト資産 tests/・playwright.config.ts も退避する
// 台帳から外すもの(編集前の台帳は退避先の _ledgers-before/ に写す):
//   申し送り台帳の「## 台帳」の行のうち、発生元が対象フローのもの
//   状態需要リスト・外部操作需要リストの「## 台帳」の行のうち、要求元がすべて上で外した申し送りのもの
// 残すもの: KB・発見ログ・非決定値カタログ(作業02)・機能一覧・禁止操作リスト・手順改善台帳・品質評価(_assess)・
//   手順改善(_improve)・testid-requests.md(行の発生元が分からないため)。フロー台帳の行も残し、備考に退避先を書く
//   (フローIDは指標・KB・品質評価から参照されるため、やり直しは次の番号の新しいフローで行う)
// work/.archive/ はドットで始まるため、lint・pms の走査の対象外。work/ は git の対象外(.git/info/exclude)。
//
// 終了コード: 0 = 表示・退避できた / 2 = 退避できない(理由を標準エラー出力に書く)
// 依存: Node.js 22 以上のみ(外部パッケージ不要)。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalize, sectionLines, tables, idsIn, isBlank } from '../lint/lib/markdown.mjs';

const FLOW_RE = /^F-\d{3,}$/;
const LEDGER = 'work/_flows/00_フロー台帳.md';
const HANDOFF = 'work/_common/handoff-register.md';
const DEMANDS = [
  { rel: 'work/_common/state-demand.md', name: '状態需要リスト', idCol: '需要ID' },
  { rel: 'work/_common/external-op-demand.md', name: '外部操作需要リスト', idCol: '需要ID' },
];
const ARCHIVE_MARK = 'work/.archive/';

const args = process.argv.slice(2);
const opt = { flows: [], apply: false, root: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) bail(`${a} の値がありません`);
    return v;
  };
  if (a === '--flow') opt.flows.push(next());
  else if (a === '--apply') opt.apply = true;
  else if (a === '--root') opt.root = next();
  else if (a === '-h' || a === '--help') { help(); process.exit(0); }
  else bail(`不明な引数: ${a}`);
}
if (opt.flows.length === 0) bail('--flow <フローID> を指定してください(例: --flow F-001)');
for (const f of opt.flows) if (!FLOW_RE.test(f)) bail(`フローIDの形式が違います: ${f}(例: F-001)`);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(opt.root ?? path.join(scriptDir, '..', '..'));
const abs = (rel) => path.join(ROOT, ...rel.split('/'));
const exists = (rel) => fs.existsSync(abs(rel));
const read = (rel) => normalize(fs.readFileSync(abs(rel), 'utf8'));

// ── フロー台帳 ─────────────────────────────────────
if (!exists(LEDGER)) bail(`${LEDGER} がありません`);
const ledgerText = read(LEDGER);
const ledgerTable = tables(ledgerText.split('\n')).find((t) => t.header.includes('フローID'));
if (!ledgerTable) bail(`${LEDGER} にフローの表がありません`);
// 退避済み = このツールが備考に書いた定型の文言があり、その退避先の名前(<日時>-<フローID>[_<フローID>…])にそのフローが入っている。
// 備考に他のフローの退避先が書かれているだけ(例: やり直しのフローの「F-001 のやり直し。退避先 work/.archive/…-F-001/」)では退避済みとしない
const ARCHIVED_NOTE_RE = /成果物は再実行のため work\/\.archive\/([^/\s]+)\/ に退避した/g;
const archivedRow = (r) => [...String(r.obj['備考'] ?? '').matchAll(ARCHIVED_NOTE_RE)]
  .some((m) => m[1].replace(/^\d{8}-\d{6}-/, '').split('_').includes(r.obj['フローID']));
const rows = ledgerTable.rows.filter((r) => FLOW_RE.test(r.obj['フローID']));

const targets = [];
for (const f of opt.flows) {
  const r = rows.find((x) => x.obj['フローID'] === f);
  if (!r) bail(`${f} がフロー台帳にありません`);
  if (archivedRow(r)) bail(`${f} はすでに退避済みです(備考: ${r.obj['備考']})`);
  if (r.obj['種別'] !== 'new') bail(`${f} は種別 ${r.obj['種別']} です。やり直しは、その元になった通常フロー(new)を指定してください`);
  if (/^in-progress|^open$/.test(r.obj['状態'])) bail(`${f} は状態 ${r.obj['状態']} です。作業中のフローは退避しません(完了か中断にしてから)`);
  targets.push(r);
}
const codes = [...new Set(targets.flatMap((r) => idsIn(r.obj['対象機能コード'], /[A-Z][A-Z0-9]{1,9}/g)))];
if (codes.length === 0) bail('対象機能コードが台帳から読めません');

// 同じ機能コードを対象にした、退避しない他のフロー(再探索フローを含む)があれば止める(work/<機能コード>/ を共有しているため)
const others = rows.filter((r) => !opt.flows.includes(r.obj['フローID']) && !archivedRow(r));
const overlap = others.filter((r) => idsIn(r.obj['対象機能コード'], /[A-Z][A-Z0-9]{1,9}/g).some((c) => codes.includes(c)));
if (overlap.length) {
  bail(`機能コード ${codes.join(', ')} を対象にした他のフローがあります: ${overlap.map((r) => r.obj['フローID']).join(', ')}。` +
    `成果物を共有しているので、--flow で一緒に指定してください`);
}

// ── 退避するパス ───────────────────────────────────
const stamp = timestamp();
const archiveRel = `${ARCHIVE_MARK}${stamp}-${opt.flows.join('_')}`;
const moves = [];
for (const f of opt.flows) moves.push(`work/_flows/${f}`);
for (const c of codes) moves.push(`work/${c}`, `tests/specs/${c.toLowerCase()}`, `traceability/${c}-matrix.md`);

const remainingFeatures = listDirs('work').filter((d) => !d.startsWith('_') && !d.startsWith('.') && !codes.includes(d));
const fullReset = others.length === 0 && remainingFeatures.length === 0;
if (fullReset) moves.push('tests', 'playwright.config.ts');
// 他の退避するディレクトリの中にあるパスは、そのディレクトリごと移すので外す(tests/specs/usr と tests)
const plannedMoves = dedupe(moves).filter(exists).filter((m, _, all) => !all.some((p) => p !== m && m.startsWith(`${p}/`)));
const missing = dedupe(moves).filter((m) => !exists(m));

// ── 台帳から外す行 ─────────────────────────────────
const edits = [];
const removedHo = new Set();
if (exists(HANDOFF)) {
  const e = ledgerEdit(HANDOFF, '申し送り台帳', 'ID', (row) => opt.flows.some((f) => new RegExp(`^${f}(\\s|/|$)`).test(row.obj['発生元'] ?? '')));
  for (const r of e.remove) removedHo.add(r.obj['ID']);
  edits.push(e);
}
const partial = [];
for (const d of DEMANDS) {
  if (!exists(d.rel)) continue;
  const e = ledgerEdit(d.rel, d.name, d.idCol, (row) => {
    const refs = idsIn(row.obj['要求元'], /HO-[A-Z]+-\d+/g);
    const hit = refs.filter((x) => removedHo.has(x));
    if (hit.length && hit.length < refs.length) partial.push(`${d.name} ${row.obj[d.idCol]}(要求元: ${row.obj['要求元']})`);
    // 要求元が申し送りだけで、そのすべてを外したときだけ外す(作業02など他の要求元がある行は残す)
    const rest = String(row.obj['要求元'] ?? '').replace(/HO-[A-Z]+-\d+/g, '').replace(/[\s,、・]/g, '');
    return refs.length > 0 && hit.length === refs.length && rest === '';
  });
  edits.push(e);
}
const removedIds = edits.flatMap((e) => e.remove.map((r) => r.obj[e.idCol]));

// ── KB に残る参照(情報のみ。KB は変えない) ─────────
const movedFiles = plannedMoves.flatMap((m) => (fs.statSync(abs(m)).isDirectory() ? walk(m) : [m]));
const needles = [...removedIds, ...movedFiles.filter((p) => /\.(ts|md|yaml)$/.test(p))];
const kbRefs = [];
for (const p of exists('kb') ? walk('kb') : []) {
  if (!p.endsWith('.md')) continue;
  const t = read(p);
  const hits = needles.filter((n) => t.includes(n));
  if (hits.length) kbRefs.push(`${p}: ${hits.join(', ')}`);
}
const tracked = gitTracked(movedFiles);

// ── 表示 ───────────────────────────────────────────
const out = [];
out.push(`${opt.apply ? '退避します' : '確認だけです(--apply を付けると実行します)'}: ${opt.flows.join(', ')}(機能コード ${codes.join(', ')})`);
out.push(`退避先: ${archiveRel}/`);
out.push('', '■ 退避するもの');
for (const m of plannedMoves) out.push(`  ${m}${fs.statSync(abs(m)).isDirectory() ? '/' : ''}`);
if (fullReset) out.push('  (他のフローの成果物が残らないため、共有のテスト資産 tests/・playwright.config.ts も退避します)');
else out.push(`  (共有のテスト資産 tests/pages・flows・fixtures・helpers などは残します。他に残るフロー・機能: ${[...others.map((r) => r.obj['フローID']), ...remainingFeatures].join(', ')})`);
if (missing.length) out.push(`  なし(元から存在しない): ${missing.join(', ')}`);
out.push('', '■ 台帳から外す行(編集前の台帳は退避先の _ledgers-before/ に写します)');
for (const e of edits) out.push(`  ${e.name}: ${e.remove.length ? e.remove.map((r) => r.obj[e.idCol]).join(', ') : 'なし'}`);
out.push(`  フロー台帳: ${opt.flows.join(', ')} の行は残し、備考に退避先を追記します`);
if (partial.length) out.push('', '■ 手で直す行(要求元の一部だけが外した申し送り。行は残します)', ...partial.map((x) => `  ${x}`));
if (tracked.length) out.push('', `■ 注意: git で管理されているファイルを退避します(git では削除として見えます): ${tracked.length} 件`, ...tracked.slice(0, 10).map((x) => `  ${x}`));
if (kbRefs.length) out.push('', '■ KB に残る参照(KB は変えません。やり直しの探索で「参照先がない」と気づく場合があります)', ...kbRefs.map((x) => `  ${x}`));
out.push('', '■ 残すもの: KB・発見ログ・非決定値カタログ・機能一覧・禁止操作リスト・手順改善台帳・_assess・_improve・testid-requests.md');

if (!opt.apply) {
  console.log(out.join('\n'));
  process.exit(0);
}

// ── 実行 ───────────────────────────────────────────
const backup = `${archiveRel}/_ledgers-before`;
for (const rel of [LEDGER, HANDOFF, ...DEMANDS.map((d) => d.rel)]) {
  if (!exists(rel)) continue;
  fs.mkdirSync(abs(backup), { recursive: true });
  fs.copyFileSync(abs(rel), abs(`${backup}/${path.basename(rel)}`));
}
// 退避すると pms stats で集計できなくなるので、比較の基準として先に保存する(キューのないフローは集計なし)
const PMS = path.join(scriptDir, '..', 'pms', 'pms.mjs');
for (const f of opt.flows) {
  if (!exists(`work/_flows/${f}/queue.json`) || !fs.existsSync(PMS)) continue;
  const r = spawnSync(process.execPath, [PMS, 'stats', '--flow', f, '--root', ROOT], { encoding: 'utf8' });
  if (r.status === 0) {
    fs.mkdirSync(abs(`${archiveRel}/_baseline`), { recursive: true });
    fs.writeFileSync(abs(`${archiveRel}/_baseline/pms-stats-${f}.md`), r.stdout);
    out.push(`pms stats を保存しました: ${archiveRel}/_baseline/pms-stats-${f}.md`);
  } else out.push(`pms stats を保存できませんでした(${f}): ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
}
for (const m of plannedMoves) move(m, `${archiveRel}/${m}`);
for (const e of edits) {
  if (!e.remove.length) continue;
  const drop = new Set(e.remove.map((r) => r.line - 1));
  const lines = e.text.split('\n').filter((_, i) => !drop.has(i));
  write(e.rel, lines.join('\n'));
}
const date = stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8);
const note = `成果物は再実行のため ${archiveRel}/ に退避した(${date}。tools/flow-reset)。やり直しは新しいフローで行う`;
const llines = ledgerText.split('\n');
for (const r of targets) {
  const i = r.line - 1;
  const body = llines[i].replace(/\s*\|\s*$/, '').trimEnd();
  llines[i] = `${body}${isBlank(r.obj['備考']) ? ' ' : '。'}${note} |`;
}
write(LEDGER, llines.join('\n'));
out.push('', `退避しました: ${archiveRel}/`);
console.log(out.join('\n'));

// ── 関数 ───────────────────────────────────────────
function ledgerEdit(rel, name, idCol, pick) {
  const text = read(rel);
  const sec = sectionLines(text, '台帳', 2);
  const t = sec ? tables(sec.lines, sec.offset).find((x) => x.header.includes(idCol)) : null;
  const remove = t ? t.rows.filter((r) => !isBlank(r.obj[idCol]) && pick(r)) : [];
  return { rel, name, idCol, text, remove };
}

function move(from, to) {
  fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
  try {
    fs.renameSync(abs(from), abs(to));
  } catch (err) {
    if (!['EXDEV', 'EPERM', 'EBUSY'].includes(err.code)) throw err;
    fs.cpSync(abs(from), abs(to), { recursive: true });
    fs.rmSync(abs(from), { recursive: true, force: true });
  }
}

function write(rel, text) {
  const tmp = `${abs(rel)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, abs(rel));
}

function listDirs(rel) {
  if (!exists(rel)) return [];
  return fs.readdirSync(abs(rel), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

function walk(rel) {
  const out = [];
  for (const e of fs.readdirSync(abs(rel), { withFileTypes: true })) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function gitTracked(files) {
  if (files.length === 0) return [];
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '--', ...files], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

function dedupe(a) { return [...new Set(a)]; }

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function bail(msg) {
  process.stderr.write(`flow-reset: ${msg}\n`);
  process.exit(2);
}

function help() {
  process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
}
