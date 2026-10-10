// db.test.mjs — pms db(DB への SELECT。proc-v024)のテスト(node --test tools/pms/test/)
//
// sqlcmd は偽物(test-support/stub-sqlcmd.mjs)、環境情報は偽物の設定ファイルに差し替える。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, write, read, exists, pms, SECRET, PMS_DIR } from '../test-support/helpers.mjs';
import { selectOnly, dbConnection } from '../lib/db.mjs';

// パスは fileURLToPath で作った PMS_DIR から組み立てる(URL の pathname は Windows で /C:/… になり、path.resolve が C:\C:\… にする)
const STUB_SQLCMD = path.join(PMS_DIR, 'test-support', 'stub-sqlcmd.mjs');
const DB_PASSWORD = 'Db-Passw0rd#1';

/** db.* の環境情報を足したリポジトリ。attrs で共有の設定の属性を足す(null は消す) */
function repo(attrs = {}, { local = {}, stub = {} } = {}) {
  const root = makeRepo({}, { config: { db_cli: [process.execPath, STUB_SQLCMD] } });
  const f = JSON.parse(read(root, 'config/environments.json'));
  const a = f.environments.vm01.attributes;
  Object.assign(a, { 'db.server': { kind: 'endpoint', value: 'pms-test-01\\SQLEXPRESS' }, 'db.name': { kind: 'endpoint', value: 'PMS' } });
  for (const [k, v] of Object.entries(attrs)) { if (v === null) delete a[k]; else a[k] = v; }
  write(root, 'config/environments.json', JSON.stringify(f));
  const l = JSON.parse(read(root, 'config/environments.local.json'));
  Object.assign(l.environments.vm01.attributes, local);
  write(root, 'config/environments.local.json', JSON.stringify(l));
  write(root, '.stub/sqlcmd.json', JSON.stringify(stub));
  return root;
}

function calls(root) {
  const f = path.join(root, '.stub', 'sqlcmd-calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const SQL_AUTH = {
  attrs: { 'db.auth': { kind: 'other', value: 'sql' }, 'db.user': { kind: 'account', value: 'e2e-reader' } },
  local: { 'db.password': { kind: 'secret', value: DB_PASSWORD } },
};

test('selectOnly: SELECT・WITH を1文だけ受け付け、書き込み・DDL・複数の文・sqlcmd のコマンドを止める(00 ■DB操作の安全規約)', () => {
  const ok = (sql) => { const r = selectOnly(sql); assert.ok(!r.error, `${sql} → ${r.error}`); return r.sql; };
  const ng = (sql, re) => { const r = selectOnly(sql); assert.ok(r.error, `${sql} を受け付けた`); if (re) assert.match(r.error, re); };
  assert.equal(ok('SELECT COUNT(*) FROM PrintJob WHERE JobId = 1;'), 'SELECT COUNT(*) FROM PrintJob WHERE JobId = 1');
  ok('with j as (select * from PrintJob) select Status from j');
  ok("SELECT * FROM T WHERE Note = 'update; drop table x' -- delete\n");
  ok('SELECT [Update], "Set" FROM T /* insert into */');
  ok('SELECT @@SERVERNAME, DB_NAME()');
  ng('', /SELECT 文がありません/);
  ng('UPDATE PrintJob SET Status = 1', /SELECT\(または WITH … SELECT\)で始まる/);
  ng('SELECT 1; DELETE FROM PrintJob', /文は1つだけ/);
  ng('SELECT * INTO Copy FROM PrintJob', /INTO/);
  ng('SELECT * FROM T WHERE 1 = (SELECT 1 FROM OPENROWSET(BULK \'x\', SINGLE_BLOB) b)', /OPENROWSET, BULK/);
  ng('SELECT * FROM sys.tables; EXEC xp_cmdshell \'dir\'', /文は1つだけ/);
  ng('SELECT name FROM master..xp_dirtree', /手続き xp_dirtree/);
  ng('SELECT 1\n:!! dir', /sqlcmd のコマンド/);
  ng('SELECT 1\nGO\nDROP TABLE T', /GO/);
  ng("SELECT '$(x)'", /sqlcmd の変数/);
  ng("SELECT 'abc", /' が閉じていない/);
  ng('SELECT 1 /* x', /コメント \/\* が閉じていない/);
});

test('db: Windows 認証(既定)で、接続先を確かめてから SELECT をトランザクションの中で実行する。カードなしは記録を書かない', () => {
  const root = repo();
  const r = pms(root, ['db', '--', 'SELECT JobId, Status FROM PrintJob']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.target, { server_name: 'PMS-TEST-01\\SQLEXPRESS', db_name: 'PMS', login: 'CORP\\e2e' });
  assert.deepEqual(r.json.settings, { env: 'vm01', server: 'pms-test-01\\SQLEXPRESS', name: 'PMS', auth: 'windows', user: null, trust_server_certificate: true });
  assert.equal(r.json.rows, 2);
  assert.match(r.json.output, /^JobId\tStatus\n/);
  const c = calls(root);
  assert.equal(c.length, 2);
  for (const x of c) {
    assert.deepEqual(x.args.slice(0, 8), ['-S', 'pms-test-01\\SQLEXPRESS', '-d', 'PMS', '-E', '-C', '-b', '-X1']);
    assert.ok(!x.args.includes('-U'));
    assert.equal(x.stdin_password, null);
  }
  assert.match(c[0].args.at(-1), /@@SERVERNAME, DB_NAME\(\), SUSER_SNAME\(\)/);
  assert.equal(c[1].args.at(-1), 'SET NOCOUNT ON; BEGIN TRAN; SELECT JobId, Status FROM PrintJob\n; ROLLBACK TRAN;');
  assert.ok(!exists(root, 'work/PRT/exploration/db-log.jsonl'));
});

test('db: SQL Server 認証はパスワードを標準入力で渡し(-X1 は環境変数を読ませないため)、引数・出力に書かない。証明書を検証する設定なら -C を付けない', () => {
  const root = repo({ ...SQL_AUTH.attrs, 'db.trust_server_certificate': { kind: 'other', value: 'false' } }, {
    local: SQL_AUTH.local, stub: { result: `Note\n----\n${DB_PASSWORD} と ${SECRET}\n`, prompt: true },
  });
  const r = pms(root, ['db', '--', 'SELECT Note FROM T']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.settings.auth, 'sql');
  assert.equal(r.json.settings.user, 'e2e-reader');
  assert.ok(!r.stdout.includes(DB_PASSWORD) && !r.stdout.includes(SECRET), '秘密情報の値が出ている');
  assert.match(r.json.output, /<env:db\.password> と <env:pms\.admin\.password>/);
  for (const x of calls(root)) {
    assert.deepEqual(x.args.slice(0, 6), ['-S', 'pms-test-01\\SQLEXPRESS', '-d', 'PMS', '-U', 'e2e-reader']);
    assert.ok(!x.args.includes('-C') && !x.args.includes('-E'));
    assert.ok(x.args.includes('-X1'));
    assert.ok(!x.args.some((a) => a.includes(DB_PASSWORD)));
    assert.equal(x.stdin_password, DB_PASSWORD);
    assert.equal(x.env_password, null);
  }
  // 「Password:」の促しが標準出力に出ても、接続先の確認と行の数え方は崩れない
  assert.deepEqual(r.json.target, { server_name: 'PMS-TEST-01\\SQLEXPRESS', db_name: 'PMS', login: 'CORP\\e2e' });
  assert.equal(r.json.rows, 1);
  assert.match(r.json.output, /^Note\n----\n/);
});

test('db: 環境情報の不足・接続の失敗・接続先の違い・SELECT の失敗は終了コード 1 と reason。SELECT 以外の文は sqlcmd を呼ばずに 2', () => {
  let root = repo({ 'db.auth': { kind: 'other', value: 'sql' } });
  let r = pms(root, ['db', '--', 'SELECT 1']);
  assert.equal(r.code, 1);
  assert.equal(r.json.reason, 'env_missing');
  assert.match(r.json.error, /環境情報 db\.user・db\.password がない/);
  assert.match(r.json.error, /require --keys db\.user:account,db\.password:secret/);
  assert.equal(calls(root).length, 0);

  root = repo({}, { stub: { fail_connect: 'Login failed for user' } });
  r = pms(root, ['db', '--check']);
  assert.equal(r.code, 1);
  assert.equal(r.json.reason, 'connect_failed');
  assert.match(r.json.error, /DB に接続できない: Login failed for user/);

  root = repo({}, { stub: { target: 'PROD-01\tPMS_PROD\tsa' } });
  r = pms(root, ['db', '--', 'SELECT 1']);
  assert.equal(r.code, 1);
  assert.equal(r.json.reason, 'target_mismatch');
  assert.equal(calls(root).length, 1, '接続先が違えば SELECT を実行しない');

  root = repo({}, { stub: { fail_query: "Invalid object name 'PrintJobs'." } });
  r = pms(root, ['db', '--', 'SELECT * FROM PrintJobs']);
  assert.equal(r.code, 1);
  assert.equal(r.json.reason, 'query_failed');

  r = pms(root, ['db', '--', 'DELETE FROM PrintJob']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /DB操作の安全規約\(SELECT のみ\)により実行しない/);
  r = pms(root, ['db', 'SELECT 1']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /-- の後ろに書く/);
});

test('db --check: 接続先だけを確かめる(作業10の工程0)', () => {
  const root = repo();
  const r = pms(root, ['db', '--check']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.check, true);
  assert.equal(r.json.target.db_name, 'PMS');
  assert.equal(calls(root).length, 1);
});

test('db: カードを付ければ db-log に1行書き、now・next を返す。出ていないカード・--intent なしは 2', () => {
  const root = repo();
  assert.equal(pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'A']).code, 0);
  const n = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(n.code, 0, n.stdout);
  const card = n.json.card;
  let r = pms(root, ['db', '--flow', 'F-003', '--card', card, '--', 'SELECT 1']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /--intent/);
  r = pms(root, ['db', '--flow', 'F-003', '--card', card, '--intent', 'ジョブの状態', '--', 'SELECT Status FROM PrintJob']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.now.card, card);
  assert.match(r.json.next, new RegExp(`pms\\.mjs submit --flow F-003 --card ${card}`));
  const log = read(root, 'work/PRT/exploration/db-log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].card, card);
  assert.equal(log[0].intent, 'ジョブの状態');
  assert.equal(log[0].sql, 'SELECT Status FROM PrintJob');
  assert.equal(log[0].target.db_name, 'PMS');
  assert.equal(log[0].ok, true);
  assert.equal(log[0].rows, 2);
  r = pms(root, ['db', '--flow', 'F-003', '--card', 'C-0099', '--intent', 'x', '--', 'SELECT 1']);
  assert.equal(r.code, 2);
});

test('DB の接続の行: pms db の使い方・接続先・ログインの方式・証明書の扱いを書き、パスワードは書かない', () => {
  const vocab = { env_optional_keys: { 'db.trust_server_certificate': { default: 'true' }, 'db.auth': { default: 'windows' } } };
  let root = repo();
  let line = dbConnection(root, vocab, 'vm01', 'node tools/pms/pms.mjs db --flow F-003 --card C-0003');
  assert.match(line, /^`node tools\/pms\/pms\.mjs db --flow F-003 --card C-0003 --intent "<確かめること>" -- "<SELECT 文>"` で行う\(sqlcmd などを直接呼ばない。接続情報を調べない \[R-DB-2\]\)/);
  assert.match(line, /サーバ pms-test-01\\SQLEXPRESS \/ DB PMS \/ ログイン 実行するアカウントの Windows 認証\(環境情報 db\.auth: 未登録のため既定の windows\)/);
  assert.match(line, /サーバ証明書の検証を無効にして接続する\(人間が承認済み。環境情報 db\.trust_server_certificate: 未登録のため既定の true\)/);
  root = repo({ ...SQL_AUTH.attrs, 'db.trust_server_certificate': { kind: 'other', value: 'false' } }, { local: SQL_AUTH.local });
  line = dbConnection(root, vocab, 'vm01');
  assert.match(line, /ログイン SQL Server 認証\(e2e-reader\)\(環境情報 db\.auth: sql\)/);
  assert.match(line, /サーバ証明書を検証して接続する\(環境情報 db\.trust_server_certificate: false\)。証明書のエラーで接続できなければ cannot_proceed/);
  assert.ok(!line.includes(DB_PASSWORD));
  root = repo({ 'db.server': null, 'db.auth': { kind: 'other', value: 'kerberos' } });
  line = dbConnection(root, vocab, 'vm01');
  assert.match(line, /サーバ \(未登録\)/);
  assert.match(line, /値 "kerberos" は windows \/ sql でないため既定の windows/);
  assert.match(line, /環境情報 db\.server が未登録のため、いまは接続できない/);
});

test('env.mjs set: 任意キー db.password は --kind なしでも secret として各自の設定に保存する', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = repo();
  const env = path.join(PMS_DIR, '..', 'env', 'env.mjs');
  const r = spawnSync(process.execPath, [env, '--root', root, 'set', 'db.password', 'x-pass-1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).kind, 'secret');
  assert.equal(JSON.parse(read(root, 'config/environments.local.json')).environments.vm01.attributes['db.password'].value, 'x-pass-1');
});
