#!/usr/bin/env node
// stub-sqlcmd.mjs — テスト用の sqlcmd の偽物(実物の SQL Server を使わない)
//
// 応答は環境変数 PMS_STUB_DIR の sqlcmd.json で決める:
//   { "target": "<@@SERVERNAME>\t<DB_NAME()>\t<SUSER_SNAME()>", "result": "<SELECT の出力>",
//     "fail_connect": "<接続の失敗の文言>" | null, "fail_query": "<SELECT の失敗の文言>" | null }
// 呼び出しは PMS_STUB_DIR/sqlcmd-calls.jsonl に1行ずつ残す(引数と、環境変数 SQLCMDPASSWORD の値)。

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.PMS_STUB_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'sqlcmd-calls.jsonl'), JSON.stringify({ args, password: process.env.SQLCMDPASSWORD ?? null }) + '\n');
const file = path.join(dir, 'sqlcmd.json');
const conf = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const query = args[args.indexOf('-Q') + 1] ?? '';

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
