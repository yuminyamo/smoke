// run.mjs — pms run: カードを1枚ずつ、新しいAIのセッション(Copilot CLI / Kiro CLI)で行わせる進行役のループ(実行形態 B2)
//
// ループ(次のカードを取る・やらせる・終わったかを確かめる)はこのプログラムが持ち、AIはループの1回分だけを行う。
// 終わったかどうかは、AIの「できました」ではなくキューの提出の記録で決める(合格していなければ pms next が同じカードを出し直し、
// 上限を超えたら STOP にする。段1の規則のまま)。CLI の呼び出し方は config/pms.json の runner に書き、コードに CLI のフラグを書かない。
// セッションの進み具合(道具の呼び出し・pms のコマンドのキーワード、動きのない時間)は lib/progress.mjs が標準エラー出力に出す。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextCard, phaseOf, isDone, cardOrder, targetOf, PMS } from './queue.mjs';
import { buildReport } from './report.mjs';
import { secretsToMask, mask } from './store.mjs';
import { timestamp, UsageError, writeText } from './util.mjs';
import { cardType, agentName, promptOf } from './agents.mjs';
import { runSession, fmtDur } from './progress.mjs';

const LINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lint', 'lint.mjs');

// カードの種類のエージェント・モデル・依頼文は lib/agents.mjs(pms next の B1 と共通)
export { cardType, agentName, promptOf };

/** 雛形を展開する({prompt} などを置き換え、要素 "{deny}" を使用禁止の引数に広げる) */
export function expandCommand(rc, vars, deny) {
  const sub = (s) => s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
  const out = [];
  for (const a of rc.command) {
    if (a === '{deny}') for (const p of deny) out.push(...(rc.deny_arg ?? ['--deny-tool', '{pattern}']).map((x) => x.replace('{pattern}', p)));
    else out.push(sub(a));
  }
  return out;
}

function userStop(flow, o) {
  return `カード ${o.card}(${o.kind} / ${o.target})は人間の確認待ちです: ${o.reason}。管理者に確認してください。`
    + `このカードを後回しにして残りを進めてよければ、もう一度 ${PMS} run --flow ${flow} を実行します。`
    + `原因を直してこのカードをやり直させるときは、${PMS} reopen --flow ${flow} --card ${o.card} を実行してから ${PMS} run --flow ${flow} を実行します。`;
}

/** 次に出すカード(キューを変えずに見る。--dry-run 用) */
function peek(q, phases) {
  const inScope = (c) => !phases || phases.includes(phaseOf(c));
  return q.cards.find((c) => c.status === 'issued' && inScope(c)) ?? q.cards.filter((c) => c.status === 'pending' && inScope(c)).sort(cardOrder)[0] ?? null;
}

function lint(root, flow) {
  const r = spawnSync(process.execPath, [LINT, '--root', root, '--flow', flow, '--stage', '10', '--skip', 'skills_in_sync', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 読めなければ null */ }
  return { code: r.status, json, stderr: r.stderr };
}

/**
 * @param opt {flow, phase: 'A'|'C'|'all', runner, maxCards, dryRun}
 * @returns {Promise<{code: number, out: object}>} 0 = 全部終わった / 3 = STOP / 1 = 実行の失敗 / 4 = --max-cards で止めた
 */
export async function run(ctx, opt) {
  const { root, paths, store, cfg } = ctx;
  const phase = opt.phase ?? 'all';
  if (!['A', 'C', 'all'].includes(phase)) throw new UsageError(`--phase は A / C / all のいずれか: ${phase}`);
  const phases = phase === 'all' ? null : [phase];
  const name = opt.runner ?? cfg.default_runner;
  if (!cfg.runner) throw new UsageError('config/pms.json に runner がありません(見本 config/pms.sample.json の runner を写し、CLI の呼び出し方を確かめる)');
  const rc = cfg.runner[name];
  if (!rc) throw new UsageError(`config/pms.json の runner に ${name} がありません(${Object.keys(cfg.runner).filter((k) => !k.startsWith('_')).join(' / ')})`);
  if (opt.maxCards != null && !(Number.isInteger(opt.maxCards) && opt.maxCards > 0)) throw new UsageError('--max-cards は1以上の整数');
  const timeoutMs = (rc.timeoutSec ?? 900) * 1000;
  const heartbeatMs = (rc.heartbeatSec ?? 30) * 1000;
  const stallMs = (rc.stallWarnSec ?? 180) * 1000;
  const sessions = [];
  const log = (m) => process.stderr.write(`[pms run] ${m}\n`);

  if (opt.dryRun) {
    const q = store.loadQueue(opt.flow);
    const c = peek(q, phases);
    if (!c) return { code: 0, out: { state: 'dry-run', flow: opt.flow, card: null, message: '出すカードがない(pms report と lint に進む)' } };
    const t = cardType(ctx, c.kind, name);
    const cardFile = paths.card(opt.flow, c.id);
    const cmd = expandCommand(rc, { prompt: promptOf(opt.flow, c.id, cardFile), agent: t.agent, model: t.model, card_file: cardFile, flow: opt.flow, card: c.id }, [...(rc.deny ?? []), ...t.deny]);
    return { code: 0, out: { state: 'dry-run', flow: opt.flow, card: c.id, kind: c.kind, target: targetOf(c), runner: name, command: cmd, stdin: rc.stdin === 'prompt', timeoutSec: timeoutMs / 1000, env: { PMS_RUNNER: 'b2' } } };
  }

  // このプロセスが出すカードは、B2 のセッションのためのもの(queue の history に実行形態を残す)
  process.env.PMS_RUNNER = 'b2';
  for (let n = 0; ; n++) {
    if (opt.maxCards != null && n >= opt.maxCards) {
      return { code: 4, out: { state: 'paused', flow: opt.flow, sessions, message: `--max-cards ${opt.maxCards} 枚で止めた。続けるときはもう一度 pms run を実行する` } };
    }
    const nx = nextCard(ctx, opt.flow, { phases });
    if (nx.code === 3) {
      const o = nx.out;
      return { code: 3, out: { state: 'STOP', flow: opt.flow, card: o.card, kind: o.kind, target: o.target, code: o.code, reason: o.reason, remaining: o.remaining, sessions, message: userStop(opt.flow, o) } };
    }
    if (nx.out.state === 'done') {
      const q = store.loadQueue(opt.flow);
      const doC = q.cards.some((c) => phaseOf(c) === 'C') && (!phases || phases.includes('C'));
      if (!doC) return { code: 0, out: { state: 'done', flow: opt.flow, sessions, stopped: nx.out.stopped, message: nx.out.message } };
      if (q.cards.some((c) => !isDone(c))) return { code: 0, out: { state: 'done', flow: opt.flow, sessions, message: '対象のフェーズのカードは終わった' } };
      log('カードがすべて終わった。報告書と status.yaml を作り、lint を実行する');
      const rep = buildReport(ctx, opt.flow);
      const l = lint(root, opt.flow);
      if (l.code === 0) {
        return { code: 0, out: { state: 'done', flow: opt.flow, sessions, report: rep.out, lint: { ok: true }, message: `${opt.flow} の作業10のカード・報告書・lint が終わった。チャットで「${opt.flow} の続き」と伝える` } };
      }
      if (l.code === 1) {
        const errors = (l.json?.results ?? []).filter((x) => x.severity === 'ERROR' && x.status === 'ng').flatMap((x) => x.findings.map((f) => `${x.rule}: ${f.file}: ${f.message}`));
        return {
          code: 3,
          out: {
            state: 'STOP', flow: opt.flow, code: 'lint_error', reason: `lint の ERROR が ${errors.length} 件残った`, errors: errors.slice(0, 30), sessions, report: rep.out,
            message: `${opt.flow} の報告書を作ったが、記録の検査(lint)で直すところが見つかった(${errors.length} 件)。チャットで「${opt.flow} の続き」と伝えると、作業10が指摘を直す。`,
          },
        };
      }
      return { code: 1, out: { state: 'error', flow: opt.flow, error: `lint を実行できない(終了コード ${l.code}): ${String(l.stderr).trim().slice(0, 500)}`, sessions } };
    }

    // カードを1枚、新しいセッションで行わせる
    const card = nx.out;
    const t = cardType(ctx, card.kind, name);
    const vars = { prompt: promptOf(opt.flow, card.card, card.card_file), agent: t.agent, model: t.model, card_file: card.card_file, flow: opt.flow, card: card.card };
    const cmd = expandCommand(rc, vars, [...(rc.deny ?? []), ...t.deny]);
    const started = timestamp();
    log(`${card.card}(${card.kind} / ${card.target}、${card.issued_count} 回目)を ${name} で行わせる(上限 ${fmtDur(timeoutMs)}。動きがなければ ${fmtDur(heartbeatMs)} ごとに経過を出す)`);
    const secrets = secretsToMask(root);
    const file = paths.run(opt.flow, card.card, card.issued_count);
    // セッションの中で AI が実行した pms のコマンドを、pms.mjs がこのファイルに書く(進み具合の表示だけに使い、終わったら消す)
    const activityFile = paths.abs(file.replace(/\.jsonl$/, '.activity'));
    fs.mkdirSync(path.dirname(activityFile), { recursive: true });
    fs.rmSync(activityFile, { force: true });
    const r = await runSession(cmd, {
      cwd: root, timeoutMs, heartbeatMs, stallMs, label: card.card, log, secrets, activityFile,
      input: rc.stdin === 'prompt' ? vars.prompt : undefined,
      env: { ...process.env, PMS_RUNNER: 'b2', PMS_FLOW: opt.flow, PMS_CARD: card.card, PMS_ACTIVITY: activityFile },
    });
    fs.rmSync(activityFile, { force: true });
    if (r.error && r.error.code === 'ENOENT') {
      return { code: 1, out: { state: 'error', flow: opt.flow, card: card.card, error: `${cmd[0]} を起動できない(導入と PATH、config/pms.json の runner.${name}.command を確かめる)`, sessions } };
    }
    const timedOut = r.timedOut || (r.signal && !r.status);
    const ended = timestamp();
    // セッションの出力を保存する(秘密情報の値は伏せる)
    const tail = { pms: { card: card.card, kind: card.kind, runner: name, attempt: card.issued_count, exit_code: r.status, signal: r.signal ?? null, timed_out: !!timedOut, started_at: started, ended_at: ended, stderr: mask(String(r.stderr ?? '').slice(-4000), secrets) } };
    writeText(paths.abs(file), `${mask(String(r.stdout ?? ''), secrets).replace(/\n*$/, '\n')}${JSON.stringify(tail)}\n`);
    const q = store.loadQueue(opt.flow);
    const after = q.cards.find((x) => x.id === card.card);
    q.history.push({ at: ended, card: card.card, event: 'session', runner: name, attempt: card.issued_count, exit_code: r.status, timed_out: !!timedOut, status: after?.status, output: file });
    store.saveQueue(q);
    sessions.push({ card: card.card, kind: card.kind, attempt: card.issued_count, exit_code: r.status, timed_out: !!timedOut, status: after?.status, output: file });
    if ((rc.fatal_exit_codes ?? []).includes(r.status)) {
      return { code: 1, out: { state: 'error', flow: opt.flow, card: card.card, error: `${name} が終了コード ${r.status} で終わった(引数・設定の誤り。${file} を確かめる)`, sessions } };
    }
    log(`${card.card}: ${after?.status === 'passed' ? '合格' : after?.status === 'stopped' ? '人間の確認待ち' : timedOut ? '時間切れ(未提出として扱う)' : '未提出・不合格(同じカードを出し直す)'}`);
  }
}
