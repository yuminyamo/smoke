// cli.mjs — playwright-cli と環境情報の実行体の呼び出し(playwright-cli を呼ぶのは pms act と pms pwcli だけ)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, readJson } from './util.mjs';
import { MIN_MASK_LENGTH } from './store.mjs';

// tools/env/env.mjs(pms と同じ tools/ の下にあるもの。--root で対象のリポジトリを渡す)
export const ENV_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'env', 'env.mjs');

const TIMEOUT_MS = 120_000;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    encoding: 'utf8', timeout: opts.timeout ?? TIMEOUT_MS, cwd: opts.cwd, env: process.env, input: opts.input,
  });
  if (r.error && r.error.code === 'ENOENT') throw new UsageError(`${cmd[0]} が見つかりません(config/pms.json の設定を確かめてください)`);
  return { code: r.status ?? (r.signal ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null };
}

export class PlaywrightCli {
  constructor(cfg, session, cwd) {
    this.cfg = cfg;
    this.session = session;
    this.cwd = cwd;
    this.calls = 0;
  }

  /** playwright-cli -s=<フローID> <args...> */
  call(args) {
    this.calls++;
    const sessionArg = this.cfg.session_arg.replace('{session}', this.session);
    return run(this.cfg.playwright_cli, [sessionArg, ...args], { cwd: this.cwd });
  }

  /** playwright-cli <args...>(セッションを指定しない。pms pwcli で --session がないとき) */
  callDefault(args) {
    this.calls++;
    return run(this.cfg.playwright_cli, args, { cwd: this.cwd });
  }

  version() {
    const r = run(this.cfg.playwright_cli, ['--version'], { cwd: this.cwd });
    return r.code === 0 ? (r.stdout.trim().split('\n').pop() ?? '').trim() : null;
  }

  /** generate-locator <ref> → ロケータ(取れなければ null) */
  generateLocator(ref) {
    const r = this.call(['generate-locator', ref]);
    if (r.code !== 0) return { locator: null, raw: r };
    return { locator: parseLocator(r.stdout), raw: r };
  }

  /** run-code で式を評価し、結果の文字列を返す */
  evaluate(body) {
    const r = this.call(['run-code', `async page => { return ${body}; }`]);
    return { value: r.code === 0 ? parseResult(r.stdout) : null, raw: r };
  }

  /** run-code で文を実行する */
  exec(statement) {
    return this.call(['run-code', `async page => { ${statement}; }`]);
  }
}

// 設定ファイルに locale がないときに使う locale(テスト対象の画面を日本語で表示させる)
export const DEFAULT_LOCALE = 'ja-JP';

/**
 * open に足す --config=<絶対パス>(config/pms.json の browser_config。locale などを playwright-cli の設定ファイルで渡す)。
 * 設定ファイルに browser.contextOptions.locale がなければ DEFAULT_LOCALE を足した写しを一時ディレクトリに作って渡す
 * (browser_config が null のとき・ファイルがないときも DEFAULT_LOCALE だけの設定を渡す。ファイルがないときは警告も返す)。
 * JSON として読めなければ使い方の誤り
 * @returns {{ args: string[], locale: string, warning: string|null }}
 */
export function browserConfigArgs(cfg, root) {
  const file = cfg.browser_config === null ? null : path.resolve(root, cfg.browser_config);
  const found = file !== null && fs.existsSync(file);
  const warning = file !== null && !found ? `playwright-cli の設定ファイル ${cfg.browser_config}(config/pms.json の browser_config)がないため、locale の既定値 ${DEFAULT_LOCALE} だけを指定してブラウザを開いた` : null;
  const conf = found ? readJson(file, cfg.browser_config) : {};
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) throw new UsageError(`${cfg.browser_config} はオブジェクトでなければなりません`);
  const locale = conf.browser?.contextOptions?.locale;
  if (locale) return { args: [`--config=${file}`], locale, warning };
  const merged = { ...conf, browser: { ...conf.browser, contextOptions: { ...conf.browser?.contextOptions, locale: DEFAULT_LOCALE } } };
  const text = JSON.stringify(merged, null, 2);
  const tmp = path.join(os.tmpdir(), `pms-playwright-cli-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`);
  fs.writeFileSync(tmp, text);
  return { args: [`--config=${tmp}`], locale: DEFAULT_LOCALE, warning };
}

/** generate-locator の出力からロケータを取り出す(先頭の page. は外す) */
export function parseLocator(text) {
  for (const line of String(text).split('\n')) {
    const m = line.match(/(?:^|[\s`=:(])(?:page\.)?((?:getBy[A-Za-z]+|locator|frameLocator)\(.*\))\s*;?\s*`?\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

/** run-code の出力から結果の値を取り出す(「### Result」の次の行、なければ最後の空でない行) */
export function parseResult(text) {
  const lines = String(text).split('\n').map((l) => l.trim());
  const idx = lines.findIndex((l) => /^#+\s*Result\b/i.test(l));
  const pick = idx >= 0 ? lines.slice(idx + 1).find((l) => l !== '' && !l.startsWith('```')) : [...lines].reverse().find((l) => l !== '' && !l.startsWith('#') && !l.startsWith('```'));
  if (pick == null) return null;
  return pick.replace(/^["']|["']$/g, '');
}

/** 出力の「Page URL: …」(なければ null) */
export function parsePageUrl(text) {
  const m = String(text).match(/Page URL:\s*(\S+)/);
  return m ? m[1] : null;
}

/** 出力の「Ran Playwright code」の後のコード(なければ null) */
export function parseRanCode(text) {
  const s = String(text);
  const i = s.search(/Ran Playwright code/i);
  if (i < 0) return null;
  const m = s.slice(i).match(/```[a-z]*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

/**
 * ロケータの区分(vocab.locator_class)。00 ■ロケータ規約の1〜5(getByRole・getByLabel・getByPlaceholder・
 * getByText・getByTestId)だけをつないだものを stable とし、それ以外(locator(…)・nth・first など構造に頼るもの)を css とする
 */
export function classifyLocator(loc) {
  if (!loc) return null;
  const calls = [...String(loc).matchAll(/(?:^|\.)([A-Za-z]+)\(/g)].map((m) => m[1]);
  if (calls.length === 0) return 'css';
  const STABLE = new Set(['getByRole', 'getByLabel', 'getByPlaceholder', 'getByText', 'getByTestId']);
  return calls.every((c) => STABLE.has(c)) ? 'stable' : 'css';
}

/** 環境情報の値を取り出す(node tools/env/env.mjs get <キー> --reveal) */
export function envGet(cfg, root, key) {
  const cmd = cfg.env_cli ?? [process.execPath, ENV_SCRIPT, '--root', root];
  const r = run(cmd, ['get', key, '--reveal'], { cwd: root });
  if (r.code !== 0) return { ok: false, message: `環境情報 ${key} を取り出せません(env.mjs の終了コード ${r.code})。node tools/env/env.mjs require --keys ${key} で確かめ、足りなければ人間に聞いて set で保存する` };
  return { ok: true, value: r.stdout.replace(/\r?\n$/, '') };
}

/** 環境情報の参照(引数全体が <env:キー> のもの) */
export const ENV_REF = /^<env:([a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*)>$/;

/**
 * 引数が <env:キー> だけなら値に置き換える(pms act と pms pwcli で共通)。
 * 置き換えた値は masks に足し(出力・記録で伏せるため)、短くて伏せられない値は warnings に警告を足す。
 * @returns {{ actual: string, recorded: string } | { error: string }} actual は playwright-cli に渡す値、recorded は記録・出力に書く形
 */
export function resolveEnvArg(cfg, root, v, masks, warnings) {
  const m = String(v).match(ENV_REF);
  if (!m) return { actual: v, recorded: v };
  const r = envGet(cfg, root, m[1]);
  if (!r.ok) return { error: r.message };
  masks.push({ key: m[1], value: r.value });
  if (r.value.length < MIN_MASK_LENGTH) warnings.push(`<env:${m[1]}> の値は ${MIN_MASK_LENGTH} 文字未満のため、出力で伏せられない`);
  return { actual: r.value, recorded: v };
}

/** 外部操作の実行体を呼ぶ(pms act ext) */
export function runExternal(argv, cwd) {
  return run(argv, [], { cwd, timeout: 30 * 60_000 });
}
