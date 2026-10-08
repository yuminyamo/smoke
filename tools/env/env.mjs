#!/usr/bin/env node
// env.mjs — 検証環境の情報(接続先・アカウントなど)を読み書きする(00_common.md ■検証環境の情報)。
//
//   node tools/env/env.mjs require [--keys k1[:kind],k2[:kind]] [--no-base]
//                                   必要なキーが揃っているか(基本キー vocab.env_base_keys + --keys)。作業の開始時・シナリオ生成のあと
//   node tools/env/env.mjs get <キー> [--reveal]     値を1つ出す(秘密情報は --reveal を付けたときだけ)。テストコードは tests/helpers/env.ts から呼ぶ
//   node tools/env/env.mjs set <キー> <値|-> [--kind endpoint|account|secret|other] [--description <説明>] [--shared|--local]
//                                   値を保存する(- は標準入力から読む)。保存先の既定: secret は local、それ以外は共有
//   node tools/env/env.mjs describe <説明> [--shared|--local]   環境の説明を書く(環境がなければ作る。既定は共有)
//   node tools/env/env.mjs list                     環境の属性の一覧(秘密情報の値は伏せる)
//   node tools/env/env.mjs envs                     環境の一覧と、既定の環境
//   node tools/env/env.mjs use <環境ID>             既定の環境を各自の設定(local)に書く
//   node tools/env/env.mjs check                    設定ファイルの形を検査する
//
// 共通オプション: --env <環境ID>(省略時は PMS_ENV → local の default → 共有の default → 環境が1つならそれ)
//                 --root <dir>(リポジトリのルート。既定: このスクリプトの2階層上)
// 設定ファイル: config/environments.json(共有・git に入れる)/ config/environments.local.json(各自・git に入れない)
//
// 終了コード: 0 = 成功(require は全部揃っている)/ 1 = 足りない(require の不足、get の値がない)/ 2 = 実行できない(引数・設定の誤り)
// 出力: get は値だけを標準出力へ。それ以外は1行の JSON を標準出力へ(人間向けの説明は標準エラー出力)。
//       秘密情報の値は、get --reveal 以外では出力しない。
// 依存: Node.js 18 以上のみ(外部パッケージ不要)。テスト: node --test tools/env/test/env.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  load, selectEnv, requireKeys, setValue, setEnvDescription, setDefault,
  EnvError, ENV_ID_RE, KEY_RE, SHARED_FILE, LOCAL_FILE,
} from './lib/environments.mjs';

const args = process.argv.slice(2);
const opt = { env: null, root: null, keys: [], base: true, reveal: false, kind: null, description: undefined, target: null };
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => { const v = args[++i]; if (v === undefined) bail(`${a} の値がありません`); return v; };
  if (a === '--env') opt.env = next();
  else if (a === '--root') opt.root = next();
  else if (a === '--keys') opt.keys.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
  else if (a === '--no-base') opt.base = false;
  else if (a === '--reveal') opt.reveal = true;
  else if (a === '--kind') opt.kind = next();
  else if (a === '--description') opt.description = next();
  else if (a === '--shared') opt.target = 'shared';
  else if (a === '--local') opt.target = 'local';
  else if (a === '-h' || a === '--help') { help(); process.exit(0); }
  else if (a.startsWith('--')) bail(`不明な引数: ${a}`);
  else pos.push(a);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(opt.root ?? path.join(scriptDir, '..', '..'));
const cmd = pos.shift();
if (!cmd) { help(); process.exit(2); }

let cfg;
try { cfg = load(ROOT); } catch (e) { if (e instanceof EnvError) bail(e.message); throw e; }
if (opt.env && !ENV_ID_RE.test(opt.env)) bail(`環境ID ${opt.env} が書式(英数字・_・-)に合いません`);
if (opt.kind && !cfg.kinds.includes(opt.kind)) bail(`--kind は ${cfg.kinds.join(' / ')} のいずれか: ${opt.kind}`);

switch (cmd) {
  case 'check': {
    print({ ok: cfg.errors.length === 0, errors: cfg.errors, files: fileState() });
    for (const e of cfg.errors) note(`ERROR: ${e}`);
    warnIfTracked();
    process.exit(cfg.errors.length ? 2 : 0);
    break;
  }
  case 'envs': {
    stopOnErrors();
    const sel = selectEnv(cfg, opt.env);
    print({
      selected: sel.env, selected_by: sel.by,
      environments: [...cfg.envs].map(([id, e]) => ({ env: id, description: e.description, files: e.sources })),
    });
    break;
  }
  case 'list': {
    stopOnErrors();
    const env = mustSelect();
    const e = cfg.envs.get(env);
    if (!e) { print({ env, exists: false, attributes: [] }); note(`環境 ${env} は設定にありません`); process.exit(1); }
    print({
      env, description: e.description,
      attributes: [...e.attributes].sort(([a], [b]) => a.localeCompare(b)).map(([key, a]) => ({
        key, kind: a.kind, set: a.value !== undefined, source: a.source ?? null,
        value: a.value === undefined ? null : a.kind === 'secret' ? '****' : a.value,
        description: a.description ?? '',
      })),
    });
    break;
  }
  case 'get': {
    stopOnErrors();
    const key = pos.shift();
    if (!key) bail('get <キー> のキーがありません');
    const env = mustSelect();
    const a = cfg.envs.get(env)?.attributes.get(key);
    if (!a || a.value === undefined) {
      note(`環境 ${env} に ${key} の値がありません。node tools/env/env.mjs set ${key} <値> --env ${env} で保存するか、管理者に確認してください(00 ■検証環境の情報)`);
      process.exit(1);
    }
    if (a.kind === 'secret' && !opt.reveal) bail(`${key} は秘密情報です。値は --reveal を付けたときだけ出します(成果物に値を書かない。<env:${key}> で参照する)`);
    process.stdout.write(a.value + '\n');
    break;
  }
  case 'require': {
    stopOnErrors();
    const extra = opt.keys.map((s) => {
      const [key, kind] = s.split(':');
      if (!KEY_RE.test(key)) bail(`--keys のキー ${key} が書式(例 pms.url / mfp.a.host)に合いません`);
      if (kind && !cfg.kinds.includes(kind)) bail(`--keys の ${key} の種類 ${kind} は ${cfg.kinds.join(' / ')} のいずれか`);
      return { key, kind: kind || null };
    });
    const sel = selectEnv(cfg, opt.env);
    const r = requireKeys(cfg, sel.env && cfg.envs.has(sel.env) ? sel.env : null, extra, { base: opt.base });
    const state = sel.env && cfg.envs.has(sel.env) && r.missing.length === 0 ? 'complete' : 'missing';
    const out = { env: sel.env, selected_by: sel.by, state, missing: r.missing, present: r.present.map((p) => p.key) };
    if (!sel.env) out.reason = 'no_environment';
    else if (!cfg.envs.has(sel.env)) out.reason = 'unknown_environment';
    print(out);
    if (state === 'missing') {
      if (!sel.env) note('使う環境が決まりません(環境が未登録、または複数あって既定がない)。環境ID(任意の名前。例 vm01)と、足りない値を人間に確認してください。');
      else if (!cfg.envs.has(sel.env)) note(`環境 ${sel.env} は設定にありません。足りない値を人間に確認してください。`);
      note(`足りない値 ${r.missing.length} 件: ${r.missing.map((m) => `${m.key}(${m.kind})`).join(', ')}`);
      note('まとめて人間に確認し、回答を node tools/env/env.mjs set で保存してください(00 ■検証環境の情報)。');
      process.exit(1);
    }
    break;
  }
  case 'set': {
    stopOnErrors();
    const key = pos.shift();
    let value = pos.shift();
    if (!key || value === undefined) bail('set <キー> <値> の形で指定してください(値に - を書くと標準入力から読む)');
    if (!KEY_RE.test(key)) bail(`キー ${key} が書式(英小文字・数字・_・- を . でつなぐ。例 pms.url / mfp.a.host)に合いません`);
    if (value === '-') value = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (value === '') bail('値が空です');
    const sel = selectEnv(cfg, opt.env);
    if (!sel.env) bail('環境が決まりません。--env <環境ID> を付けてください(新しい環境ならその名前で作ります)');
    const cur = cfg.envs.get(sel.env)?.attributes.get(key);
    const kind = opt.kind ?? cur?.kind ?? cfg.baseKeys[key]?.kind ?? cfg.optionalKeys[key]?.kind ?? null;
    if (!kind) bail(`${key} は新しいキーです。--kind ${cfg.kinds.join('|')} を付けてください`);
    const target = opt.target ?? (kind === 'secret' ? 'local' : 'shared');
    const rel = setValue(ROOT, { env: sel.env, key, value, kind, forceKind: Boolean(opt.kind), description: opt.description, target });
    if (target === 'shared' && cur?.source === 'local') note(`注意: ${LOCAL_FILE} にも ${key} の値があり、そちらが優先されます`);
    if (target === 'shared' && kind === 'secret') note(`注意: 秘密情報を共有の ${SHARED_FILE} に保存しました(git に入ります)`);
    print({ env: sel.env, key, kind, file: rel });
    if (target === 'local') warnIfTracked();
    break;
  }
  case 'describe': {
    stopOnErrors();
    const text = pos.shift();
    if (text === undefined) bail('describe <説明> の説明がありません');
    const sel = selectEnv(cfg, opt.env);
    if (!sel.env) bail('環境が決まりません。--env <環境ID> を付けてください');
    const rel = setEnvDescription(ROOT, { env: sel.env, description: text, target: opt.target ?? 'shared' });
    print({ env: sel.env, file: rel });
    break;
  }
  case 'use': {
    stopOnErrors();
    const env = pos.shift();
    if (!env || !ENV_ID_RE.test(env)) bail('use <環境ID> の環境IDがない、または書式(英数字・_・-)に合いません');
    if (!cfg.envs.has(env)) bail(`環境 ${env} は設定にありません(先に set で値を保存すると環境が作られます)`);
    const rel = setDefault(ROOT, env);
    print({ default: env, file: rel });
    break;
  }
  default:
    bail(`不明なコマンド: ${cmd}(require / get / set / describe / list / envs / use / check)`);
}

// ════════════════════════════════════════════════════════

function mustSelect() {
  const sel = selectEnv(cfg, opt.env);
  if (!sel.env) bail('使う環境が決まりません。--env <環境ID> を付けるか、node tools/env/env.mjs use <環境ID> で既定を決めてください');
  return sel.env;
}

function stopOnErrors() {
  if (cfg.errors.length) bail(`設定ファイルに誤りがあります:\n  ${cfg.errors.join('\n  ')}`);
}

function fileState() {
  return { shared: fs.existsSync(path.join(ROOT, SHARED_FILE)), local: fs.existsSync(path.join(ROOT, LOCAL_FILE)) };
}

// 各自の設定が git に入る状態なら知らせる(git がない・リポジトリでないときは何もしない)
function warnIfTracked() {
  if (!fs.existsSync(path.join(ROOT, LOCAL_FILE))) return;
  const r = spawnSync('git', ['check-ignore', '-q', LOCAL_FILE], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status === 128) return;
  if (r.status === 1) note(`注意: ${LOCAL_FILE} が git の無視の対象になっていません(秘密情報がコミットされます)。config/.gitignore を置いてください`);
}

function print(obj) { console.log(JSON.stringify(obj)); }
function note(msg) { console.error(msg); }
function bail(msg) { console.error('ERROR: ' + msg); process.exit(2); }

function help() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const end = text.findIndex((l, i) => i > 1 && !l.startsWith('//'));
  console.log(text.slice(1, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
