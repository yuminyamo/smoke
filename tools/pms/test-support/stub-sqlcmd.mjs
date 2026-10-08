#!/usr/bin/env node
// stub-sqlcmd.mjs — テスト用の sqlcmd の偽物(実物の SQL Server を使わない)
//
// 応答は環境変数 PMS_STUB_DIR の sqlcmd.json で決める:
//   { "target": "<@@SERVERNAME>\t<DB_NAME()>\t<SUSER_SNAME()>", "result": "<SELECT の出力>",
//     "fail_connect": "<接続の失敗の文言>" | null, "fail_query": "<SELECT の失敗の文言>" | null, "prompt": true | false }
// 実物の ODBC 版に合わせ、-X(-X1)があれば環境変数 SQLCMDPASSWORD を読まない。-U のときはパスワードを標準入力から読み、
// なければログインに失敗する。prompt が true なら、標準入力から読んだときに「Password:」の促しを標準出力に出す。
// 呼び出しは PMS_STUB_DIR/sqlcmd-calls.jsonl に1行ずつ残す(引数・標準入力から読んだパスワード・環境変数 SQLCMDPASSWORD の値)。

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.PMS_STUB_DIR;
const args = process.argv.slice(2);
const file = path.join(dir, 'sqlcmd.json');
const conf = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const stdin = fs.readFileSync(0, 'utf8');
const envPassword = args.some((a) => /^-X1?$/.test(a)) ? null : (process.env.SQLCMDPASSWORD ?? null);
const stdinPassword = stdin.split(/\r?\n/)[0] || null;
fs.appendFileSync(path.join(dir, 'sqlcmd-calls.jsonl'), JSON.stringify({ args, stdin_password: stdinPassword, env_password: process.env.SQLCMDPASSWORD ?? null }) + '\n');
const query = args[args.indexOf('-Q') + 1] ?? '';
if (args.includes('-U')) {
  const password = envPassword ?? stdinPassword;
  if (!password) {
    console.error(`Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login failed for user '${args[args.indexOf('-U') + 1]}'.`);
    process.exit(1);
  }
  if (!envPassword && conf.prompt) process.stdout.write('Password: ');
}

if (conf.fail_connect) {
  console.error(conf.fail_connect);
  process.exit(1);
}
if (query.includes('@@SERVERNAME')) {
  console.log(conf.target ?? 'PMS-TEST-01\\SQLEXPRESS\tPMS\tCORP\\e2e');
  process.exit(0);
}
if (conf.fail_query) {
  console.error(conf.fail_query);
  process.exit(1);
}
process.stdout.write(conf.result ?? 'JobId\tStatus\n-----\t------\n1\tDone\n2\tError\n');
