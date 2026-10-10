// progress.mjs — pms run が起こした AI のセッションを非同期で動かし、進み具合を標準エラー出力に短く出す
//
// spawnSync ではセッションが終わるまで何も見えないため、次の2つを「動き」として拾う:
//   - AI の CLI の標準出力(JSONL)・標準エラー出力。JSON の行に道具の呼び出し(道具の名前と、コマンド・パス)があればキーワードにする
//   - セッションの中で AI が実行した pms のコマンド(pms run が渡す環境変数 PMS_ACTIVITY のファイルに、pms.mjs が1行ずつ書く)
// キーワードが変わったら間引いて1行出し、何も出していなければ heartbeatSec ごとに経過を出す。
// stallWarnSec を超えて動きがなければ「止まっている可能性」を添える(長いコマンドを実行しているときもこうなる。最後のキーワードで見分ける)。
// 出力の形は CLI ごとに違い、実物で確かめていない(README 13章)。キーワードが取れなくても、動きの時刻と経過は出す。

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { mask } from './store.mjs';

const TICK_MS = 1000;
const MIN_GAP_MS = 3000; // キーワードの行の間隔の下限(道具の呼び出しが続いても流れすぎないように)
const TOOL_KEYS = ['toolName', 'tool_name', 'tool'];
const DETAIL_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'file', 'pattern', 'url'];

/** 経過時間の表示(45秒 / 3分05秒) */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

/** オブジェクトを浅い順にたどり、pred(キー, 値, 親, 親のキー) に合う最初の値を返す(深さ6まで。Claude Code の stream-json は message.content[].input.command にある) */
function find(o, pred) {
  let level = [[o, '']];
  for (let d = 0; d < 6 && level.length; d++) {
    const nextLevel = [];
    for (const [obj, pk] of level) {
      for (const [k, v] of Object.entries(obj)) {
        if (pred(k, v, obj, pk)) return v;
        if (v && typeof v === 'object') nextLevel.push([v, k]);
      }
    }
    level = nextLevel;
  }
  return null;
}

const short = (s, n = 60) => {
  const t = String(s).split('\n')[0].replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** AI の CLI の出力の1行から、道具の呼び出しのキーワードを取り出す(なければ null) */
export function keywordOf(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const tool = find(o, (k, v, parent, pk) => typeof v === 'string' && v !== ''
    && (TOOL_KEYS.includes(k) || (k === 'name' && (/tool/i.test(String(parent.type ?? '')) || /tool/i.test(pk)))));
  if (!tool) return null;
  const detail = find(o, (k, v) => typeof v === 'string' && v !== '' && DETAIL_KEYS.includes(k));
  return detail ? `${short(tool, 30)} ${short(detail)}` : short(tool, 30);
}

/** セッションの中で実行された pms のコマンドを PMS_ACTIVITY のファイルに書く(pms.mjs が呼ぶ。pms run の外では何もしない) */
export function noteActivity(cmd, args, code) {
  const f = process.env.PMS_ACTIVITY;
  if (!f || !cmd) return;
  let kw = `pms ${cmd}`;
  if (cmd === 'act') kw += ` ${args[0] ?? ''}${code ? ' 失敗' : ''}`;
  else if (cmd === 'submit') kw += code === 0 ? ' 合格' : ' 不合格';
  else if (code) kw += ` 終了コード ${code}`;
  try { fs.appendFileSync(f, `${JSON.stringify({ kw })}\n`); } catch { /* 進み具合の表示だけに使う */ }
}

/**
 * AI の CLI を起こし、終わるまで進み具合を log に出す
 * @param opt {cwd, env, input, timeoutMs, heartbeatMs, stallMs, label, log, secrets, activityFile}
 * @returns {Promise<{status, signal, stdout, stderr, error, timedOut}>}
 */
export function runSession(cmd, opt) {
  const { log, label, secrets = [], activityFile } = opt;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = [];
    const err = [];
    let carry = '';
    let lastMove = t0; // 最後に動きがあった時刻
    let lastKw = null; // 最後のキーワード
    let pending = null; // まだ出していないキーワード
    let printedAt = t0; // 最後に行を出した時刻(経過の行の間隔)
    let kwAt = -Infinity; // 最後にキーワードの行を出した時刻
    let warned = false;
    let timedOut = false;
    let error = null;
    let actOffset = 0;
    let settled = false;

    const now = () => Date.now();
    const print = (m) => { log(`${label} ${fmtDur(now() - t0)}: ${m}`); printedAt = now(); };
    const move = (kw) => {
      lastMove = now();
      warned = false;
      if (kw && kw !== lastKw) { lastKw = kw; pending = kw; }
    };
    const readActivity = () => {
      if (!activityFile) return;
      let buf;
      try { buf = fs.readFileSync(activityFile); } catch { return; }
      if (buf.length <= actOffset) return;
      const text = buf.subarray(actOffset).toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return;
      actOffset += Buffer.byteLength(text.slice(0, end + 1));
      for (const l of text.slice(0, end).split('\n')) {
        try { move(JSON.parse(l).kw); } catch { /* 書きかけの行は飛ばす */ }
      }
    };
    const tick = () => {
      readActivity();
      const t = now();
      if (pending && t - kwAt >= MIN_GAP_MS) {
        print(mask(pending, secrets));
        kwAt = t;
        pending = null;
        return;
      }
      const idle = t - lastMove;
      const stalled = idle >= opt.stallMs;
      if ((stalled && !warned) || t - printedAt >= opt.heartbeatMs) {
        const where = `最後の動き ${fmtDur(idle)}前${lastKw ? `(${mask(lastKw, secrets)})` : ''}`;
        print(stalled
          ? `${where}。${fmtDur(idle)} 動きがない — 長いコマンドの実行中か、止まっている可能性(上限 ${fmtDur(opt.timeoutMs)} で打ち切る)`
          : `実行中 — ${where}`);
        if (stalled) warned = true;
      }
    };

    let child;
    try {
      child = spawn(cmd[0], cmd.slice(1), { cwd: opt.cwd, env: opt.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error: e, timedOut: false });
      return;
    }
    const timer = setInterval(tick, TICK_MS);
    const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opt.timeoutMs);
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(killer);
      resolve({ status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error, timedOut });
    };

    child.stdout.on('data', (b) => {
      out.push(b);
      const lines = (carry + b.toString('utf8')).split('\n');
      carry = lines.pop();
      move(null);
      for (const l of lines) move(keywordOf(l));
    });
    child.stderr.on('data', (b) => { err.push(b); move(null); });
    child.on('error', (e) => {
      error = e;
      if (e.code === 'ENOENT' || child.pid === undefined) finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => { /* 標準入力を読まずに終わる CLI */ });
    child.stdin.end(opt.input ?? '');
  });
}
