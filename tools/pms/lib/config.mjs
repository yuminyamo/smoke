// config.mjs — config/pms.json(人間が書く。見本は config/pms.sample.json)の読み込みと既定値

import fs from 'node:fs';
import path from 'node:path';
import { readJson, UsageError } from './util.mjs';

export const CONFIG_FILE = 'config/pms.json';

// playwright-cli の操作ごとの呼び出し。{ref} {value} {url} {locator} {js_value} を置き換える。
// cli: playwright-cli のサブコマンドとして呼ぶ / code: run-code で Playwright のコードを実行する
// (playwright-cli の画面操作が要素参照を取らないもの。press・type・upload)
export const DEFAULT_OPS = {
  click: { cli: ['click', '{ref}'], code: 'click()' },
  dblclick: { cli: ['dblclick', '{ref}'], code: 'dblclick()' },
  fill: { cli: ['fill', '{ref}', '{value}'], code: 'fill({js_value})', value: true },
  type: { run_code: 'pressSequentially({js_value})', code: 'pressSequentially({js_value})', value: true },
  select: { cli: ['select', '{ref}', '{value}'], code: 'selectOption({js_value})', value: true },
  check: { cli: ['check', '{ref}'], code: 'check()' },
  uncheck: { cli: ['uncheck', '{ref}'], code: 'uncheck()' },
  hover: { cli: ['hover', '{ref}'], code: 'hover()' },
  press: { run_code: 'press({js_value})', code: 'press({js_value})', value: true },
  upload: { run_code: 'setInputFiles({js_value})', code: 'setInputFiles({js_value})', value: true },
};

export const DEFAULTS = {
  // playwright-cli の呼び出し方(コマンドの配列)。例 ["npx", "--no-install", "playwright-cli"]
  playwright_cli: ['playwright-cli'],
  // 想定する playwright-cli の版(open のときに --version と比べ、違えば警告する。null なら比べない)
  playwright_cli_version: null,
  // セッション名の引数({session} はフローID)
  session_arg: '-s={session}',
  // open に足す引数(ヘッドレスのセッションが1時間で閉じないように。docs/94 §9)
  open_args: ['--idle-timeout=0'],
  // 環境情報の取り出し(get <キー> --reveal を足して呼ぶ)。null なら node tools/env/env.mjs
  env_cli: null,
  // 同じカードを出す回数の上限(超えたら STOP)
  max_issues: 3,
  // 同じカードの提出が不合格になる回数の上限(達したら STOP)
  max_rejections: 3,
  // 操作ごとの呼び出し(DEFAULT_OPS を上書きする)
  ops: {},
  // pms act screenshot の呼び出し({file} は保存先の絶対パス、{ref} は要素参照。ref がなければ {ref} の要素を外す)
  screenshot_args: ['screenshot', '{ref}', '--filename={file}'],
  // pms run がカードごとにセッションを起こす AI の CLI(名前 → 呼び出しの雛形)。CLI のフラグはコードに書かず、ここに書く
  //   command: コマンドの配列。{prompt} {agent} {model} {card_file} {flow} {card} を置き換え、要素 "{deny}" は deny の各パターンを deny_arg の形に広げる
  //   deny_arg: 使用禁止の1つ分の引数({pattern} を置き換える)/ deny: すべてのカードに共通の使用禁止のパターン
  //   stdin: "prompt" なら依頼文を標準入力で渡す(null なら渡さない)/ timeoutSec: 1枚の上限時間(秒)
  // 見本は config/pms.sample.json。runner がなければ pms run は使えない(終了コード 2)
  runner: null,
  // pms run の既定の CLI(--runner を省いたとき)
  default_runner: 'copilot',
  // カードの種類ごとのエージェントとモデル・追加の使用禁止({"explore.step": {"agent": "...", "model": ["..."], "deny": ["..."]}})。
  // 書かなかった種類は procedure/cards/agents.yaml の値を使う
  cardTypes: {},
};

/**
 * @returns {{cfg: object, found: boolean, file: string}}
 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return { cfg: { ...DEFAULTS, ops: { ...DEFAULT_OPS } }, found: false, file: CONFIG_FILE };
  const raw = readJson(file, CONFIG_FILE);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError(`${CONFIG_FILE} はオブジェクトでなければなりません`);
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue; // _comment など
    if (!(k in DEFAULTS)) throw new UsageError(`${CONFIG_FILE} の ${k} は知らない設定です(${Object.keys(DEFAULTS).join(' / ')})`);
    cfg[k] = v;
  }
  const isCmd = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '');
  if (!isCmd(cfg.playwright_cli)) throw new UsageError(`${CONFIG_FILE} の playwright_cli はコマンドの配列(空でない文字列の配列)でなければなりません`);
  if (cfg.env_cli !== null && !isCmd(cfg.env_cli)) throw new UsageError(`${CONFIG_FILE} の env_cli はコマンドの配列か null でなければなりません`);
  if (!Array.isArray(cfg.open_args) || !cfg.open_args.every((x) => typeof x === 'string')) throw new UsageError(`${CONFIG_FILE} の open_args は文字列の配列でなければなりません`);
  for (const k of ['max_issues', 'max_rejections']) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 1) throw new UsageError(`${CONFIG_FILE} の ${k} は1以上の整数でなければなりません`);
  }
  if (typeof cfg.ops !== 'object' || Array.isArray(cfg.ops)) throw new UsageError(`${CONFIG_FILE} の ops はオブジェクトでなければなりません`);
  cfg.ops = { ...DEFAULT_OPS, ...cfg.ops };
  if (!Array.isArray(cfg.screenshot_args) || !cfg.screenshot_args.every((x) => typeof x === 'string')) throw new UsageError(`${CONFIG_FILE} の screenshot_args は文字列の配列でなければなりません`);
  if (cfg.runner !== null) {
    if (typeof cfg.runner !== 'object' || Array.isArray(cfg.runner)) throw new UsageError(`${CONFIG_FILE} の runner はオブジェクト(CLI の名前 → 呼び出しの雛形)でなければなりません`);
    for (const [name, r] of Object.entries(cfg.runner)) {
      if (name.startsWith('_')) continue;
      if (!r || typeof r !== 'object' || !isCmd(r.command)) throw new UsageError(`${CONFIG_FILE} の runner.${name}.command はコマンドの配列でなければなりません`);
      if (r.timeoutSec != null && (!Number.isInteger(r.timeoutSec) || r.timeoutSec < 1)) throw new UsageError(`${CONFIG_FILE} の runner.${name}.timeoutSec は1以上の整数でなければなりません`);
      if (r.deny != null && (!Array.isArray(r.deny) || !r.deny.every((x) => typeof x === 'string'))) throw new UsageError(`${CONFIG_FILE} の runner.${name}.deny は文字列の配列でなければなりません`);
      if (r.deny_arg != null && !(Array.isArray(r.deny_arg) && r.deny_arg.every((x) => typeof x === 'string'))) throw new UsageError(`${CONFIG_FILE} の runner.${name}.deny_arg は文字列の配列でなければなりません`);
      if (r.stdin != null && r.stdin !== 'prompt') throw new UsageError(`${CONFIG_FILE} の runner.${name}.stdin は "prompt" か null でなければなりません`);
    }
  }
  if (typeof cfg.default_runner !== 'string') throw new UsageError(`${CONFIG_FILE} の default_runner は文字列でなければなりません`);
  if (!cfg.cardTypes || typeof cfg.cardTypes !== 'object' || Array.isArray(cfg.cardTypes)) throw new UsageError(`${CONFIG_FILE} の cardTypes はオブジェクトでなければなりません`);
  for (const [name, op] of Object.entries(cfg.ops)) {
    if (!op || typeof op !== 'object' || (!isCmd(op.cli) && typeof op.run_code !== 'string')) {
      throw new UsageError(`${CONFIG_FILE} の ops.${name} には cli(引数の配列)か run_code(Playwright のメソッド呼び出し)が要ります`);
    }
  }
  return { cfg, found: true, file: CONFIG_FILE };
}
