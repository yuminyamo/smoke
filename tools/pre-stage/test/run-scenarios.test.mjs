// run-scenarios.test.mjs — tools/pre-stage/run-scenarios.mjs のテスト(node --test tools/pre-stage/test/)
// Playwright の代わりに、--grep の値に応じて JSON レポートを書く差し替えのコマンドを使う。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '..', 'run-scenarios.mjs');

// 差し替えの Playwright: SC-*-9x は失敗、SC-*-8x はテストなし、それ以外は成功。呼ばれた順を calls.txt に残す
const STUB = `import fs from 'node:fs';
const i = process.argv.indexOf('--grep');
const re = process.argv[i + 1];
const id = re.replace(/^@/, '').replace(/\\\\b$/, '');
fs.appendFileSync('calls.txt', id + (process.env.PMS_RESTORE ? ' PMS_RESTORE' : '') + '\\n');
const n = Number(id.split('-').pop());
const specs = n >= 80 && n < 90 ? [] : [{ title: 'テスト', tags: ['@' + id], ok: n < 90, tests: [{ status: n >= 90 ? 'unexpected' : 'expected' }] }];
const other = [{ title: 'server ready', tags: [], ok: true, tests: [{ status: 'expected' }] }];
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ specs: other, suites: [{ specs }] }] }));
process.exit(n >= 90 ? 1 : 0);
`;

function repo(hooks, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-pre-'));
  fs.writeFileSync(path.join(root, 'stub.mjs'), STUB);
  if (hooks !== undefined) {
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/pre-stage-scenarios.json'), JSON.stringify({ command: [process.execPath, 'stub.mjs'], hooks, ...extra }));
  }
  return root;
}

function run(root, ...a) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...a], { encoding: 'utf8', env: { ...process.env, PMS_RESTORE: '1' } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 終了コード2 */ }
  const calls = fs.existsSync(path.join(root, 'calls.txt')) ? fs.readFileSync(path.join(root, 'calls.txt'), 'utf8').trim().split('\n') : [];
  return { code: r.status, json, calls, stderr: r.stderr };
}

test('設定ファイルがない・hook がない・空のときは何もしない(skipped・終了コード 0・記録しない)', () => {
  for (const root of [repo(undefined), repo({ work20: [] }), repo({ work10: [] })]) {
    const r = run(root, '--hook', 'work10');
    assert.equal(r.code, 0);
    assert.equal(r.json.state, 'skipped');
    assert.deepEqual(r.calls, []);
    assert.equal(fs.existsSync(path.join(root, 'work/_common/pre-stage-log.jsonl')), false);
  }
});

test('複数のエントリ・複数のシナリオを書いた順に実行し、PMS_RESTORE を外す', () => {
  const root = repo({ work10: [
    { name: '機器のゴールデンイメージ復元', scenarios: ['SC-DEV-05', 'SC-DEV-06'] },
    { name: 'テスト用ユーザーの準備', scenarios: ['SC-USR-01'] },
  ] });
  const r = run(root, '--hook', 'work10', '--flow', 'F-003');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.state, 'passed');
  assert.deepEqual(r.calls, ['SC-DEV-05', 'SC-DEV-06', 'SC-USR-01']);
  assert.equal(r.json.flow_id, 'F-003');
  assert.match(r.json.run_id, /^PRE-\d{8}-\d{6}-[0-9a-f]{4}$/);
  const log = fs.readFileSync(path.join(root, 'work/_common/pre-stage-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(log[0]).run_id, r.json.run_id);
});

test('失敗(stop)で止まり終了コード 1。テストが見つからないのも失敗', () => {
  const root = repo({ work20: [{ name: 'a', scenarios: ['SC-DEV-05', 'SC-DEV-91', 'SC-DEV-06'] }, { name: 'b', scenarios: ['SC-USR-01'] }] });
  const r = run(root, '--hook', 'work20');
  assert.equal(r.code, 1);
  assert.equal(r.json.state, 'failed');
  assert.deepEqual(r.calls, ['SC-DEV-05', 'SC-DEV-91']);
  const nf = run(repo({ work10: [{ name: 'a', scenarios: ['SC-DEV-81'] }] }), '--hook', 'work10');
  assert.equal(nf.code, 1);
  assert.equal(nf.json.results[0].result, 'not_found');
});

test('on_failure: continue のエントリの失敗は warning(終了コード 0)で、次のエントリへ進む', () => {
  const root = repo({ work10: [{ name: 'a', scenarios: ['SC-DEV-91', 'SC-DEV-05'], on_failure: 'continue' }, { name: 'b', scenarios: ['SC-USR-01'] }] });
  const r = run(root, '--hook', 'work10');
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'warning');
  assert.deepEqual(r.calls, ['SC-DEV-91', 'SC-USR-01']);
});

test('任意の名前の hook も使える。設定の誤りは終了コード 2', () => {
  const r = run(repo({ nightly: [{ name: 'x', scenarios: ['SC-PRT-01'] }] }), '--hook', 'nightly');
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'passed');
  assert.equal(run(repo({ work10: [{ name: 'x', scenarios: ['DEV-05'] }] }), '--hook', 'work10').code, 2);
  assert.equal(run(repo({ work10: [{ scenarios: ['SC-DEV-05'] }] }), '--hook', 'work10').code, 2);
  assert.equal(run(repo({ work10: [{ name: 'x', scenarios: ['SC-DEV-05'], on_failure: 'ignore' }] }), '--hook', 'work10').code, 2);
  assert.equal(run(repo(undefined)).code, 2); // --hook なし
});

test('復元範囲(--restore-scope): VM に加え、work10 と work20 の両方の復元エントリの対象だけを数える', () => {
  const root = repo({
    work10: [{ name: '機器の復元', scenarios: ['SC-DEV-05'], restores: ['実機:MFP-A の設定', 'AD:テスト用OU'] }, { name: '準備', scenarios: ['SC-USR-01'] }],
    work20: [{ name: '機器の復元', scenarios: ['SC-DEV-05'], restores: ['実機:MFP-A の設定'] }],
  });
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--restore-scope'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.vm.length, 1);
  assert.deepEqual(s.scenarios.map((x) => x.target), ['実機:MFP-A の設定']);
  assert.deepEqual(s.partial, [{ target: 'AD:テスト用OU', only_in: 'work10' }]);
  // 設定がなければ VM だけ
  const none = JSON.parse(spawnSync(process.execPath, [SCRIPT, '--root', repo(undefined), '--restore-scope'], { encoding: 'utf8' }).stdout);
  assert.deepEqual(none.scenarios, []);
});

test('復元エントリは on_failure: stop でなければならない・restores の形', () => {
  assert.equal(run(repo({ work10: [{ name: 'x', scenarios: ['SC-DEV-05'], restores: ['実機:A'], on_failure: 'continue' }] }), '--hook', 'work10').code, 2);
  assert.equal(run(repo({ work10: [{ name: 'x', scenarios: ['SC-DEV-05'], restores: [] }] }), '--hook', 'work10').code, 2);
  const ok = run(repo({ work10: [{ name: 'x', scenarios: ['SC-DEV-05'], restores: ['実機:A'] }] }), '--hook', 'work10');
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.json.results[0].restores, ['実機:A']);
});
