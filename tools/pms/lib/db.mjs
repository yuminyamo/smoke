// db.mjs — pms db: テスト環境の DB への SELECT を、接続先の確認と記録つきで1回実行する(00 ■DB への接続 [R-DB-2])
//
// 接続先(db.server・db.name)・ログイン(db.auth・db.user・db.password)・サーバ証明書(db.trust_server_certificate)は
// pms が環境情報から決める。AI は接続情報を調べず、SELECT 文だけを渡す(カードのセッションでは env.mjs get が使用禁止のため。proc-v024)

import { spawnSync } from 'node:child_process';
import { load as loadEnv, selectEnv, EnvError } from '../../env/lib/environments.mjs';
import { secretsToMask, mask, maskDeep } from './store.mjs';
import { PMS, todoOf, submitCommand, targetOf } from './queue.mjs';
import { timestamp, UsageError } from './util.mjs';

export const DB_TRUST_KEY = 'db.trust_server_certificate';
export const DB_AUTH_KEY = 'db.auth';
const DB_AUTH_VALUES = ['windows', 'sql'];

const LOGIN_TIMEOUT_SEC = 15;
const QUERY_TIMEOUT_SEC = 60;
const MAX_LINES = 200;
const MAX_CHARS = 20_000;

/**
 * 使う環境の DB の設定。envId はフローの stage10-context の environment(なければ env.mjs と同じ選び方)。
 * 任意キー(vocab.env_optional_keys)は未登録・不正な値なら既定値で補い、そのことを *_src に書く
 * @returns {{ env, server, name, auth, authSrc, user, password, trust, trustSrc, missing: string[] }}
 */
export function dbSettings(root, vocab, envId = null) {
  let env = null;
  let attrs = new Map();
  try {
    const cfg = loadEnv(root);
    env = selectEnv(cfg, envId).env;
    attrs = (env ? cfg.envs.get(env)?.attributes : null) ?? new Map();
  } catch (e) {
    if (!(e instanceof EnvError)) throw e;
  }
  const val = (k) => {
    const v = attrs.get(k)?.value;
    return v === undefined || v === '' ? null : String(v);
  };
  const optional = (k, allowed) => {
    const def = String(vocab?.env_optional_keys?.[k]?.default ?? allowed[0]);
    const raw = val(k);
    const norm = raw === null ? null : raw.trim().toLowerCase();
    if (norm !== null && allowed.includes(norm)) return { value: norm, src: norm };
    return { value: def, src: raw === null ? `未登録のため既定の ${def}` : `値 "${raw}" は ${allowed.join(' / ')} でないため既定の ${def}` };
  };
  const trust = optional(DB_TRUST_KEY, ['true', 'false']);
  const auth = optional(DB_AUTH_KEY, DB_AUTH_VALUES);
  const s = {
    env, server: val('db.server'), name: val('db.name'), auth: auth.value, authSrc: auth.src,
    user: val('db.user'), password: val('db.password'), trust: trust.value === 'true', trustSrc: trust.src, missing: [],
  };
  for (const k of ['db.server', 'db.name', ...(s.auth === 'sql' ? ['db.user', 'db.password'] : [])]) if (val(k) === null) s.missing.push(k);
  return s;
}

/**
 * カードの「DB の接続」の行(explore.step・explore.close・explore.session_close)。
 * DB の確かめ方(pms db)と、この環境の接続先・ログインの方式・サーバ証明書の扱い(人間の承認)を書く。パスワードは書かない
 */
export function dbConnection(root, vocab, envId = null, dbCmd = `${PMS} db`) {
  const s = dbSettings(root, vocab, envId);
  const target = `サーバ ${s.server ?? '(未登録)'} / DB ${s.name ?? '(未登録)'} / ログイン ${s.auth === 'sql' ? `SQL Server 認証(${s.user ?? 'db.user 未登録'})` : '実行するアカウントの Windows 認証'}(環境情報 ${DB_AUTH_KEY}: ${s.authSrc})`;
  const trust = s.trust
    ? `サーバ証明書の検証を無効にして接続する(人間が承認済み。環境情報 ${DB_TRUST_KEY}: ${s.trustSrc})。証明書のエラーを理由に止まらない [R-DB-1]`
    : `サーバ証明書を検証して接続する(環境情報 ${DB_TRUST_KEY}: ${s.trustSrc})。証明書のエラーで接続できなければ cannot_proceed で提出する [R-DB-1]`;
  const missing = s.missing.length ? ` **環境情報 ${s.missing.join('・')} が未登録のため、いまは接続できない(pms db が失敗したら cannot_proceed で提出する)。**` : '';
  return `\`${dbCmd} --intent "<確かめること>" -- "<SELECT 文>"\` で行う(sqlcmd などを直接呼ばない。接続情報を調べない [R-DB-2])。この環境: ${target}。${trust}。${missing}`.trim();
}

// SELECT 文の中で使えない語(DB操作の安全規約。SELECT のみ・DDL なし。SELECT INTO・手続きの実行・変数・トランザクションの操作も止める)
const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY',
  'BACKUP', 'RESTORE', 'DBCC', 'SHUTDOWN', 'KILL', 'USE', 'INTO', 'DECLARE', 'SET', 'WAITFOR', 'OPENROWSET', 'OPENQUERY',
  'OPENDATASOURCE', 'OPENXML', 'BULK', 'RECONFIGURE', 'CHECKPOINT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'GOTO', 'PRINT',
  'RAISERROR', 'THROW', 'READTEXT', 'WRITETEXT', 'UPDATETEXT', 'SETUSER', 'REVERT',
];

/**
 * SELECT 文を1つだけ受け付ける(00 ■DB操作の安全規約)。コメント・文字列・区切った識別子([…]・"…")を除いてから語を調べる
 * @returns {{ sql: string } | { error: string }} sql は末尾の ; を除いた文
 */
export function selectOnly(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return { error: 'SELECT 文がありません' };
  // sqlcmd のコマンド(:r・:connect・!! など)・バッチの区切り GO・sqlcmd の変数は、文字列の中でも受け付けない
  if (/^\s*(:|!!)/m.test(raw)) return { error: 'sqlcmd のコマンド(行頭の : や !!)は使えない' };
  if (/^\s*go\s*$/im.test(raw)) return { error: 'バッチの区切り GO は使えない(SELECT 文を1つだけ渡す)' };
  if (raw.includes('$(')) return { error: 'sqlcmd の変数 $(…) は使えない' };
  let out = '';
  for (let i = 0; i < raw.length;) {
    const two = raw.slice(i, i + 2);
    if (two === '--') {
      const j = raw.indexOf('\n', i);
      i = j < 0 ? raw.length : j;
      out += ' ';
    } else if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < raw.length && depth > 0) {
        if (raw.startsWith('/*', j)) { depth++; j += 2; } else if (raw.startsWith('*/', j)) { depth--; j += 2; } else j++;
      }
      if (depth > 0) return { error: 'コメント /* が閉じていない' };
      i = j;
      out += ' ';
    } else if (raw[i] === "'" || raw[i] === '"' || raw[i] === '[') {
      const close = raw[i] === '[' ? ']' : raw[i];
      let j = i + 1;
      for (;;) {
        const k = raw.indexOf(close, j);
        if (k < 0) return { error: `${raw[i]} が閉じていない` };
        if (raw[k + 1] === close) { j = k + 2; continue; }
        j = k + 1;
        break;
      }
      out += raw[i] === "'" ? " '' " : ' x ';
      i = j;
    } else {
      out += raw[i++];
    }
  }
  const body = out.trim().replace(/;\s*$/, '');
  if (body.includes(';')) return { error: '文は1つだけ渡す(; で文をつながない)' };
  if (!/^(SELECT|WITH)\b/i.test(body)) return { error: 'SELECT(または WITH … SELECT)で始まる文だけを実行できる' };
  const words = new Set(body.toUpperCase().match(/[A-Z_][A-Z0-9_$#@]*/g) ?? []);
  const bad = FORBIDDEN.filter((w) => words.has(w));
  if (bad.length) return { error: `SELECT 文に使えない語がある: ${bad.join(', ')}(列名などなら [ ] で囲む)` };
  const proc = [...words].find((w) => /^(XP|SP)_/.test(w));
  if (proc) return { error: `手続き ${proc.toLowerCase()} は使えない` };
  return { sql: raw.replace(/;\s*$/, '') };
}

/** sqlcmd の呼び出し(config/pms.json の db_cli)。パスワードは環境変数 SQLCMDPASSWORD で渡し、引数に書かない */
function sqlcmd(cfg, s, query, { headers }) {
  const args = [
    '-S', s.server, '-d', s.name,
    ...(s.auth === 'sql' ? ['-U', s.user] : ['-E']),
    ...(s.trust ? ['-C'] : []),
    '-b', '-X', '-l', String(LOGIN_TIMEOUT_SEC), '-t', String(QUERY_TIMEOUT_SEC), '-W', '-s', '\t', '-w', '65535',
    ...(headers ? [] : ['-h', '-1']),
    '-Q', query,
  ];
  const env = { ...process.env };
  delete env.SQLCMDPASSWORD;
  if (s.auth === 'sql') env.SQLCMDPASSWORD = s.password;
  const r = spawnSync(cfg.db_cli[0], [...cfg.db_cli.slice(1), ...args], {
    encoding: 'utf8', env, timeout: (LOGIN_TIMEOUT_SEC + QUERY_TIMEOUT_SEC + 15) * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error && r.error.code === 'ENOENT') throw new UsageError(`${cfg.db_cli[0]} が見つかりません(sqlcmd を入れるか、config/pms.json の db_cli を直す)`);
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null };
}

function failText(r) {
  return (r.error ?? (r.stderr.trim() || r.stdout.trim()) ?? '').slice(0, 500) || `終了コード ${r.code}`;
}

/** 接続先の確認(DB操作の安全規約: 実行前に接続先を確かめ、サーバ名・DB名を残す) */
function checkTarget(cfg, s) {
  const r = sqlcmd(cfg, s, 'SET NOCOUNT ON; SELECT @@SERVERNAME, DB_NAME(), SUSER_SNAME();', { headers: false });
  if (r.code !== 0) return { ok: false, reason: 'connect_failed', error: `DB に接続できない: ${failText(r)}` };
  const line = r.stdout.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const [serverName = null, dbName = null, login = null] = line.split('\t').map((x) => x.trim() || null);
  const target = { server_name: serverName, db_name: dbName, login };
  if (!dbName || dbName.toLowerCase() !== String(s.name).toLowerCase()) {
    return { ok: false, reason: 'target_mismatch', target, error: `接続先の DB が環境情報の db.name(${s.name})と違う(${dbName ?? '取得できない'})。実行しない` };
  }
  return { ok: true, target };
}

/** sqlcmd の表(-W -s TAB)の行数。見出しと区切り線のあとの行を数える(数えられなければ null) */
function countRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.length >= 2 && /^[-\t ]+$/.test(lines[1]) ? lines.length - 2 : null;
}

function clip(text) {
  const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  let t = lines.slice(0, MAX_LINES).join('\n');
  const truncated = lines.length > MAX_LINES || t.length > MAX_CHARS;
  if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS);
  return { text: t, truncated };
}

/**
 * @param ctx  { root, paths, store, proc, cfg }
 * @param opt  { flow, card, intent, check }
 * @param args [SELECT 文](-- の後ろ。--check のときは空)
 * @returns {{ code: number, out: object }}
 */
export function db(ctx, opt, args) {
  const { root, paths, store, proc, cfg } = ctx;
  let q = null;
  let c = null;
  if (opt.card) {
    if (!opt.flow) throw new UsageError('--card には --flow が要ります');
    q = store.loadQueue(opt.flow);
    c = store.card(q, opt.card);
    if (c.status !== 'issued') throw new UsageError(`${c.id} は出ていないカードです(状態 ${c.status})。${PMS} next --flow ${q.flow_id} で今のカードを確かめる`);
    if (!opt.intent && !opt.check) throw new UsageError('--intent "<確かめること>" が要ります');
  } else if (opt.flow && store.hasQueue(opt.flow)) {
    q = store.loadQueue(opt.flow);
  }
  let sql = null;
  if (opt.check) {
    if (args.length) throw new UsageError('db --check は SELECT 文を取らない');
  } else {
    if (args.length !== 1) throw new UsageError('db [--flow F --card C --intent "<確かめること>"] -- "<SELECT 文>"(文は1つの引数にする)');
    const v = selectOnly(args[0]);
    if (v.error) throw new UsageError(`${v.error}。DB操作の安全規約(SELECT のみ)により実行しない`);
    sql = v.sql;
  }

  const s = dbSettings(root, proc.vocab, (q?.rounds ?? []).at(-1)?.context?.environment ?? null);
  const masks = secretsToMask(root);
  if (s.password) masks.push({ key: 'db.password', value: s.password });
  const settings = { env: s.env, server: s.server, name: s.name, auth: s.auth, user: s.user, trust_server_certificate: s.trust };
  const row = {
    flow: q?.flow_id ?? null, card: c?.id ?? null, ...(c?.step_id ? { step_id: c.step_id } : {}), intent: opt.intent ?? null,
    sql: opt.check ? null : sql, env: s.env, server: s.server, name: s.name, target: null,
    started_at: timestamp(), ended_at: null, ok: false, rows: null, reason: null, error: null,
  };
  let output = null;
  if (s.missing.length) {
    row.reason = 'env_missing';
    row.error = `環境情報 ${s.missing.join('・')} がない(環境 ${s.env ?? '未決定'})。node tools/env/env.mjs require --keys ${s.missing.map((k) => `${k}:${k === 'db.password' ? 'secret' : k === 'db.user' ? 'account' : 'endpoint'}`).join(',')} で確かめ、足りなければ人間に聞いて set で保存する(AIは値を調べない)`;
  } else {
    const t = checkTarget(cfg, s);
    row.target = t.target ?? null;
    if (!t.ok) {
      row.reason = t.reason;
      row.error = t.error;
    } else if (opt.check) {
      row.ok = true;
    } else {
      // SELECT だけを通しているが、念のためトランザクションの中で実行して取り消す
      const r = sqlcmd(cfg, s, `SET NOCOUNT ON; BEGIN TRAN; ${sql}\n; ROLLBACK TRAN;`, { headers: true });
      if (r.code !== 0) {
        row.reason = 'query_failed';
        row.error = `SELECT が失敗した: ${failText(r)}`;
      } else {
        row.ok = true;
        row.rows = countRows(r.stdout);
        output = clip(r.stdout);
      }
    }
  }
  row.ended_at = timestamp();
  const rec = maskDeep(row, masks);
  if (c) store.appendDb(c.feature, rec);

  const out = {
    ok: rec.ok, ...(opt.check ? { check: true } : {}), settings: maskDeep(settings, masks), target: rec.target,
    ...(opt.check ? {} : { sql: rec.sql, rows: rec.rows, output: output ? mask(output.text, masks) : null, truncated: output?.truncated ?? false }),
    reason: rec.reason, error: rec.error,
  };
  if (c) {
    out.now = { flow: q.flow_id, card: c.id, kind: c.kind, state_id: c.state_id ?? null, target: targetOf(c), todo: todoOf(c) };
    out.next = submitCommand(q, c, paths);
    out.hint = rec.ok
      ? `SELECT 文と結果の要点を出力に書く(記録は ${paths.dbLog(c.feature)} に残した)。続けて確かめるなら同じ形で pms db を使う`
      : '実行できなかった(記録は残した)。文の誤りなら直してやり直す。接続できない・環境情報が足りないなら、error を notes に写して cannot_proceed で提出する';
  }
  return { code: rec.ok ? 0 : 1, out };
}
