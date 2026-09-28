#!/usr/bin/env node
// build-skills.mjs — 手順書の正本(procedure/)から、作業ごとの skills を生成する。
//
//   node tools/build-skills/build-skills.mjs            生成する(全ターゲット)
//   node tools/build-skills/build-skills.mjs --check    生成物が正本と一致するか検査する(lint skills_in_sync)
//   オプション: --target <id>  特定のターゲットだけ(copilot / kiro)
//               --root <dir>   リポジトリのルート(既定: このスクリプトの2階層上)
//
// 依存: Node.js 18 以上のみ(外部パッケージ不要)。
//
// 生成物(<ターゲットの dir>/pms-*/)を直接編集しないこと。手順の変更は procedure/ に対して行い、
// このスクリプトで再生成する(00_common.md ■手順書の版と配備)。
// このスクリプトは設定にある skill のディレクトリだけを作り直し、同じ skills ディレクトリにある
// 他の skill(外部操作 skill など)には触れない。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 引数 ─────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = { check: false, target: null, root: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--check') opt.check = true;
  else if (a === '--target') opt.target = args[++i];
  else if (a === '--root') opt.root = args[++i];
  else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  else fail(`不明な引数: ${a}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(opt.root ?? path.join(scriptDir, '..', '..'));
const CONFIG_PATH = path.join(ROOT, 'procedure', 'skills.config.json');

const errors = [];
const warnings = [];

// ── 読み込み ───────────────────────────────────────────
const config = JSON.parse(readText(CONFIG_PATH));
const refs = config.shared_references;
const src = {
  common: readText(path.join(ROOT, refs.common)),
  vocab: readText(path.join(ROOT, refs.vocab)),
  pipeline: readText(path.join(ROOT, refs.pipeline)),
  stages: readText(path.join(ROOT, refs.stages)),
};
const templatesDir = path.join(ROOT, refs.templates_dir);
const templateFiles = fs.readdirSync(templatesDir).filter((f) => /^\d\d_.+\.md$/.test(f)).sort();

const versionMatch = src.vocab.match(/^\s{2}procedure_version:\s*(proc-v\d{3})\b/m);
if (!versionMatch) fail(`${refs.vocab} の meta.procedure_version(proc-v<3桁>)が見つかりません`);
const VERSION = versionMatch[1];

const stages = parseStages(src.stages);

// 保護ブロック(正本側)の一覧: ID → 本文の集合
const sourceBlocks = new Map();
collectBlocks(src.common, 'md', refs.common, sourceBlocks);
collectBlocks(src.vocab, 'yaml', refs.vocab, sourceBlocks);
collectBlocks(src.pipeline, 'dot', refs.pipeline, sourceBlocks);
collectBlocks(src.stages, 'md', refs.stages, sourceBlocks);
for (const f of templateFiles) collectBlocks(readText(path.join(templatesDir, f)), 'md', f, sourceBlocks);

// ── 生成(メモリ上) ─────────────────────────────────────
const targets = config.targets.filter((t) => !opt.target || t.id === opt.target);
if (targets.length === 0) fail(`ターゲット ${opt.target} は設定にありません`);

const output = new Map(); // リポジトリ相対パス → 内容
const managedDirs = [];   // 作り直す skill ディレクトリ(リポジトリ相対)
const sizeReport = [];

for (const target of targets) {
  // 入口(ルーター)
  buildRouter(target);
  // 作業ごとの skill
  for (const sk of config.skills) buildWorkSkill(target, sk);
}

// 生成物の保護ブロック検査
for (const [rel, content] of output) {
  const kind = rel.endsWith('.yaml') ? 'yaml' : rel.endsWith('.dot') ? 'dot' : rel.endsWith('.md') ? 'md' : null;
  if (!kind) continue;
  const blocks = new Map();
  collectBlocks(content, kind, rel, blocks);
  for (const [id, texts] of blocks) {
    const allowed = sourceBlocks.get(id);
    for (const t of texts) {
      if (!allowed || !allowed.has(t)) errors.push(`${rel}: 保護ブロック ${id} の内容が正本と一致しません`);
    }
  }
}

if (errors.length) report(1);

// ── 書き出し or 検査 ──────────────────────────────────
if (opt.check) {
  const diffs = [];
  for (const dir of managedDirs) {
    const abs = path.join(ROOT, dir);
    const onDisk = fs.existsSync(abs) ? listFiles(abs).map((f) => path.posix.join(dir, f)) : [];
    const expected = [...output.keys()].filter((k) => k.startsWith(dir + '/'));
    for (const rel of expected) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) diffs.push(`なし   ${rel}`);
      else if (normalize(fs.readFileSync(p, 'utf8')) !== output.get(rel)) diffs.push(`不一致 ${rel}`);
    }
    for (const rel of onDisk) if (!output.has(rel)) diffs.push(`余分   ${rel}`);
  }
  if (diffs.length) {
    console.error(`skills_in_sync: NG(${diffs.length} 件)— 生成物が正本(${VERSION})と一致しません。`);
    for (const d of diffs) console.error('  ' + d);
    console.error('正本(procedure/)を直してから、node tools/build-skills/build-skills.mjs で再生成してください。生成物は直接編集しないでください。');
    report(1, true);
  }
  console.log(`skills_in_sync: OK — ${managedDirs.length} 個の skill が正本(${VERSION})と一致しています。`);
  report(0, true);
} else {
  for (const dir of managedDirs) fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  for (const [rel, content] of output) {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  console.log(`生成しました — 手順版 ${VERSION} / ${managedDirs.length} 個の skill`);
  for (const line of sizeReport) console.log('  ' + line);
  report(0);
}

// ════════════════════════════════════════════════════════
// 生成
// ════════════════════════════════════════════════════════

function buildRouter(target) {
  const r = config.router;
  const dir = `${target.dir}/${r.name}`;
  managedDirs.push(dir);
  checkName(r.name, r.description);

  let body = readText(path.join(ROOT, r.source));
  body = body
    .replaceAll('{{PROCEDURE_VERSION}}', VERSION)
    .replaceAll('{{SELF_DIR}}', dir)
    .replaceAll('{{SKILLS_DIR}}', target.dir);
  const leftover = body.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) errors.push(`${r.source}: 置換されない差し込み ${leftover[0]} があります`);

  const skillMd =
    frontmatter(target, { name: r.name, description: r.description, invocation: 'auto', source: r.source }) +
    generatedNotice(r.source) +
    body;
  put(`${dir}/SKILL.md`, skillMd);

  const refMap = { pipeline: ['pipeline.dot', src.pipeline], vocab: ['vocab.yaml', src.vocab], common: ['00_common.md', src.common] };
  for (const key of r.references) {
    const [name, text] = refMap[key] ?? [];
    if (!name) { errors.push(`router.references に不明な値: ${key}`); continue; }
    put(`${dir}/references/${name}`, text);
  }
  put(`${dir}/VERSION`, versionFile(r.source));
  sizeReport.push(sizeLine(dir));
}

function buildWorkSkill(target, sk) {
  const dir = `${target.dir}/${sk.name}`;
  managedDirs.push(dir);
  checkName(sk.name, sk.description);

  const sec = stages.sections.get(sk.section);
  if (!sec) { errors.push(`${refs.stages} に §${sk.section} がありません(skill ${sk.name})`); return; }

  // 同梱する付録とテンプレート(stages.md の「参照付録」「参照テンプレート」の行が正)
  const decl = parseDeclaration(sec, sk.section);
  if (!decl) return;
  checkMentions(sec, decl, sk.section);

  // references
  put(`${dir}/references/00_common.md`, src.common);
  put(`${dir}/references/vocab.yaml`, src.vocab);
  const appendixFiles = [];
  for (const letter of decl.appendices) {
    const ap = stages.appendices.get(letter);
    if (!ap) { errors.push(`§${sk.section} の参照付録 ${letter} が ${refs.stages} にありません`); continue; }
    const fname = `appendix-${letter}.md`;
    put(`${dir}/references/${fname}`, ap.text);
    appendixFiles.push({ letter, title: ap.title, file: `references/${fname}` });
  }
  const tplFiles = [];
  for (const num of decl.templates) {
    const f = templateFiles.find((t) => t.startsWith(num + '_'));
    if (!f) { errors.push(`§${sk.section} の参照テンプレート ${num} が ${refs.templates_dir} にありません`); continue; }
    put(`${dir}/references/templates/${f}`, readText(path.join(templatesDir, f)));
    tplFiles.push({ num, file: `references/templates/${f}` });
  }

  // SKILL.md
  const source = `${refs.stages} §${sk.section}`;
  const header = workSkillHeader({ dir, sk, appendixFiles, tplFiles });
  const skillMd =
    frontmatter(target, { name: sk.name, description: sk.description, invocation: sk.invocation, source }) +
    generatedNotice(source) +
    header +
    '\n---\n\n' +
    sec.text.trimEnd() + '\n';
  put(`${dir}/SKILL.md`, skillMd);
  put(`${dir}/VERSION`, versionFile(source));

  // 節の中の保護ブロックが、SKILL.md に過不足なく写っていること
  const inSec = countBlocks(sec.text);
  const inOut = countBlocks(skillMd);
  if (inSec !== inOut) errors.push(`${dir}/SKILL.md: 保護ブロックの数が正本の §${sk.section} と一致しません(${inOut} / ${inSec})`);

  sizeReport.push(sizeLine(dir));
}

function workSkillHeader({ dir, sk, appendixFiles, tplFiles }) {
  const L = [];
  L.push(`# 作業${sk.section} ${sk.title}(手順版 ${VERSION})`);
  L.push('');
  L.push(`この skill は、手順書の正本の \`stages.md\` §${sk.section} を本文とし、作業に必要な規約・語彙・付録・記入用テンプレートを \`references/\` に同梱したものである。本文(下の「---」以降)が指示である。`);
  L.push('');
  L.push('## 起動時に読むもの(この順で。省略しない)');
  L.push('');
  L.push(`1. \`${dir}/references/00_common.md\` を全文読む(全作業に適用される既定)`);
  L.push(`2. \`${dir}/references/vocab.yaml\` を全文読む(統制語彙)`);
  L.push('3. 作業場所の `kb/00_索引.md` を読む(KB は索引のみ。全読みしない。00 ■知見ベース)');
  L.push('4. 対象フローがあれば、作業場所の `work/_flows/F-<番号>/flow.md` を読み、現在地と手順版を確かめる');
  L.push('5. 付録と記入用テンプレートは、本文で参照されたときに下の表のファイルを開く');
  L.push('');
  L.push('## 本文の呼び名と、このskillのファイル');
  L.push('');
  L.push('| 本文での呼び名 | ファイル |');
  L.push('|---|---|');
  L.push(`| \`00_common.md\`・「00」・「00 ■〇〇」 | \`${dir}/references/00_common.md\` |`);
  L.push(`| \`vocab.yaml\`・\`vocab.〇〇\` | \`${dir}/references/vocab.yaml\` |`);
  for (const a of appendixFiles) L.push(`| 付録${a.letter}(${a.title}) | \`${dir}/${a.file}\` |`);
  for (const t of tplFiles) L.push(`| テンプレート${t.num} | \`${dir}/${t.file}\`(書式の原本。記入先は本文が示す \`work/\` 配下) |`);
  L.push('| `pipeline.dot`・`stages.md` の他の節・上にない付録 | この skill には含まれない。**読まない**(他の作業の関心を混ぜないため。00 ■AIへの渡し方) |');
  L.push('| 上にない記入用テンプレート | 書式が必要なら、作業場所の記入済みの台帳(`work/_common/` 配下)の既存の行に合わせる |');
  L.push('');
  L.push('## 手順書を書き換えない');
  L.push('');
  L.push(`この skill と \`references/\` は、正本(\`procedure/\`)から生成したものである。手順について迷った・矛盾を見つけた・実行できなかった・手順と違う方法で実施した場合は、書き換えずに手順改善シグナルとして記録する(00 ■手順改善シグナル)。status.yaml の \`procedure_version\` には \`${VERSION}\` をそのまま転記する。`);
  if (sk.extra_notes?.length) {
    L.push('');
    L.push('## この作業に固有の注意');
    L.push('');
    for (const n of sk.extra_notes) L.push(`- ${n}`);
  }
  L.push('');
  L.push('## 8スロット規約(本文の読み方)');
  L.push('');
  L.push(stages.slotRule.trim().replace(/^## ■ 8スロット規約\s*\n+/, ''));
  L.push('');
  return L.join('\n');
}

function frontmatter(target, { name, description, invocation, source }) {
  const L = ['---', `name: ${name}`, `description: ${yamlString(description)}`];
  if (target.frontmatter === 'copilot' && invocation === 'manual') L.push('disable-model-invocation: true');
  L.push('metadata:');
  L.push(`  procedure_version: ${VERSION}`);
  L.push(`  generated_from: ${yamlString(source)}`);
  L.push('---', '');
  return L.join('\n');
}

function generatedNotice(source) {
  return `<!-- 自動生成。このファイルを直接編集しないこと。正本: ${source} / 手順版: ${VERSION} / 生成: tools/build-skills/build-skills.mjs -->\n\n`;
}

function versionFile(source) {
  return `procedure_version: ${VERSION}\ngenerated_from: ${source}\ngenerator: tools/build-skills/build-skills.mjs\n`;
}

// ════════════════════════════════════════════════════════
// stages.md の解析
// ════════════════════════════════════════════════════════

function parseStages(text) {
  const lines = text.split('\n');
  const sections = new Map();
  const appendices = new Map();
  let inFence = false;
  let current = null; // { kind, key, title, start }
  const heads = [];
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    let m;
    if ((m = line.match(/^# §(\d\d) (.+)$/))) heads.push({ kind: 'section', key: m[1], title: m[2].trim(), start: i });
    else if ((m = line.match(/^# 付録([A-Z]): (.+)$/))) heads.push({ kind: 'appendix', key: m[1], title: m[2].trim(), start: i });
  });
  if (inFence) errors.push(`${refs.stages}: コードブロックの閉じ忘れがあります`);
  heads.forEach((h, idx) => {
    const end = idx + 1 < heads.length ? heads[idx + 1].start : lines.length;
    const body = trimSeparators(lines.slice(h.start, end)).join('\n') + '\n';
    const entry = { title: h.title, text: body };
    const map = h.kind === 'section' ? sections : appendices;
    if (map.has(h.key)) errors.push(`${refs.stages}: ${h.kind === 'section' ? '§' : '付録'}${h.key} が重複しています`);
    map.set(h.key, entry);
  });
  const pre = heads.length ? lines.slice(0, heads[0].start).join('\n') : text;
  const slot = pre.match(/## ■ 8スロット規約[\s\S]*?(?=\n## ■ |\n# |$)/);
  if (!slot) errors.push(`${refs.stages}: 「## ■ 8スロット規約」が見つかりません`);
  return { sections, appendices, slotRule: slot ? slot[0] : '' };
}

function trimSeparators(ls) {
  const out = [...ls];
  while (out.length && /^\s*(---)?\s*$/.test(out[out.length - 1])) out.pop();
  return out;
}

function parseDeclaration(sec, key) {
  const m = sec.text.match(/^参照付録: (.+?) \/ 参照テンプレート: (.+)$/m);
  if (!m) { errors.push(`${refs.stages} §${key}: 「参照付録: … / 参照テンプレート: …」の行がありません`); return null; }
  const list = (s) => (s.trim() === 'なし' ? [] : s.split(/[,、]\s*/).map((x) => x.trim()).filter(Boolean));
  const appendices = list(m[1]);
  const templates = list(m[2]);
  for (const a of appendices) if (!/^[A-Z]$/.test(a)) errors.push(`§${key}: 参照付録の値が不正です: ${a}`);
  for (const t of templates) if (!/^\d\d$/.test(t)) errors.push(`§${key}: 参照テンプレートの値が不正です: ${t}`);
  return { appendices, templates };
}

// 本文で参照している付録・テンプレートが、宣言の行に含まれていることを確かめる
function checkMentions(sec, decl, key) {
  const body = sec.text.replace(/^参照付録: .+$/m, '');
  const apMentioned = new Set([...body.matchAll(/付録([A-Z])/g)].map((m) => m[1]));
  const tpMentioned = new Set([...body.matchAll(/テンプレート\s*(\d\d)/g)].map((m) => m[1]));
  for (const a of apMentioned) if (!decl.appendices.includes(a)) errors.push(`§${key}: 本文が付録${a}を参照していますが「参照付録」の行にありません`);
  for (const t of tpMentioned) if (!decl.templates.includes(t)) errors.push(`§${key}: 本文がテンプレート${t}を参照していますが「参照テンプレート」の行にありません`);
}

// ════════════════════════════════════════════════════════
// 保護ブロック
// ════════════════════════════════════════════════════════

function markerSet(kind) {
  return {
  md: { open: /^<!-- protected:([A-Z_]+) -->$/, close: /^<!-- \/protected:([A-Z_]+) -->$/ },
  yaml: { open: /^# <protected:([A-Z_]+)>$/, close: /^# <\/protected:([A-Z_]+)>$/ },
  dot: { open: /^\/\* <protected:([A-Z_]+)> \*\/$/, close: /^\/\* <\/protected:([A-Z_]+)> \*\/$/ },
  }[kind];
}

function collectBlocks(text, kind, label, into) {
  const mk = markerSet(kind);
  const lines = text.split('\n');
  let open = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    let m;
    if ((m = line.match(mk.open))) {
      if (open) errors.push(`${label}:${i + 1}: 保護ブロック ${open.id} の中で ${m[1]} が開始されています`);
      open = { id: m[1], start: i };
    } else if ((m = line.match(mk.close))) {
      if (!open || open.id !== m[1]) { errors.push(`${label}:${i + 1}: 保護ブロック ${m[1]} の終了に対応する開始がありません`); open = null; return; }
      const body = lines.slice(open.start + 1, i).join('\n');
      if (!into.has(open.id)) into.set(open.id, new Set());
      into.get(open.id).add(body);
      open = null;
    }
  });
  if (open) errors.push(`${label}: 保護ブロック ${open.id} が閉じられていません`);
}

function countBlocks(text) {
  return (text.match(/^<!-- protected:[A-Z_]+ -->$/gm) || []).length;
}

// ════════════════════════════════════════════════════════
// 補助
// ════════════════════════════════════════════════════════

function put(rel, content) {
  const norm = normalize(content);
  if (output.has(rel) && output.get(rel) !== norm) errors.push(`生成先が重複しています: ${rel}`);
  output.set(rel, norm);
}

function normalize(s) {
  return s.replace(/\r\n/g, '\n');
}

function readText(p) {
  if (!fs.existsSync(p)) fail(`ファイルがありません: ${path.relative(ROOT, p) || p}`);
  return normalize(fs.readFileSync(p, 'utf8'));
}

function listFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

function checkName(name, description) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) errors.push(`skill名が不正です(英小文字・数字・ハイフン、64文字以内): ${name}`);
  if (!description || description.length > 1024) errors.push(`${name}: description は1〜1024文字にしてください(現在 ${description?.length ?? 0} 文字)`);
}

function yamlString(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function sizeLine(dir) {
  const files = [...output.keys()].filter((k) => k.startsWith(dir + '/'));
  const bytes = files.reduce((n, k) => n + Buffer.byteLength(output.get(k), 'utf8'), 0);
  const skill = Buffer.byteLength(output.get(`${dir}/SKILL.md`) ?? '', 'utf8');
  return `${dir}  (ファイル ${files.length} / 合計 ${(bytes / 1024).toFixed(0)} KB / SKILL.md ${(skill / 1024).toFixed(0)} KB)`;
}

function report(code, quiet = false) {
  for (const w of warnings) console.warn('WARNING: ' + w);
  if (errors.length) {
    const uniq = [...new Set(errors)];
    console.error(`ERROR ${uniq.length} 件 — 生成物は書き出していません。`);
    for (const e of uniq) console.error('  ' + e);
    process.exit(1);
  }
  if (!quiet && code) process.exit(code);
  process.exit(code);
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function printHelp() {
  console.log(`使い方:
  node tools/build-skills/build-skills.mjs            skills を生成する
  node tools/build-skills/build-skills.mjs --check    生成物が正本と一致するか検査する
オプション:
  --target <id>   特定のターゲットだけ(設定の targets[].id)
  --root <dir>    リポジトリのルート(既定: このスクリプトの2階層上)`);
}
