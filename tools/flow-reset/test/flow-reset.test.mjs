// flow-reset.test.mjs — tools/flow-reset/flow-reset.mjs のテスト(node --test tools/flow-reset/test/flow-reset.test.mjs)
// 一時ディレクトリに最小の作業場所(台帳と成果物)を作って実行する。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '..', 'flow-reset.mjs');

const LEDGER_HEAD = '# フロー台帳\n\n| フローID | 種別 | 方式 | 手順版 | 領域指示(要約) | 対象機能コード | 状態 | 開始日 | 完了日 | 備考 |\n|---|---|---|---|---|---|---|---|---|---|\n';
const row = (id, code, status = 'done', kind = 'new', memo = '') => `| ${id} | ${kind} | manual_usecase | proc-v001 | 要約 | ${code} | ${status} | 2026-10-01 | 2026-10-02 | ${memo} |\n`;

const HANDOFF = `# 申し送り台帳

## 台帳

| ID | 対象 | 理由コード | 引き継ぎ先 | 想定手段 | 発生元 | 起票日 | 状態 |
|---|---|---|---|---|---|---|---|
| HO-USR-001 | a | 異常系 | ステップ2 |  | F-001 / 作業10 / SC-USR-01 | 2026-10-01 | open |
| HO-USR-002 | b | 初期状態外 | 連結シナリオ | SD-001 | F-001 / 作業10 / SC-USR-01 | 2026-10-01 | open |
| HO-PRT-001 | c | 異常系 | ステップ2 |  | F-002 / 作業10 / SC-PRT-01 | 2026-10-01 | open |

## 記入例

| ID | 対象 | 理由コード | 引き継ぎ先 | 想定手段 | 発生元 | 起票日 | 状態 |
|---|---|---|---|---|---|---|---|
| HO-USR-009 | 例 | 異常系 | ステップ2 |  | F-001 / 作業10 / SC-USR-01 | 2026-08-29 | open |
`;

const demand = (rows) => `# 需要リスト

## 台帳

| 需要ID | 内容 | 要求元 | 状態 |
|---|---|---|---|
${rows.join('\n')}

## 記入例

| 需要ID | 内容 | 要求元 | 状態 |
|---|---|---|---|
| SD-001 | 例 | HO-USR-001 | 提案 |
`;

function repo(ledgerRows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-reset-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('work/_flows/00_フロー台帳.md', LEDGER_HEAD + ledgerRows.join(''));
  w('work/_flows/F-001/flow.md', 'flow');
  w('work/USR/scenarios.md', 'scenarios');
  w('work/_common/handoff-register.md', HANDOFF);
  w('work/_common/state-demand.md', demand(['| SD-001 | ロックアウト | HO-USR-002 | 提案 |', '| SD-002 | 混在 | HO-USR-001, HO-PRT-001 | 提案 |']));
  w('work/_common/external-op-demand.md', demand(['| EXT-001 | 印刷 | 作業02:ジョブ実行 | 未整備 |']));
  w('work/_common/nondeterministic-catalog.md', 'nd');
  w('tests/specs/usr/a.spec.ts', 'spec');
  w('tests/fixtures/auth.ts', 'fixture');
  w('traceability/USR-matrix.md', 'matrix');
  w('playwright.config.ts', 'config');
  w('kb/gotchas/GOT-0001.md', '`tests/fixtures/auth.ts` を見る');
  return root;
}

function run(root, ...a) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...a], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const has = (root, rel) => fs.existsSync(path.join(root, rel));
const text = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const archiveDir = (root) => path.join('work/.archive', fs.readdirSync(path.join(root, 'work/.archive'))[0]).split(path.sep).join('/');

test('--apply なしでは何も変えずに計画だけを表示する', () => {
  const root = repo([row('F-001', 'USR')]);
  const r = run(root, '--flow', 'F-001');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /確認だけです/);
  assert.match(r.out, /申し送り台帳: HO-USR-001, HO-USR-002/);
  assert.match(r.out, /kb\/gotchas\/GOT-0001\.md: tests\/fixtures\/auth\.ts/);
  assert.ok(has(root, 'work/USR/scenarios.md'));
  assert.ok(!has(root, 'work/.archive'));
});

test('全フローを退避するときは共有のテスト資産ごと退避し、台帳の行を外す', () => {
  const root = repo([row('F-001', 'USR')]);
  const r = run(root, '--flow', 'F-001', '--apply');
  assert.equal(r.code, 0, r.err);
  const a = archiveDir(root);
  for (const rel of ['work/_flows/F-001/flow.md', 'work/USR/scenarios.md', 'tests/specs/usr/a.spec.ts', 'tests/fixtures/auth.ts', 'traceability/USR-matrix.md', 'playwright.config.ts']) {
    assert.ok(!has(root, rel), `${rel} が残っている`);
    assert.ok(has(root, `${a}/${rel}`), `${rel} が退避されていない`);
  }
  assert.ok(has(root, `${a}/_ledgers-before/handoff-register.md`));
  assert.ok(has(root, 'work/_common/nondeterministic-catalog.md'));
  const ho = text(root, 'work/_common/handoff-register.md');
  assert.doesNotMatch(ho, /HO-USR-001 \| a/);
  assert.match(ho, /HO-PRT-001/);
  assert.match(ho, /HO-USR-009 \| 例/, '記入例の行は残す');
  const sd = text(root, 'work/_common/state-demand.md');
  assert.doesNotMatch(sd, /SD-001 \| ロックアウト/);
  assert.match(sd, /SD-002 \| 混在/, '要求元の一部だけが外れた行は残す');
  assert.match(r.out, /手で直す行[\s\S]*SD-002/);
  assert.match(text(root, 'work/_common/external-op-demand.md'), /EXT-001/);
  assert.match(text(root, 'work/_flows/00_フロー台帳.md'), /\| F-001 .*\| done \|.*成果物は再実行のため work\/\.archive\/.+ に退避した/);
});

test('他の機能のフローが残るときは共有のテスト資産を残す', () => {
  const root = repo([row('F-001', 'USR'), row('F-002', 'PRT')]);
  fs.mkdirSync(path.join(root, 'work/PRT'));
  const r = run(root, '--flow', 'F-001', '--apply');
  assert.equal(r.code, 0, r.err);
  assert.ok(!has(root, 'tests/specs/usr'));
  assert.ok(has(root, 'tests/fixtures/auth.ts'));
  assert.ok(has(root, 'playwright.config.ts'));
});

test('退避済み・作業中・同じ機能の他のフローが残る場合は止める(終了コード2)', () => {
  const root = repo([row('F-001', 'USR'), row('F-002', 'USR', 'done', 'reexplore'), row('F-003', 'PRT', 'in-progress(10)')]);
  let r = run(root, '--flow', 'F-001');
  assert.equal(r.code, 2);
  assert.match(r.err, /F-002/);
  r = run(root, '--flow', 'F-003');
  assert.equal(r.code, 2);
  assert.match(r.err, /作業中/);
  const done = repo([row('F-001', 'USR', 'done', 'new', '成果物は再実行のため work/.archive/x/ に退避した')]);
  r = run(done, '--flow', 'F-001');
  assert.equal(r.code, 2);
  assert.match(r.err, /退避済み/);
});
