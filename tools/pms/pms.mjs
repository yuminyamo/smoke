#!/usr/bin/env node
// pms.mjs — 進行役(00_common.md ■進行役と記録の道具)。操作の記録・タスクキュー・カード・提出の検査。
//
//   node tools/pms/pms.mjs queue build --flow F-003 --phase A [--scenarios SC-PRT-01,SC-PRT-02]
//                                   フェーズAのカードを作る(対象シナリオの requires から機械的に作る)
//   node tools/pms/pms.mjs next   --flow F-003      次のカードを出す(終わっていれば done、人間の判断が要れば STOP)
//   node tools/pms/pms.mjs act    --flow F-003 --card C-0001 [--intent "<目的>"] <操作> [引数...]
//                                   画面操作を1回実行し、記録(act-log.jsonl)に1行書く。操作は vocab.pms_act_action:
//                                     open <URL|<env:キー>> / goto <URL|<env:キー>> / snapshot /
//                                     click|dblclick|hover|check|uncheck <ref> / fill|type|select|press|upload <ref> <値|<env:キー>> /
//                                     assert <ref> visible|hidden|text "<文言>" / ext --op <操作ID> -- <実行体の呼び出し...>
//   node tools/pms/pms.mjs submit --flow F-003 --card C-0001 [--file work/_flows/F-003/out/C-0001.json]
//                                   AI の出力を検査し、合格なら記録(setup-log・台帳)を書く
//   node tools/pms/pms.mjs status --flow F-003 [--json]   現在のカード・残りの枚数・止まっている理由
//   node tools/pms/pms.mjs reopen --flow F-003 --card C-0001   (人間が使う)STOP のカードを出す前に戻す
//
// 共通オプション: --root <dir>(リポジトリのルート。既定: このスクリプトの2階層上)
// 設定: config/pms.json(なければ既定値。見本 config/pms.sample.json)。時刻は環境変数 PMS_NOW で固定できる(テスト用)
//
// 出力: 標準出力に JSON を1つ(status は --json のときだけ JSON。snapshot は画面の内容のあとに「--- pms ---」の行と JSON)。
//       人間向けの説明は標準エラー出力。秘密情報の値は出力と記録のどこにも書かない(<env:キー> と書く)。
// 終了コード: 0 = 成功(next はカードを出した・done、submit は合格)/ 1 = 失敗(submit の不合格、act の操作の失敗)/
//             2 = 使い方・設定の誤り / 3 = STOP(next。人間の確認待ち)
// 依存: Node.js 18 以上のみ(外部パッケージ不要)。playwright-cli は act だけが呼ぶ。
// テスト: node --test tools/pms/test/
// 仕様(内部の構成・データの形): tools/pms/README.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Paths, UsageError, FLOW_RE } from './lib/util.mjs';
import { Store, CARD_STATUS } from './lib/store.mjs';
import { Procedure } from './lib/procedure.mjs';
import { loadConfig } from './lib/config.mjs';
import { buildQueue, nextCard, statusOf, reopenCard } from './lib/queue.mjs';
import { act } from './lib/act.mjs';
import { submit } from './lib/submit.mjs';

const argv = process.argv.slice(2);
const opt = { root: null, flow: null, card: null, phase: null, file: null, intent: null, scenarios: null, json: false };
const pos = [];
let rawAll = false;
let argError = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  // act の操作の引数は、操作の名前より後ろをそのまま渡す(--intent・--flow・--card だけは取る。ext の -- より後ろはすべて渡す)
  if (pos[0] === 'act' && pos.length >= 2 && (rawAll || !['--intent', '--flow', '--card'].includes(a))) {
    if (a === '--') rawAll = true;
    pos.push(a);
    continue;
  }
  const next = () => { const v = argv[++i]; if (v === undefined) argError ??= `${a} の値がありません`; return v; };
  if (a === '--root') opt.root = next();
  else if (a === '--flow') opt.flow = next();
  else if (a === '--card') opt.card = next();
  else if (a === '--phase') opt.phase = next();
  else if (a === '--file') opt.file = next();
  else if (a === '--intent') opt.intent = next();
  else if (a === '--scenarios') opt.scenarios = next().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--json') opt.json = true;
  else if (a === '-h' || a === '--help') { help(); process.exit(0); }
  else if (a.startsWith('--') && pos[0] !== 'act') argError ??= `不明な引数: ${a}`;
  else pos.push(a);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(opt.root ?? path.join(scriptDir, '..', '..'));

try {
  if (argError) throw new UsageError(argError);
  const cmd = pos.shift();
  if (!cmd) { help(); throw new UsageError('サブコマンドがありません(queue / next / act / submit / status / reopen)'); }
  if (!opt.flow) throw new UsageError('--flow がありません');
  if (!FLOW_RE.test(opt.flow)) throw new UsageError(`--flow は F-<3桁> で指定してください: ${opt.flow}`);
  const proc = new Procedure(ROOT);
  const vocabStatus = proc.values('pms_card_status');
  if (vocabStatus.join(',') !== CARD_STATUS.join(',')) throw new UsageError(`vocab.pms_card_status(${vocabStatus.join(' / ')})が pms の実装(${CARD_STATUS.join(' / ')})と違います`);
  const paths = new Paths(ROOT);
  const ctx = { root: ROOT, paths, store: new Store(paths), proc, cfg: loadConfig(ROOT).cfg };

  let res;
  switch (cmd) {
    case 'queue': {
      const sub = pos.shift();
      if (sub !== 'build') throw new UsageError('queue build --flow <フローID> --phase A');
      if (!opt.phase) throw new UsageError('--phase がありません(A)');
      const q = buildQueue(ctx, { flow: opt.flow, phase: opt.phase, scenarioIds: opt.scenarios });
      res = {
        code: 0,
        out: {
          ok: true, flow: q.flow_id, phase: q.phase, cards: q.cards.map((c) => ({ card: c.id, kind: c.kind, state_id: c.state_id })),
          auto: q.auto, warnings: q.warnings, next: `node tools/pms/pms.mjs next --flow ${q.flow_id}`,
        },
      };
      break;
    }
    case 'next': res = nextCard(ctx, opt.flow); break;
    case 'act': res = act(ctx, opt, pos); break;
    case 'submit': res = submit(ctx, opt); break;
    case 'status': {
      const s = statusOf(ctx, opt.flow);
      res = { code: 0, out: opt.json ? s : statusText(s) };
      break;
    }
    case 'reopen': {
      if (!opt.card) throw new UsageError('--card がありません');
      res = { code: 0, out: reopenCard(ctx, opt.flow, opt.card) };
      break;
    }
    default: throw new UsageError(`不明なサブコマンド: ${cmd}(queue / next / act / submit / status / reopen)`);
  }
  // process.exit は標準出力の書き出しを待たないため(大きな出力が途中で切れる)、終了コードだけを決めて戻る
  process.stdout.write((typeof res.out === 'string' ? res.out : JSON.stringify(res.out, null, 2)) + '\n');
  process.exitCode = res.code;
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  die(e.message);
}

function statusText(s) {
  const lines = [
    `${s.flow} フェーズ${s.phase}(手順版 ${s.procedure_version ?? '不明'})— カード ${s.cards} 枚: 未出 ${s.counts.pending} / 出した ${s.counts.issued} / 合格 ${s.counts.passed} / 人間の確認待ち ${s.counts.stopped}`,
    s.current ? `現在のカード: ${s.current.card}(${s.current.kind} / ${s.current.state_id}。出した回数 ${s.current.issued_count}・不合格 ${s.current.rejections})— ${s.current.todo}` : '現在のカード: なし',
  ];
  for (const x of s.stopped) lines.push(`人間の確認待ち: ${x.card}(${x.kind} / ${x.state_id})— ${x.reason}`);
  for (const a of s.auto) lines.push(`pms が記録した状態: ${a.state_id}(${a.classification}・${a.reason}${a.handoff ? `・${a.handoff}` : ''})`);
  for (const w of s.warnings) lines.push(`警告: ${w}`);
  lines.push(s.complete ? 'フェーズAのカードはすべて終わっている' : `次: ${s.next}`);
  return lines.join('\n');
}

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  console.error(`ERROR: ${msg}`);
  process.exitCode = 2;
}

function help() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const end = text.findIndex((l, i) => i > 1 && !l.startsWith('//'));
  console.log(text.slice(1, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
