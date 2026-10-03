#!/usr/bin/env node
// run-scenarios.mjs — 開始前シナリオの実行(00_common.md ■回帰実行の環境前提 開始前シナリオ)
//
//   node tools/pre-stage/run-scenarios.mjs --hook work10 --flow F-003   作業10の工程0で使う
//   node tools/pre-stage/run-scenarios.mjs --hook work20 --flow F-003   作業20の工程0で使う
//   node tools/pre-stage/run-scenarios.mjs --hook <任意の名前>           他の用途(設定に同じ名前の hook を書く)
//   node tools/pre-stage/run-scenarios.mjs --list                       設定されている hook とシナリオを表示する
//   node tools/pre-stage/run-scenarios.mjs --restore-scope              復元範囲(ゴールデンイメージの復元で戻る対象)を JSON で出す
//
// 設定ファイル(既定 config/pre-stage-scenarios.json)の hooks.<hook> に書いたエントリを上から順に実行する。
// エントリは2種類(vocab.pre_stage_entry_kind)で、1つのエントリにはどちらか一方だけを書く。
//   シナリオのエントリ: scenarios に1つ以上のシナリオID を書き、書いた順に Playwright の回帰テスト(@<シナリオID> のタグ)を実行する。
//   外部操作のエントリ: op(KB T05 の操作ID)と run(実行体の呼び出し。文字列の配列)を書き、run をそのまま実行する。
//     終了コード0を成功とし、標準出力が JSON なら結果の output に残す(例: 時刻合わせの前後のずれ)。
// 設定ファイルがない、hook がない、hook が空のときは何もしない(state: skipped)。
//
// 復元エントリ: エントリに restores(戻す対象の配列)を書くと、そのエントリはゴールデンイメージの復元の一部になる
// (00_common.md ■回帰実行の環境前提 ゴールデンイメージと復元範囲)。restores を書いたエントリは on_failure: stop でなければならない。
// 復元範囲に入るのは、VM の復元で戻る対象と、hooks.work10 と hooks.work20 の両方の復元エントリが restores に書いた対象である
// (--restore-scope。片方にしかない対象は partial として出し、復元範囲に数えない)。
//
// オプション:
//   --hook <名前>       実行する hook(必須。--list のときは不要)
//   --flow <F-xxx>      記録に残すフローID(任意)
//   --config <path>     設定ファイル(既定: <root>/config/pre-stage-scenarios.json)
//   --root <dir>        リポジトリのルート(既定: このスクリプトの2階層上)
//   --no-log            実行記録(work/_common/pre-stage-log.jsonl)に追記しない
//
// 標準出力: 結果の JSON 1行 { state, run_id, hook, flow_id, results: [...] }
//   state: skipped(設定なし)/ passed(全件成功)/ warning(on_failure: continue のエントリだけが失敗)/ failed
// 終了コード: 0 = skipped / passed / warning、1 = failed(作業を始めない)、2 = 設定の誤り・実行できない
// 環境変数 PMS_RESTORE は外して実行する(globalSetup による VM の復元を二重に行わないため)。
// 依存: Node.js 18 以上のみ(Playwright は設定の command で呼ぶ)。テスト: node --test tools/pre-stage/test/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const opt = { hook: null, flow: null, config: null, root: null, log: true, list: false, scope: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => { const v = args[++i]; if (v === undefined) fail(`${a} の値がありません`); return v; };
  if (a === '--hook') opt.hook = next();
  else if (a === '--flow') opt.flow = next();
  else if (a === '--config') opt.config = next();
  else if (a === '--root') opt.root = next();
  else if (a === '--no-log') opt.log = false;
  else if (a === '--list') opt.list = true;
  else if (a === '--restore-scope') opt.scope = true;
  else if (a === '-h' || a === '--help') { help(); process.exit(0); }
  else fail(`不明な引数: ${a}`);
}
if (!opt.list && !opt.scope && !opt.hook) fail('--hook を指定してください(例: --hook work10)');
if (opt.flow && !/^F-\d{3}$/.test(opt.flow)) fail(`--flow は F-<3桁> で指定してください: ${opt.flow}`);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(opt.root ?? path.join(scriptDir, '..', '..'));
const CONFIG = path.resolve(ROOT, opt.config ?? path.join('config', 'pre-stage-scenarios.json'));
const SCENARIO_ID = /^SC-[A-Z0-9]+-\d{2,}$/;
const OPERATION_ID = /^OP-[A-Z0-9]+-\d{3}$/;

// ── 設定 ─────────────────────────────────────────────
let config = null;
if (fs.existsSync(CONFIG)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { fail(`設定ファイルを JSON として読めません(${rel(CONFIG)}): ${e.message}`); }
  validate(config);
}

if (opt.scope) {
  console.log(JSON.stringify(restoreScope(config)));
  process.exit(0);
}

if (opt.list) {
  if (!config) { console.log(`設定ファイルがありません(${rel(CONFIG)})。開始前シナリオは実行されません`); process.exit(0); }
  for (const [name, entries] of Object.entries(config.hooks ?? {})) {
    console.log(`${name}:${entries.length ? '' : ' (空)'}`);
    for (const e of entries) console.log(`  - ${e.name}: ${e.op ? `外部操作 ${e.op}(${e.run.join(' ')})` : e.scenarios.join(', ')}(失敗したら ${e.on_failure ?? 'stop'})${e.restores ? ` [復元: ${e.restores.join(', ')}]` : ''}`);
  }
  process.exit(0);
}

const runId = `PRE-${stamp()}-${crypto.randomBytes(2).toString('hex')}`;
const entries = config?.hooks?.[opt.hook] ?? [];
if (!config || entries.length === 0) {
  const reason = !config ? `設定ファイルがありません(${rel(CONFIG)})` : `hook ${opt.hook} が設定されていません`;
  finish({ state: 'skipped', reason, results: [] });
}

// ── 実行 ─────────────────────────────────────────────
const command = Array.isArray(config.command) && config.command.length ? config.command : ['npx', 'playwright', 'test'];
const timeoutMs = Number(config.timeout_sec ?? 1800) * 1000;
const results = [];
let state = 'passed';
outer:
for (const e of entries) {
  const onFailure = e.on_failure ?? 'stop';
  if (e.op) {
    const r = runOperation(e);
    results.push({ name: e.name, op: e.op, result: r.result, duration_sec: r.duration, message: r.message ?? null, ...(r.output !== undefined ? { output: r.output } : {}), ...(e.restores ? { restores: e.restores } : {}) });
    process.stderr.write(`[pre-stage] ${opt.hook} / ${e.name} / ${e.op}: ${r.result}${r.message ? ` — ${r.message}` : ''}\n`);
    if (r.result !== 'passed') {
      if (onFailure === 'continue') { if (state === 'passed') state = 'warning'; continue; }
      state = 'failed';
      break;
    }
    continue;
  }
  for (const id of e.scenarios) {
    const r = runScenario(id, e);
    results.push({ name: e.name, scenario: id, result: r.result, duration_sec: r.duration, message: r.message ?? null, ...(e.restores ? { restores: e.restores } : {}) });
    process.stderr.write(`[pre-stage] ${opt.hook} / ${e.name} / ${id}: ${r.result}${r.message ? ` — ${r.message}` : ''}\n`);
    if (r.result !== 'passed') {
      if (onFailure === 'continue') { if (state === 'passed') state = 'warning'; break; }
      state = 'failed';
      break outer;
    }
  }
}
finish({ state, results });

// ════════════════════════════════════════════════════════
function runScenario(id, entry) {
  const out = path.join(os.tmpdir(), `pms-pre-stage-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  const argv = [...command.slice(1), '--grep', `@${id}\\b`, '--reporter=json'];
  if (entry.project) argv.push('--project', entry.project);
  if (config.playwright_config) argv.push('--config', config.playwright_config);
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out };
  delete env.PMS_RESTORE;
  const started = Date.now();
  const r = spawnSync(command[0], argv, {
    cwd: ROOT, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    shell: process.platform === 'win32', stdio: ['ignore', 'ignore', 'pipe'],
  });
  const duration = Math.round((Date.now() - started) / 100) / 10;
  if (r.error) return { result: 'failed', duration, message: r.error.code === 'ETIMEDOUT' ? `時間切れ(${timeoutMs / 1000} 秒)` : `起動できません: ${r.error.message}` };
  let report = null;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* 下で扱う */ } finally { fs.rmSync(out, { force: true }); }
  if (!report) return { result: 'failed', duration, message: `結果(JSON)が得られません(終了コード ${r.status})。${lastLine(r.stderr)}` };
  const specs = collectSpecs(report.suites ?? []).filter((s) => hasTag(s, id));
  if (specs.length === 0) return { result: 'not_found', duration, message: `@${id} のタグの付いたテストが見つかりません(回帰テストになっていない、またはシナリオIDの誤り)` };
  const statuses = specs.flatMap((s) => (s.tests ?? []).map((t) => t.status));
  if (statuses.length === 0 || statuses.some((st) => st === 'unexpected' || st === 'skipped')) {
    return { result: 'failed', duration, message: `テストが成功しませんでした(${statuses.join(', ') || '結果なし'})` };
  }
  return { result: 'passed', duration };
}

function runOperation(entry) {
  const env = { ...process.env };
  delete env.PMS_RESTORE;
  const started = Date.now();
  const r = spawnSync(entry.run[0], entry.run.slice(1), {
    cwd: ROOT, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const duration = Math.round((Date.now() - started) / 100) / 10;
  if (r.error) return { result: 'failed', duration, message: r.error.code === 'ETIMEDOUT' ? `時間切れ(${timeoutMs / 1000} 秒)` : `起動できません: ${r.error.message}` };
  let output;
  const text = String(r.stdout ?? '').trim();
  if (text) { try { output = JSON.parse(text); } catch { output = undefined; } }
  if (r.status !== 0) return { result: 'failed', duration, output, message: `実行体が失敗しました(終了コード ${r.status})。${lastLine(r.stderr)}` };
  return { result: 'passed', duration, output };
}

function collectSpecs(suites) {
  const out = [];
  const walk = (s) => { for (const sp of s.specs ?? []) out.push(sp); for (const c of s.suites ?? []) walk(c); };
  suites.forEach(walk);
  return out;
}

function hasTag(spec, id) {
  const tags = (spec.tags ?? []).map((t) => (String(t).startsWith('@') ? String(t) : `@${t}`));
  return new RegExp(`@${id}\\b`).test(`${spec.title ?? ''} ${tags.join(' ')}`);
}

function validate(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('設定ファイルの最上位はオブジェクトにしてください');
  if (c.hooks == null) { c.hooks = {}; return; }
  if (typeof c.hooks !== 'object' || Array.isArray(c.hooks)) fail('hooks はオブジェクト({ "<hook名>": [エントリ, ...] })にしてください');
  if (c.command != null && !(Array.isArray(c.command) && c.command.every((x) => typeof x === 'string'))) fail('command は文字列の配列にしてください(例: ["npx", "playwright", "test"])');
  for (const [name, list] of Object.entries(c.hooks)) {
    if (!Array.isArray(list)) fail(`hooks.${name} は配列にしてください`);
    list.forEach((e, i) => {
      const where = `hooks.${name}[${i}]`;
      if (!e || typeof e !== 'object') fail(`${where} はオブジェクトにしてください`);
      if (!e.name) fail(`${where} に name(目的。例: 機器のゴールデンイメージ復元)がありません`);
      const isOp = e.op != null || e.run != null;
      if (isOp && e.scenarios != null) fail(`${where} に scenarios と op・run の両方があります(1つのエントリはシナリオか外部操作のどちらか一方)`);
      if (isOp) {
        if (!OPERATION_ID.test(String(e.op ?? ''))) fail(`${where} の op(KB T05 の操作ID)がない、または書式(OP-<対象略号>-<3桁>)に合いません`);
        if (!Array.isArray(e.run) || e.run.length === 0 || !e.run.every((x) => typeof x === 'string' && x)) fail(`${where} の run は、実行体の呼び出し(文字列の配列)にしてください(例: ["pwsh", "-File", "Sync-Clock.ps1"])`);
      } else {
        if (!Array.isArray(e.scenarios) || e.scenarios.length === 0) fail(`${where} に scenarios(シナリオIDの配列)、または op と run(外部操作)がありません`);
        for (const id of e.scenarios) if (!SCENARIO_ID.test(String(id))) fail(`${where} のシナリオID ${id} が書式(SC-<機能コード>-<連番>)に合いません`);
      }
      if (e.on_failure != null && !['stop', 'continue'].includes(e.on_failure)) fail(`${where} の on_failure は stop / continue のいずれかにしてください`);
      if (e.restores != null) {
        if (!Array.isArray(e.restores) || e.restores.length === 0 || !e.restores.every((x) => typeof x === 'string' && x.trim())) fail(`${where} の restores は、戻す対象(文字列)の配列にしてください(例: ["実機:MFP-A の設定"])`);
        if ((e.on_failure ?? 'stop') !== 'stop') fail(`${where} は復元エントリ(restores あり)なので on_failure は stop にしてください(失敗したまま作業を始めると、復元範囲の前提が崩れるため)`);
      }
    });
  }
}

// 復元範囲: VM の復元で戻る対象(固定)+ hooks.work10 と hooks.work20 の両方の復元エントリ(シナリオ・外部操作)が restores に書いた対象
function restoreScope(c) {
  const VM = ['VM:PMSサーバ(OS・IIS・サービス・DB・VM 上のシミュレータを含む)'];
  const of = (hook) => new Map((c?.hooks?.[hook] ?? []).filter((e) => e.restores).flatMap((e) => e.restores.map((t) => [t.trim(), e])));
  const by = (e, hook) => (e.op ? { [`op_${hook}`]: e.op } : { [`scenarios_${hook}`]: e.scenarios });
  const w10 = of('work10');
  const w20 = of('work20');
  const targets = [...new Set([...w10.keys(), ...w20.keys()])].sort();
  const scenarios = targets.filter((t) => w10.has(t) && w20.has(t)).map((t) => ({ target: t, ...by(w10.get(t), 'work10'), ...by(w20.get(t), 'work20') }));
  const partial = targets.filter((t) => !(w10.has(t) && w20.has(t))).map((t) => ({ target: t, only_in: w10.has(t) ? 'work10' : 'work20' }));
  return { config: c ? rel(CONFIG) : null, vm: VM, scenarios, partial };
}

function finish(res) {
  const out = { state: res.state, run_id: runId, hook: opt.hook, flow_id: opt.flow, config: config ? rel(CONFIG) : null, ...(res.reason ? { reason: res.reason } : {}), results: res.results, finished_at: new Date().toISOString() };
  if (opt.log && res.state !== 'skipped') {
    const logPath = path.join(ROOT, 'work', '_common', 'pre-stage-log.jsonl');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(out) + '\n');
  }
  console.log(JSON.stringify(out));
  process.exit(res.state === 'failed' ? 1 : 0);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }
function lastLine(s) { const l = String(s ?? '').trim().split('\n').filter(Boolean); return l.length ? l[l.length - 1].slice(0, 300) : ''; }
function fail(msg) { console.error(`ERROR: ${msg}`); process.exit(2); }
function help() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const end = text.findIndex((l, i) => i > 1 && !l.startsWith('//'));
  console.log(text.slice(1, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
