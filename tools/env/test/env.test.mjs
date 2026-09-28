// env.test.mjs — tools/env/env.mjs のテスト(node --test tools/env/test/env.test.mjs)
// 一時ディレクトリに vocab.yaml(実物)と設定ファイルを置き、CLI を実行して結果を確かめる。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '..', 'env.mjs');
const REAL_ROOT = path.resolve(here, '..', '..', '..');

function repo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-env-'));
  fs.mkdirSync(path.join(root, 'procedure'));
  fs.copyFileSync(path.join(REAL_ROOT, 'procedure', 'vocab.yaml'), path.join(root, 'procedure', 'vocab.yaml'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

function run(root, args, { input, env = {} } = {}) {
  const e = { ...process.env, ...env };
  if (!('PMS_ENV' in env)) delete e.PMS_ENV;
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', input, env: e });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* get は値だけ・終了コード2は JSON なし */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const FULL = {
  default: 'vm01',
  environments: {
    vm01: {
      description: '検証環境1',
      attributes: {
        'pms.url': { kind: 'endpoint', value: 'https://pms-test-01.example.local/pms' },
        'pms.user': { kind: 'account', value: 'e2e-user01' },
        'db.server': { kind: 'endpoint', value: 'pms-test-01\\SQLEXPRESS' },
        'db.name': 'PMS',
        'mfp.a.host': { kind: 'endpoint', value: '192.0.2.10' },
      },
    },
    vm02: { attributes: { 'pms.url': { kind: 'endpoint', value: 'https://pms-test-02.example.local/pms' } } },
  },
};
const LOCAL = { environments: { vm01: { attributes: { 'pms.password': { kind: 'secret', value: 'P@ssw0rd!42' } } } } };

test('設定がないとき require は環境が決まらないことと基本キーの全件を返す(終了コード 1)', () => {
  const r = run(repo(), ['require']);
  assert.equal(r.code, 1);
  assert.equal(r.json.state, 'missing');
  assert.equal(r.json.reason, 'no_environment');
  assert.deepEqual(r.json.missing.map((m) => m.key), ['pms.url', 'pms.user', 'pms.password', 'db.server', 'db.name']);
  assert.equal(r.json.missing.find((m) => m.key === 'pms.password').kind, 'secret');
});

test('set で保存した値は次の require で揃い、秘密情報は各自の設定に入る', () => {
  const root = repo();
  assert.equal(run(root, ['set', 'pms.url', 'https://x.example.local/pms', '--env', 'vm01']).code, 0);
  const pw = run(root, ['set', 'pms.password', '-', '--env', 'vm01'], { input: 'S3cret-Value\n' });
  assert.equal(pw.code, 0, pw.stderr);
  assert.equal(pw.json.file, 'config/environments.local.json');
  assert.ok(!pw.stdout.includes('S3cret-Value'), '値を出力しない');
  for (const [k, v] of [['pms.user', 'u1'], ['db.server', 'db1'], ['db.name', 'PMS']]) assert.equal(run(root, ['set', k, v]).code, 0);
  const shared = readJson(root, 'config/environments.json');
  assert.equal(shared.environments.vm01.attributes['pms.url'].value, 'https://x.example.local/pms');
  assert.equal(shared.environments.vm01.attributes['pms.password'], undefined);
  assert.equal(readJson(root, 'config/environments.local.json').environments.vm01.attributes['pms.password'].value, 'S3cret-Value');
  const r = run(root, ['require']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.state, 'complete');
  assert.equal(r.json.env, 'vm01');
});

test('新しいキーは --kind が必要。キー・環境IDの書式の誤りは終了コード 2', () => {
  const root = repo({ 'config/environments.json': FULL });
  assert.equal(run(root, ['set', 'mfp.b.host', '192.0.2.11']).code, 2);
  assert.equal(run(root, ['set', 'mfp.b.host', '192.0.2.11', '--kind', 'endpoint']).code, 0);
  assert.equal(run(root, ['set', 'MFP.B', 'x', '--kind', 'other']).code, 2);
  assert.equal(run(root, ['set', 'a.b', 'x', '--kind', 'other', '--env', 'vm 01']).code, 2);
  assert.equal(run(root, ['set', 'a.b', 'x', '--kind', 'password']).code, 2);
});

test('各自の設定が共有の設定を上書きし、環境の選び方は --env → PMS_ENV → local の default → 共有の default', () => {
  const root = repo({
    'config/environments.json': FULL,
    'config/environments.local.json': { ...LOCAL, environments: { ...LOCAL.environments, vm02: { attributes: { 'pms.url': { value: 'https://mine.example.local/pms' } } } } },
  });
  assert.equal(run(root, ['get', 'pms.url']).stdout.trim(), 'https://pms-test-01.example.local/pms');
  assert.equal(run(root, ['get', 'pms.url', '--env', 'vm02']).stdout.trim(), 'https://mine.example.local/pms');
  assert.equal(run(root, ['get', 'pms.url'], { env: { PMS_ENV: 'vm02' } }).stdout.trim(), 'https://mine.example.local/pms');
  assert.equal(run(root, ['use', 'vm02']).code, 0);
  assert.equal(run(root, ['envs']).json.selected, 'vm02');
  assert.equal(readJson(root, 'config/environments.local.json').default, 'vm02');
  assert.equal(run(root, ['use', 'nothing']).code, 2);
});

test('get: 秘密情報は --reveal のときだけ出す。値がなければ終了コード 1', () => {
  const root = repo({ 'config/environments.json': FULL, 'config/environments.local.json': LOCAL });
  assert.equal(run(root, ['get', 'pms.password']).code, 2);
  const r = run(root, ['get', 'pms.password', '--reveal']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'P@ssw0rd!42\n');
  assert.equal(run(root, ['get', 'mfp.z.host']).code, 1);
  const list = run(root, ['list']);
  assert.equal(list.code, 0);
  assert.equal(list.json.attributes.find((a) => a.key === 'pms.password').value, '****');
  assert.ok(!list.stdout.includes('P@ssw0rd!42'));
});

test('require --keys: 追加のキーの不足を種類付きで返す', () => {
  const root = repo({ 'config/environments.json': FULL, 'config/environments.local.json': LOCAL });
  const r = run(root, ['require', '--keys', 'mfp.a.host:endpoint,mfp.a.admin.password:secret']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.missing.map((m) => [m.key, m.kind]), [['mfp.a.admin.password', 'secret']]);
  assert.equal(run(root, ['require', '--no-base', '--keys', 'mfp.a.host']).code, 0);
  assert.equal(run(root, ['require', '--keys', 'Bad Key']).code, 2);
});

test('設定ファイルの形の誤りは check と各コマンドで終了コード 2', () => {
  const bad = repo({ 'config/environments.json': { environments: { vm01: { attributes: { 'pms.url': { kind: 'url', value: 'x' }, 'x.y': { valu: 1 } } } }, extra: 1 } });
  const c = run(bad, ['check']);
  assert.equal(c.code, 2);
  assert.equal(c.json.ok, false);
  assert.ok(c.json.errors.length >= 3, c.json.errors.join('\n'));
  assert.equal(run(bad, ['require']).code, 2);
  assert.equal(run(repo({ 'config/environments.json': '{ broken' }), ['check']).code, 2);
  assert.equal(run(repo({ 'config/environments.json': FULL }), ['check']).code, 0);
});
