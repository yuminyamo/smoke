#!/usr/bin/env node
// stub-ai-cli.mjs — テスト用の AI の CLI(Copilot CLI・Kiro CLI・Claude Code の CLI)の偽物。pms run がカードごとに起こす
//
// 引数: <card_file> <card> <flow>(config/pms.json の runner.command で渡す)。標準入力の依頼文は読み捨てる。
// ふるまいは環境変数 PMS_STUB_AI のスクリプト(ES モジュール)の default export が決める:
//   export default async ({ root, flow, card, cardFile, kind, pms }) => { ... }
//   pms(args) は node tools/pms/pms.mjs --root <root> <args...> を実行し { code, json, stdout } を返す。
// 出力は JSONL(1行目に依頼を受けたこと、最後に終わったこと)。秘密情報の伏せの確認のため、PMS_STUB_AI_LEAK の値も出す。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [cardFile, card, flow] = process.argv.slice(2);
const root = process.cwd();
const PMS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pms.mjs');
const pms = (args) => {
  const r = spawnSync(process.execPath, [PMS, '--root', root, ...args], { encoding: 'utf8', env: process.env });
  let json = null;
  const tail = r.stdout.includes('\n--- pms ---\n') ? r.stdout.split('\n--- pms ---\n').pop() : r.stdout;
  try { json = JSON.parse(tail); } catch { /* テキスト */ }
  return { code: r.status, json, stdout: r.stdout };
};
const body = fs.existsSync(path.join(root, cardFile)) ? fs.readFileSync(path.join(root, cardFile), 'utf8') : '';
const kind = (body.match(/種類: ([a-z._]+)/) ?? [])[1] ?? null;
console.log(JSON.stringify({ type: 'start', card, flow, kind, runner: process.env.PMS_RUNNER, leak: process.env.PMS_STUB_AI_LEAK ?? null }));
const mod = await import(pathToFileURL(process.env.PMS_STUB_AI).href);
const res = await mod.default({ root, flow, card, cardFile, kind, body, pms });
console.log(JSON.stringify({ type: 'end', card, result: res ?? null }));
