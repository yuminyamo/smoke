#!/usr/bin/env node
// pms.mjs — 進行役(00_common.md ■進行役と記録の道具)。操作の記録・タスクキュー・カード・提出の検査・セッションの起動・報告書の生成。
//
//   node tools/pms/pms.mjs queue build --flow F-003 --phase A|C|all [--scenarios SC-PRT-01,SC-PRT-02]
//                                   カードを作る(A = 対象シナリオの requires の状態、C = シナリオのステップ・終わりの処理・報告の所見)。
//                                   C は work/_flows/F-003/stage10-context.json(工程0〜パートBの事実)が要る。C は前のラウンドが終わっていれば足せる(パートP)
//   node tools/pms/pms.mjs next   --flow F-003 [--phase A|C] [--brief]
//                                   次のカードを出す(終わっていれば done、人間の判断が要れば STOP)。カードの出力には、カードを渡す
//                                   サブエージェントの名前(agent)と依頼文(prompt)が入る。--brief は本文(body)を出さない
//                                   (IDE 内のループ(B1)の入口のエージェント pms-runner が使う。本文は card_file にある)
//   node tools/pms/pms.mjs act    --flow F-003 --card C-0001 [--intent "<目的>"] <操作> [引数...]
//                                   画面操作を1回実行し、記録(act-log.jsonl)に1行書く。操作は vocab.pms_act_action:
//                                     open <URL|<env:キー>> / goto <URL|<env:キー>> / snapshot / screenshot [ref] /
//                                     click|dblclick|hover|check|uncheck <ref> / fill|type|select|press|upload <ref> <値|<env:キー>> /
//                                     assert <ref> visible|hidden|text "<文言>" / ext --op <操作ID> -- <実行体の呼び出し...>
//   node tools/pms/pms.mjs pwcli  [--session <名前>] -- <playwright-cli の引数...>
//                                   カードを使わない作業(01・02・15・20・30 と作業10のカード以外の工程)の画面操作。
//                                   <env:キー> だけの引数を値に置き換えて playwright-cli を呼び、出力の秘密情報を <env:キー> に戻して返す。
//                                   --flow・カードは要らず、記録は書かない。--session がなければ playwright-cli の既定のセッション
//   node tools/pms/pms.mjs db     [--flow F-003 --card C-0001 --intent "<確かめること>"] -- "<SELECT 文>"
//   node tools/pms/pms.mjs db     --check [--flow F-003]
//                                   テスト環境の DB に SELECT を1つ実行する(00 ■DB への接続)。接続先・ログイン・サーバ証明書は環境情報から決め、
//                                   実行前に接続先(サーバ名・DB名・ログイン)を確かめる。SELECT 以外の文は実行しない。
//                                   カードを付ければ記録(db-log.jsonl)に1行書く。--check は接続先の確認だけをする(作業10の工程0)
//   node tools/pms/pms.mjs submit --flow F-003 --card C-0001 [--file work/_flows/F-003/out/C-0001.json]
//                                   AI の出力を検査し、合格なら記録(setup-log・探索記録・台帳)を書く
//   node tools/pms/pms.mjs run    --flow F-003 [--phase A|C|all] [--runner copilot|kiro|claude] [--max-cards N] [--dry-run]
//                                   カードを1枚ずつ新しいAIのセッション(config/pms.json の runner)で行わせ、提出を確かめて次へ進む。
//                                   全部終われば報告書と status.yaml を作り、lint を実行する(実行形態 B2)。
//                                   セッションの進み具合(道具・pms のコマンドのキーワード、動きのない時間)を標準エラー出力に出す
//   node tools/pms/pms.mjs report --flow F-003 [--dod-unmet "<満たせない DoD と理由>"]
//                                   報告書(report.md)の数値・一覧と status.yaml を記録から作る(所見は report.findings のカードの出力)
//   node tools/pms/pms.mjs stats  [--flow F-003 | --since 2026-10-01] [--json]
//                                   カードの種類・実行形態ごとの初回合格率・提出の回数・不合格の区分・出し直し・STOP、記録の必須欄の充足率
//   node tools/pms/pms.mjs status --flow F-003 [--json]   現在のカード・残りの枚数・止まっている理由・報告書を作る必要があるか(report_pending)
//   node tools/pms/pms.mjs reopen --flow F-003 --card C-0001   (人間が使う)STOP のカードを出す前に戻す
//
// 共通オプション: --root <dir>(リポジトリのルート。既定: このスクリプトの2階層上)
// 設定: config/pms.json(なければ既定値。run は runner が要る。見本 config/pms.sample.json)。時刻は環境変数 PMS_NOW で固定できる(テスト用)
// 環境変数 PMS_RUNNER(b1 / b2。vocab.pms_runner): 提出の記録に実行形態を残す。pms run は起こすセッションに b2 を付ける。
//   未設定は b1(IDE 内のループ: 入口のエージェント pms-runner がカードごとにサブエージェントを起こす)
//
// 出力: 標準出力に JSON を1つ(status・stats は --json のときだけ JSON。snapshot は画面の内容のあとに「--- pms ---」の行と JSON)。
//       pwcli は playwright-cli の出力(値を伏せたもの)をそのまま。人間向けの説明は標準エラー出力。秘密情報の値は出力と記録のどこにも書かない(<env:キー> と書く)。
// 終了コード: 0 = 成功(next はカードを出した・done、submit は合格、run はカード・報告書・lint まで終わった)/
//             1 = 失敗(submit の不合格、act・pwcli の操作の失敗、db の接続・実行の失敗、run の実行の失敗(CLI が起動しない等))/
//             2 = 使い方・設定の誤り / 3 = STOP(next・run。人間の確認待ち。run は lint の ERROR が残ったときも)/
//             4 = run が --max-cards の枚数で止まった(まだカードが残っている)
// 依存: Node.js 18 以上のみ(外部パッケージ不要)。playwright-cli は act と pwcli だけが、sqlcmd は db だけが、AI の CLI は run だけが呼ぶ。
// テスト: node --test tools/pms/test/
// 仕様(内部の構成・データの形): tools/pms/README.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Paths, UsageError, FLOW_RE } from './lib/util.mjs';
import { Store, CARD_STATUS } from './lib/store.mjs';
import { Procedure } from './lib/procedure.mjs';
import { loadConfig } from './lib/config.mjs';
import { buildQueue, nextCard, statusOf, reopenCard, targetOf } from './lib/queue.mjs';
import { act } from './lib/act.mjs';
import { pwcli } from './lib/pwcli.mjs';
import { db } from './lib/db.mjs';
import { submit } from './lib/submit.mjs';
import { run } from './lib/run.mjs';
import { noteActivity } from './lib/progress.mjs';
import { buildReport } from './lib/report.mjs';
import { stats, statsText } from './lib/stats.mjs';

const argv = process.argv.slice(2);
const opt = { root: null, session: null, check: false, flow: null, card: null, phase: null, file: null, intent: null, scenarios: null, json: false, runner: null, maxCards: null, dryRun: false, since: null, dodUnmet: null, brief: false };
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
  // pwcli は -- より後ろをすべて playwright-cli に渡す(-- より前は --session・--root だけ)
  if (pos[0] === 'pwcli') {
    if (rawAll) pos.push(a);
    else if (a === '--') rawAll = true;
    else if (a === '--session') opt.session = next();
    else if (a === '--root') opt.root = next();
    else argError ??= `pwcli の引数は -- の後ろに書く: ${a}`;
    continue;
  }
  // db は -- より後ろ(SELECT 文)をそのまま取る(-- より前は --flow・--card・--intent・--check・--root だけ)
  if (pos[0] === 'db') {
    if (rawAll) pos.push(a);
    else if (a === '--') rawAll = true;
    else if (a === '--flow') opt.flow = next();
    else if (a === '--card') opt.card = next();
    else if (a === '--intent') opt.intent = next();
    else if (a === '--check') opt.check = true;
    else if (a === '--root') opt.root = next();
    else argError ??= `db の SELECT 文は -- の後ろに書く: ${a}`;
    continue;
  }
  if (a === '--root') opt.root = next();
  else if (a === '--flow') opt.flow = next();
  else if (a === '--card') opt.card = next();
  else if (a === '--phase') opt.phase = next();
  else if (a === '--file') opt.file = next();
  else if (a === '--intent') opt.intent = next();
  else if (a === '--scenarios') opt.scenarios = next().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--json') opt.json = true;
  else if (a === '--runner') opt.runner = next();
  else if (a === '--max-cards') { const v = next(); opt.maxCards = /^\d+$/.test(String(v)) ? Number(v) : -1; }
  else if (a === '--dry-run') opt.dryRun = true;
  else if (a === '--brief') opt.brief = true;
  else if (a === '--since') opt.since = next();
  else if (a === '--dod-unmet') opt.dodUnmet = next();
  else if (a === '-h' || a === '--help') { help(); process.exit(0); }
  else if (a.startsWith('--') && pos[0] !== 'act') argError ??= `不明な引数: ${a}`;
  else pos.push(a);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(opt.root ?? path.join(scriptDir, '..', '..'));

try {
  if (argError) throw new UsageError(argError);
  const cmd = pos.shift();
  if (!cmd) { help(); throw new UsageError('サブコマンドがありません(queue / next / act / pwcli / db / submit / run / report / stats / status / reopen)'); }
  if (!opt.flow && cmd !== 'stats' && cmd !== 'pwcli' && cmd !== 'db') throw new UsageError('--flow がありません');
  if (opt.flow && !FLOW_RE.test(opt.flow)) throw new UsageError(`--flow は F-<3桁> で指定してください: ${opt.flow}`);
  const proc = new Procedure(ROOT);
  const vocabStatus = proc.values('pms_card_status');
  if (vocabStatus.join(',') !== CARD_STATUS.join(',')) throw new UsageError(`vocab.pms_card_status(${vocabStatus.join(' / ')})が pms の実装(${CARD_STATUS.join(' / ')})と違います`);
  const paths = new Paths(ROOT);
  const ctx = { root: ROOT, paths, store: new Store(paths), proc, cfg: loadConfig(ROOT).cfg };

  let res;
  switch (cmd) {
    case 'queue': {
      const sub = pos.shift();
      if (sub !== 'build') throw new UsageError('queue build --flow <フローID> --phase A|C|all');
      if (!opt.phase) throw new UsageError('--phase がありません(A / C / all)');
      const { q, added } = buildQueue(ctx, { flow: opt.flow, phase: opt.phase, scenarioIds: opt.scenarios });
      res = {
        code: 0,
        out: {
          ok: true, flow: q.flow_id, phase: q.phase, cards: added.map((c) => ({ card: c.id, kind: c.kind, state_id: c.state_id ?? null, target: targetOf(c) })),
          auto: q.auto, warnings: q.warnings, next: `node tools/pms/pms.mjs next --flow ${q.flow_id}`,
        },
      };
      break;
    }
    case 'next': res = nextCard(ctx, opt.flow, { phases: opt.phase && opt.phase !== 'all' ? [opt.phase] : null, brief: opt.brief }); break;
    case 'run': res = await run(ctx, opt); break;
    case 'report': res = buildReport(ctx, opt.flow, { dodUnmet: opt.dodUnmet }); break;
    case 'stats': {
      const st = stats(ctx, opt);
      res = { code: 0, out: opt.json ? st : statsText(st) };
      break;
    }
    case 'act': res = act(ctx, opt, pos); break;
    case 'pwcli': {
      if (!rawAll) throw new UsageError('pwcli [--session <名前>] -- <playwright-cli の引数...>(-- がありません)');
      if (opt.session !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opt.session)) throw new UsageError(`--session の名前は英数字・-・_ で書く: ${opt.session}`);
      res = pwcli(ctx, opt, pos);
      break;
    }
    case 'db': {
      if (!opt.check && !rawAll) throw new UsageError('db [--flow F --card C --intent "<確かめること>"] -- "<SELECT 文>"(-- がありません)/ db --check [--flow F]');
      res = db(ctx, opt, pos);
      break;
    }
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
    default: throw new UsageError(`不明なサブコマンド: ${cmd}(queue / next / act / pwcli / db / submit / run / report / stats / status / reopen)`);
  }
  noteActivity(cmd, pos, res.code); // pms run のセッションの中なら、進み具合の表示に使うキーワードを書く
  // process.exit は標準出力の書き出しを待たないため(大きな出力が途中で切れる)、終了コードだけを決めて戻る
  process.stdout.write((typeof res.out === 'string' ? res.out : JSON.stringify(res.out, null, 2)) + '\n');
  process.exitCode = res.code;
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  die(e.message);
}

function statusText(s) {
  const phases = Object.entries(s.phases ?? {}).map(([p, v]) => `フェーズ${p} ${v.cards} 枚(残り ${v.open})`).join(' / ');
  const lines = [
    `${s.flow}(手順版 ${s.procedure_version ?? '不明'})— カード ${s.cards} 枚: 未出 ${s.counts.pending} / 出した ${s.counts.issued} / 合格 ${s.counts.passed} / 人間の確認待ち ${s.counts.stopped} / pms が記録だけを書いた ${s.counts.skipped}${phases ? `(${phases})` : ''}`,
    s.current ? `現在のカード: ${s.current.card}(${s.current.kind} / ${s.current.target}。出した回数 ${s.current.issued_count}・不合格 ${s.current.rejections})— ${s.current.todo}` : '現在のカード: なし',
  ];
  for (const x of s.stopped) lines.push(`人間の確認待ち: ${x.card}(${x.kind} / ${x.target})— ${x.reason}`);
  for (const a of s.auto) lines.push(`pms が記録した状態: ${a.state_id}(${a.classification}・${a.reason}${a.handoff ? `・${a.handoff}` : ''})`);
  for (const w of s.warnings) lines.push(`警告: ${w}`);
  if (s.report_pending) lines.push(`報告書と status.yaml がまだない: node tools/pms/pms.mjs report --flow ${s.flow}`);
  lines.push(s.complete ? 'カードはすべて終わっている' : `次: ${s.next}`);
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
