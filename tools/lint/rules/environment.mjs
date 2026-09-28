// environment.mjs — 検証環境の情報(00 ■検証環境の情報)の検査(env_value_leak / env_value_hardcoded)
//
// 設定ファイル(config/environments.json と config/environments.local.json)の値を、成果物の中から探す。
// 設定ファイルがない・値がない環境では、検査する値がないので OK になる(notes に書く)。
// 指摘には値そのものを出さない(キーと環境IDだけを出す)。

import fs from 'node:fs';
import path from 'node:path';
import { load, valuesOfKind, EnvError, SHARED_FILE, LOCAL_FILE } from '../../env/lib/environments.mjs';
import { LintSetupError } from '../lib/repo.mjs';

// 検査する成果物の置き場所と拡張子
const SCAN_DIRS = ['work', 'kb', 'logs', 'tests', 'traceability'];
const TEXT_EXT = new Set(['.md', '.yaml', '.yml', '.json', '.jsonl', '.ts', '.js', '.mjs', '.cjs', '.txt', '.csv', '.log', '.sql', '.ps1']);
const MAX_BYTES = 5 * 1024 * 1024;
// これより短い値は、ほかの文字列と偶然一致しやすいので探さない(notes に書く)
export const MIN_SECRET_LENGTH = 6;
export const MIN_ENDPOINT_LENGTH = 6;

function config(repo) {
  return repo.memo('envConfig', () => {
    try { return load(repo.root); } catch (e) {
      if (e instanceof EnvError) throw new LintSetupError(e.message);
      throw e;
    }
  });
}

/** 成果物のテキストファイル(相対パス)。dirs の配下を再帰的に */
function files(repo, dirs) {
  return repo.memo(`envScan:${dirs.join(',')}`, () => {
    const out = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'test-results' || e.name === 'playwright-report') continue;
          walk(p);
        } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
          if (fs.statSync(p).size <= MAX_BYTES) out.push(repo.rel(p));
        }
      }
    };
    for (const d of dirs) walk(repo.abs(d));
    return out.sort();
  });
}

function scan(repo, values, dirs) {
  const hits = [];
  if (!values.length) return hits;
  for (const rel of files(repo, dirs)) {
    const text = repo.read(rel);
    for (const v of values) {
      if (text.includes(v.value)) hits.push({ rel, ...v });
    }
  }
  return hits;
}

export function env_value_leak(repo) {
  const cfg = config(repo);
  const notes = [];
  if (cfg.errors.length) {
    return { findings: cfg.errors.map((m) => ({ file: m.split(':')[0], message: `環境情報の設定ファイルに誤りがあります — ${m}` })) };
  }
  const secrets = valuesOfKind(cfg, 'secret', 1);
  const scanned = secrets.filter((v) => v.value.length >= MIN_SECRET_LENGTH);
  const short = secrets.filter((v) => v.value.length < MIN_SECRET_LENGTH);
  if (!cfg.local && !cfg.shared) notes.push(`${SHARED_FILE}・${LOCAL_FILE} がないため、探す値がありません`);
  else if (!cfg.local) notes.push(`${LOCAL_FILE} がないため、共有の設定にある秘密情報だけを探しました`);
  notes.push(`秘密情報 ${scanned.length} 件を ${SCAN_DIRS.join('/')} の成果物から探しました`);
  if (short.length) notes.push(`${MIN_SECRET_LENGTH} 文字未満の秘密情報 ${short.length} 件は探していません(${short.map((v) => `${v.env}:${v.key}`).join(', ')})`);
  const findings = scan(repo, scanned, SCAN_DIRS).map((h) => ({
    file: h.rel,
    message: `秘密情報(環境 ${h.env} の ${h.key})の値が書かれています。値を消して <env:${h.key}> で参照する(テストコードは tests/helpers/env.ts の envValue('${h.key}'))`,
  }));
  return { findings, notes };
}

export function env_value_hardcoded(repo) {
  const cfg = config(repo);
  if (cfg.errors.length) return { findings: [], notes: ['設定ファイルに誤りがあるため検査しませんでした(env_value_leak を参照)'] };
  const values = valuesOfKind(cfg, 'endpoint', MIN_ENDPOINT_LENGTH);
  const findings = scan(repo, values, ['tests']).map((h) => ({
    file: h.rel,
    message: `接続先(環境 ${h.env} の ${h.key})の値がそのまま書かれています。<env:${h.key}> で参照する(テストコードは envValue('${h.key}'))。環境を替えたときに動かなくなるため`,
  }));
  return { findings, notes: [`接続先 ${values.length} 件をテストコード(tests/)から探しました`] };
}
