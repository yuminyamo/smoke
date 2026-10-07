#!/usr/bin/env node
// lint.mjs — 手順書の lint(00_common.md ■lint)を1コマンドで実行するランナー。
//
//   node tools/lint/lint.mjs                          実装済みの全規則を、全フローの成果物に対して実行する
//   node tools/lint/lint.mjs --flow F-002 --stage 10  作業10の成果物を検査する(作業15・20を起動する前)
//   node tools/lint/lint.mjs --flow F-002 --stage 15  作業15の成果物(追記した探索記録を含む)を検査する
//   node tools/lint/lint.mjs --flow F-002 --stage 20  作業20の成果物を検査する(フローの完了時)
//   node tools/lint/lint.mjs --list                   規則の一覧と実装状況を出す
//
// オプション:
//   --flow <F-xxx>     対象のフロー(省略時は全フロー)
//   --stage <10|15|20> 対象の作業の成果物(省略時はすべて)。規則ごとの意味は下の表
//   --rule <id,...>    指定した規則だけを実行する       --skip <id,...>  指定した規則を除く
//   --json             結果を JSON で出す(標準出力)     --verbose        規則ごとの補足(確認した内容)も出す
//   --strict           実行できなかった規則(PowerShell がない等)も ERROR として扱う
//   --root <dir>       リポジトリのルート(既定: このスクリプトの2階層上)
//
// 終了コード: 0 = ERROR なし / 1 = ERROR あり(次の作業を起動しない)/ 2 = lint を実行できない(引数・正本の誤り)
// 依存: Node.js 18 以上のみ(外部パッケージ不要)。テスト: node --test tools/lint/test/lint.test.mjs
//
// 規則の一覧・重大度は procedure/00_common.md の lint 表を正とする(このスクリプトは表を読んで動く)。
// 実装した規則:
//   status_yaml_valid          status.yaml の最上位・context_updates を vocab.context_key と stages.md のスロット8で検査
//   procedure_version_present  全 status.yaml の procedure_version と、同一フローの作業10・15・20の一致
//   verdict_enum               探索記録の判定値
//   reason_code_enum           申し送り台帳・blocked_by の理由コード
//   no_temp_locator            探索記録・セットアップ記録の locator に snapshot の一時IDがない
//   requires_covered           作業10: requires の全状態が setup-log にある / 作業20: コード化したシナリオの requires に fixture がある
//   setup_steps_recorded       setup-log の built-by-ui のエントリに steps があり、各 step に操作の対象(detail / operation_id / locator)がある(proc-v016 以降)。
//                              proc-v017 以降は provided にも当て、流用元(reused_from)を見る
//   act_log_linked             setup-log の built-by-ui のエントリの act が pms act の記録(act-log.jsonl)と一致する(proc-v017 以降)
//   phase_a_queue_complete     作業10のフェーズAのキューのカードがすべて合格か STOP(proc-v017 以降)。proc-v018 以降はパートCのカードも(skipped を含む)
//   explore_act_linked         探索記録のステップの act が pms act の記録と一致する(proc-v018 以降)
//   blocked_recorded           blocked_by(理由・参照・resume_from)、blocked の手前のステップの記録、blocked_by_prohibition との一致
//   health_recorded            健全性シグナルのあるステップを passed にしていない、health_fix の記録、作業10・15の status.yaml との一致、健全性シグナルのステップの時刻(proc-v014 以降)
//   ext_demand_linked          操作手段なし の申し送り・blocked のステップが、外部操作需要リストの需要IDを参照している
//   operation_registered       使った operation_id が KB T05 に登録済みで、禁止操作リストの 禁止/要許可 に該当しない
//   requires_in_state_set      requires の全状態が初期状態セット(基本の状態 + 状態需要リストの 採用・整備済)にある。SD-ID の参照・重複
//   skills_in_sync             tools/build-skills/build-skills.mjs --check を呼ぶ
//   prohibition_recheck        作業20の前は tools/checks/prohibited-ops.mjs --compare を呼ぶ。作業20のあとは prohibition_check: ok を確かめる
//   env_restored               skill restore-golden-image 同梱の Test-EnvRestoreMarker.ps1 を呼ぶ(PowerShell が必要)
//   env_value_leak             秘密情報(config/environments*.json の kind: secret)の値が成果物に書かれていない
//   env_value_hardcoded        接続先(kind: endpoint)の値がテストコードにそのまま書かれていない

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repo, LintSetupError, STAGES } from './lib/repo.mjs';
import { status_yaml_valid, procedure_version_present } from './rules/status.mjs';
import { requires_covered, blocked_recorded, verdict_enum, no_temp_locator, setup_steps_recorded, health_recorded } from './rules/exploration.mjs';
import { reason_code_enum, ext_demand_linked, operation_registered, requires_in_state_set } from './rules/ledgers.mjs';
import { skills_in_sync, prohibition_recheck, env_restored } from './rules/delegated.mjs';
import { env_value_leak, env_value_hardcoded } from './rules/environment.mjs';
import { act_log_linked, phase_a_queue_complete, explore_act_linked } from './rules/pms.mjs';

const IMPLEMENTED = {
  status_yaml_valid, procedure_version_present, verdict_enum, reason_code_enum, no_temp_locator,
  requires_covered, setup_steps_recorded, blocked_recorded, health_recorded, ext_demand_linked, operation_registered, requires_in_state_set,
  skills_in_sync, prohibition_recheck, env_restored, env_value_leak, env_value_hardcoded,
  act_log_linked, phase_a_queue_complete, explore_act_linked,
};
// 既存のスクリプトを呼ぶ規則(--list の表示用)
const DELEGATED = {
  skills_in_sync: 'tools/build-skills/build-skills.mjs --check',
  prohibition_recheck: 'tools/checks/prohibited-ops.mjs --compare',
  env_restored: 'restore-golden-image/scripts/Test-EnvRestoreMarker.ps1',
};

// ── 引数 ─────────────────────────────────────────────
const opt = { flow: null, stage: null, rules: null, skip: [], json: false, verbose: false, strict: false, list: false, root: null };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => { const v = args[++i]; if (v === undefined) usage(`${a} の値がありません`); return v; };
  if (a === '--flow') opt.flow = next();
  else if (a === '--stage') opt.stage = next().padStart(2, '0');
  else if (a === '--rule' || a === '--rules') opt.rules = next().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--skip') opt.skip = next().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--json') opt.json = true;
  else if (a === '--verbose' || a === '-v') opt.verbose = true;
  else if (a === '--strict') opt.strict = true;
  else if (a === '--list') opt.list = true;
  else if (a === '--root') opt.root = next();
  else if (a === '-h' || a === '--help') { help(); process.exit(0); }
  else usage(`不明な引数: ${a}`);
}
if (opt.flow && !/^F-\d{3}$/.test(opt.flow)) usage(`--flow は F-<3桁> で指定してください: ${opt.flow}`);
if (opt.stage && !STAGES.includes(opt.stage)) usage(`--stage は ${STAGES.join(' / ')} のいずれか: ${opt.stage}`);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(opt.root ?? path.join(scriptDir, '..', '..'));
const repo = new Repo(ROOT, { flow: opt.flow, stage: opt.stage });

let table;
try {
  table = repo.ruleTable;
  void repo.vocab;
} catch (e) {
  if (e instanceof LintSetupError) setupFail(e.message);
  throw e;
}

// ── 一覧 ─────────────────────────────────────────────
if (opt.list) {
  const w = Math.max(...table.map((r) => r.id.length));
  for (const r of table) {
    const how = DELEGATED[r.id] ? `実装済み(${DELEGATED[r.id]} を呼ぶ)` : IMPLEMENTED[r.id] ? '実装済み' : '未実装';
    console.log(`${r.id.padEnd(w)}  ${r.severity.padEnd(7)}  ${how}`);
  }
  const n = table.filter((r) => IMPLEMENTED[r.id]).length;
  console.log(`\n${table.length} 規則のうち ${n} 規則を実装済み(00_common.md ■lint の表)`);
  process.exit(0);
}

// ── 規則の選択 ─────────────────────────────────────────
const tableIds = new Set(table.map((r) => r.id));
for (const id of Object.keys(IMPLEMENTED)) {
  if (!tableIds.has(id)) setupFail(`実装した規則 ${id} が 00_common.md の lint 表にありません(表と実装が食い違っています)`);
}
// 表の「実装:」と実装の一致(表を見れば実装状況が分かるようにしておくため)
const marked = table.filter((r) => /実装[:：]/.test(r.desc)).map((r) => r.id);
const unmarked = Object.keys(IMPLEMENTED).filter((id) => !marked.includes(id));
const phantom = marked.filter((id) => !IMPLEMENTED[id]);
if (!opt.list && (unmarked.length || phantom.length)) {
  setupFail(`00_common.md の lint 表の「実装:」と実装が食い違っています(表に「実装:」がない: ${unmarked.join(', ') || 'なし'} / 表にあるが未実装: ${phantom.join(', ') || 'なし'})`);
}
for (const id of [...(opt.rules ?? []), ...opt.skip]) {
  if (!tableIds.has(id)) usage(`00_common.md の lint 表にない規則です: ${id}`);
  if (!IMPLEMENTED[id]) usage(`規則 ${id} は未実装です(--list で実装状況を確かめられます)`);
}
const selected = table.filter((r) => IMPLEMENTED[r.id] && (!opt.rules || opt.rules.includes(r.id)) && !opt.skip.includes(r.id));

// ── 実行 ─────────────────────────────────────────────
const results = [];
let internal = false;
for (const r of selected) {
  let res;
  try {
    res = IMPLEMENTED[r.id](repo) ?? { findings: [] };
  } catch (e) {
    if (e instanceof LintSetupError) setupFail(e.message);
    internal = true;
    res = { findings: [{ file: '(lint)', message: `規則の実行中にエラーが起きました: ${e.stack ?? e}` }] };
  }
  results.push({
    rule: r.id,
    severity: r.severity,
    status: res.skipped ? 'skipped' : res.findings.length ? 'ng' : 'ok',
    skipped: res.skipped ?? null,
    findings: res.findings,
    notes: res.notes ?? [],
  });
}
if (repo.fileErrors.size) {
  results.push({
    rule: '(成果物の読み取り)',
    severity: 'ERROR',
    status: 'ng',
    skipped: null,
    findings: [...repo.fileErrors].map(([file, message]) => ({ file, message })),
    notes: [],
  });
}

const count = (sev) => results.filter((x) => x.severity === sev).reduce((n, x) => n + x.findings.length, 0);
const errors = count('ERROR');
const warnings = count('WARNING');
const skipped = results.filter((x) => x.status === 'skipped');
const unimplemented = table.filter((r) => !IMPLEMENTED[r.id]).map((r) => r.id);
const failed = errors > 0 || (opt.strict && skipped.length > 0);

if (opt.json) {
  console.log(JSON.stringify({
    ok: !failed,
    procedure_version: repo.procedureVersion,
    scope: { flow: opt.flow, stage: opt.stage },
    errors, warnings,
    skipped: skipped.map((x) => ({ rule: x.rule, reason: x.skipped })),
    unimplemented,
    results,
  }, null, 2));
} else {
  const scope = [opt.flow ?? '全フロー', opt.stage ? `作業${opt.stage}` : '全作業'].join('・');
  console.log(`lint — 手順版 ${repo.procedureVersion ?? '不明'} / 範囲: ${scope}`);
  const w = Math.max(...results.map((x) => x.rule.length), 10);
  for (const x of results) {
    const mark = x.status === 'ok' ? 'OK  ' : x.status === 'skipped' ? '--  ' : 'NG  ';
    const tail = x.status === 'skipped' ? `未実行: ${x.skipped}` : x.findings.length ? `${x.findings.length} 件` : '';
    console.log(`${mark}${x.rule.padEnd(w)}  ${x.severity.padEnd(7)}  ${tail}`);
    for (const f of x.findings) console.log(`      - ${f.file}: ${f.message}`);
    if (opt.verbose) for (const n of x.notes) console.log(`      · ${n}`);
  }
  const parts = [`ERROR ${errors} 件`, `WARNING ${warnings} 件`];
  if (skipped.length) parts.push(`未実行 ${skipped.length} 規則${opt.strict ? '(--strict のため ERROR 扱い)' : ''}`);
  parts.push(`未実装 ${unimplemented.length} 規則(--list で一覧)`);
  console.log(`\n結果: ${parts.join(' / ')}`);
  if (failed) console.log('ERROR があります。次の作業を起動しないでください(00_common.md ■lint)。');
}
process.exit(internal ? 2 : failed ? 1 : 0);

// ════════════════════════════════════════════════════════
function usage(msg) {
  console.error(`ERROR: ${msg}`);
  console.error('node tools/lint/lint.mjs --help で使い方を表示します。');
  process.exit(2);
}

function setupFail(msg) {
  console.error(`ERROR: lint を実行できません — ${msg}`);
  process.exit(2);
}

function help() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const end = text.findIndex((l, i) => i > 1 && !l.startsWith('//'));
  console.log(text.slice(1, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
