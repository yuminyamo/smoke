// pms.test.mjs — tools/pms/pms.mjs のテスト(node --test tools/pms/test/)
//
// 一時ディレクトリに小さなリポジトリ(正本は実物の procedure/ を写す)を作り、CLI を実行して結果を確かめる。
// playwright-cli は偽物(test-support/stub-playwright-cli.mjs)、環境情報は偽物の設定ファイルに差し替える。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  makeRepo, write, read, exists, pms, stubCalls, actLog, queue, submitOut, loginActs,
  SECRET, ADMIN_USER, SCENARIOS, REAL_ROOT,
} from '../test-support/helpers.mjs';
import { parseYamlDocs } from '../../lint/lib/yaml-lite.mjs';

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const ONLY_LOGIN = SCENARIOS.replace('S-ADMIN-LOGIN, S-DEVICE-REGISTERED', 'S-ADMIN-LOGIN').replace('S-ADMIN-LOGIN, S-JOBLOG-EXISTS', 'S-ADMIN-LOGIN');
const BUILT = { result: 'built', seqs: [1, 2, 3, 5], established_check_seq: 6, fragile: [], blocked: null, notes: null };

function setup(files = {}, opts = {}) {
  const root = makeRepo(files, opts);
  const b = pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'A']);
  assert.equal(b.code, 0, b.stdout + b.stderr);
  return root;
}

function setupLog(root, feature = 'PRT') {
  const docs = parseYamlDocs(read(root, `work/${feature}/exploration/setup-log.yaml`));
  return docs.flatMap((d) => (d.setups ?? []).map((e) => ({ ...e, _flow: d.flow_id })));
}

function lint(root, rules) {
  const r = spawnSync(process.execPath, [path.join(REAL_ROOT, 'tools/lint/lint.mjs'), '--root', root, '--json', '--flow', 'F-003', '--stage', '10', '--rule', rules], { encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout || 'null'), stderr: r.stderr };
}

function codeFiles(root) {
  write(root, 'tests/pages/LoginPage.ts', "export class LoginPage { constructor(page) { this.user = page.getByLabel('ユーザーID'); this.pass = page.getByLabel(\"パスワード\"); this.submit = page.getByRole('button', { name: 'ログイン' }); } }\n");
  write(root, 'tests/flows/auth.ts', "import { LoginPage } from '../pages/LoginPage';\nexport async function loginAsAdmin(page) { const p = new LoginPage(page); }\n");
  write(root, 'tests/fixtures/auth.ts', "import { loginAsAdmin } from '../flows/auth';\nexport const adminLogin = async ({ page }) => { await loginAsAdmin(page); await expect(page.getByRole('link', { name: 'ログアウト' })).toBeVisible(); };\n");
  write(root, 'tests/readiness/server-ready.setup.ts', '// readiness\n');
}

const run = (code, at = '2026-10-07T10:05:00+09:00') => ({ command: 'npx playwright test tests/readiness/server-ready.setup.ts', exit_code: code, started_at: at, ended_at: '2026-10-07T10:06:00+09:00' });
const CODED = { result: 'coded', flow: 'flows/auth.ts#loginAsAdmin', fixture: 'fixtures/auth.ts#adminLogin', runs: [run(0), run(0)], cleanup: 'なし(ゴールデンイメージ復元で初期化)', notes: null };

// ════════════════════════════════════════════════════════
// pms act
// ════════════════════════════════════════════════════════

test('act: 1操作1行の記録(連番・時刻・ロケータの区分・now/next)。ロケータは操作の前に取り、セッション名はフローID', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN });
  pms(root, ['next', '--flow', 'F-003']);
  const res = loginActs(root, 'C-0001');
  for (const r of res) assert.equal(r.code, 0, r.stdout + r.stderr);
  const log = actLog(root);
  assert.deepEqual(log.map((x) => x.seq), [1, 2, 3, 4, 5, 6]);
  for (const x of log) {
    for (const k of ['seq', 'card', 'action', 'ref', 'locator', 'locator_class', 'unique', 'value', 'intent', 'code', 'url_before', 'url_after', 'started_at', 'ended_at', 'ok', 'error']) assert.ok(k in x, `${k} がない: ${JSON.stringify(x)}`);
    assert.match(x.started_at, TS);
    assert.match(x.ended_at, TS);
    assert.equal(x.flow, 'F-003');
    assert.equal(x.card, 'C-0001');
  }
  const fill = log[1];
  assert.equal(fill.locator, "getByLabel('ユーザーID')");
  assert.equal(fill.locator_class, 'stable');
  assert.equal(fill.unique, true);
  assert.equal(fill.value, '<env:pms.admin.user>');
  assert.equal(fill.intent, '管理者IDを入力');
  assert.equal(log[4].url_after, 'https://pms.test/menu');
  assert.equal(log[4].url_before, log[3].url_after);
  // 出力に now と next
  const j = res[1].json;
  assert.deepEqual(Object.keys(j.now).sort(), ['card', 'flow', 'kind', 'state_id', 'target', 'todo']);
  assert.match(j.next, /pms\.mjs act --flow F-003 --card C-0001 snapshot/);
  assert.match(res[5].json.next, /pms\.mjs submit --flow F-003 --card C-0001 --file work\/_flows\/F-003\/out\/C-0001\.json/);
  // snapshot は画面の内容のあとに now/next
  assert.match(res[3].stdout, /### Snapshot[\s\S]*--- pms ---/);
  assert.ok(res[3].json.now && res[3].json.next);
  // playwright-cli の呼び出し: -s=F-003、open に --idle-timeout=0、generate-locator が操作より先
  const calls = stubCalls(root);
  assert.ok(calls.every((c) => c[0] === '-s=F-003'), JSON.stringify(calls));
  const open = calls.find((c) => c[1] === 'open');
  assert.ok(open.includes('--idle-timeout=0'));
  const gi = calls.findIndex((c) => c[1] === 'generate-locator' && c[2] === 'e7');
  const ci = calls.findIndex((c) => c[1] === 'click' && c[2] === 'e7');
  assert.ok(gi >= 0 && gi < ci, '操作の前に generate-locator を呼ぶ');
});

test('act: <env:キー> の値(秘密情報・アカウント)は、標準出力・記録・snapshot のどこにも出ない', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN });
  pms(root, ['next', '--flow', 'F-003']);
  const res = loginActs(root, 'C-0001');
  const all = res.map((r) => r.stdout + r.stderr).join('\n') + read(root, 'work/PRT/exploration/act-log.jsonl');
  assert.ok(!all.includes(SECRET), '秘密情報の値が出ている');
  assert.ok(!all.includes(ADMIN_USER), 'アカウントの値が出ている');
  assert.match(actLog(root)[2].code, /fill\('<env:pms\.admin\.password>'\)/);
  // playwright-cli には本物の値を渡している
  assert.ok(stubCalls(root).some((c) => c[1] === 'fill' && c[3] === SECRET));
  // snapshot の中に入力済みの値が出ても伏せる
  const snap = pms(root, ['act', '--flow', 'F-003', '--card', 'C-0001', 'snapshot']);
  assert.ok(!snap.stdout.includes(SECRET));
  assert.match(snap.stdout, /<env:pms\.admin\.password>/);
});

test('act: CSS のロケータは css・一意でないロケータは unique: false で、警告を返す。操作の失敗も記録する', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN });
  pms(root, ['next', '--flow', 'F-003']);
  const a = (args) => pms(root, ['act', '--flow', 'F-003', '--card', 'C-0001', ...args]);
  const css = a(['--intent', 'メニューを開く', 'click', 'e9']);
  assert.equal(css.code, 0);
  assert.equal(css.json.locator_class, 'css');
  assert.ok(css.json.warnings.some((w) => /安定でない/.test(w) && /ロケータ規約の6/.test(w)));
  const dup = a(['--intent', '詳細を開く', 'click', 'e10']);
  assert.equal(dup.json.unique, false);
  assert.ok(dup.json.warnings.some((w) => /一意でない/.test(w)));
  write(root, '.stub/page.json', JSON.stringify({ ...JSON.parse(read(root, '.stub/page.json')), fail: ['e7'] }));
  const failed = a(['--intent', 'ログインする', 'click', 'e7']);
  assert.equal(failed.code, 1);
  assert.equal(failed.json.ok, false);
  const nf = a(['--intent', 'ないもの', 'click', 'e404']);
  assert.equal(nf.code, 1);
  assert.match(nf.json.error, /generate-locator e404/);
  const ast = a(['--intent', '見えない', 'assert', 'e20', 'visible']);
  assert.equal(ast.code, 1);
  const log = actLog(root);
  assert.deepEqual(log.map((x) => [x.seq, x.ok]), [[1, true], [2, true], [3, false], [4, false], [5, false]]);
  assert.match(log[2].error, /失敗/);
});

test('act: 使い方の誤り(出ていないカード・setup.build 以外のカード・vocab にない操作・--intent なし)は終了コード 2', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN });
  const notIssued = pms(root, ['act', '--flow', 'F-003', '--card', 'C-0001', 'snapshot']);
  assert.equal(notIssued.code, 2);
  assert.match(notIssued.json.error, /出ていないカード/);
  pms(root, ['next', '--flow', 'F-003']);
  assert.equal(pms(root, ['act', '--flow', 'F-003', '--card', 'C-0001', 'teleport', 'e3']).code, 2);
  assert.equal(pms(root, ['act', '--flow', 'F-003', '--card', 'C-0001', 'click', 'e7']).code, 2);
  assert.equal(actLog(root).length, 0);
});

test('act ext: 外部操作の実行体を呼び、操作ID・終了コード・出力を記録する(値は伏せる)', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN });
  pms(root, ['next', '--flow', 'F-003']);
  write(root, 'tools/ext/print.mjs', "console.log(JSON.stringify({ ok: true, arg: process.argv[2] }));\n");
  const r = pms(root, ['act', '--flow', 'F-003', '--card', 'C-0001', '--intent', '印刷指示', 'ext', '--op', 'OP-CLI-001', '--', process.execPath, path.join(root, 'tools/ext/print.mjs'), '<env:pms.admin.password>']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const x = actLog(root)[0];
  assert.equal(x.action, 'ext');
  assert.equal(x.operation_id, 'OP-CLI-001');
  assert.equal(x.exit_code, 0);
  assert.equal(x.output.arg, '<env:pms.admin.password>');
  assert.ok(!read(root, 'work/PRT/exploration/act-log.jsonl').includes(SECRET));
});

// ════════════════════════════════════════════════════════
// queue build / ledgers
// ════════════════════════════════════════════════════════

const PAST_SETUP = `feature_code: PRT
flow_id: F-001
setups:
  - state_id: S-ADMIN-LOGIN
    classification: built-by-ui
    flow: flows/auth.ts#loginAsAdmin
    fixture: fixtures/auth.ts#adminLogin
    steps:
      - action: goto
        detail: <env:pms.url>
      - action: click
        locator: getByRole('button', { name: 'ログイン' })
    established_check: ログアウトのリンクが表示される
    verified: true
    cleanup: なし
  - state_id: S-DEVICE-REGISTERED
    classification: built-by-ui
    fixture: fixtures/device.ts#deviceRegistered
    established_check: デバイス一覧にテスト用デバイスがある
    verified: true
`;

test('queue build: 対象シナリオ(このフローで作ったもの)の requires を、setup.build・setup.reuse・pms の記録に振り分ける', () => {
  const root = makeRepo({
    'work/PRT/scenarios.md': SCENARIOS.replace('S-ADMIN-LOGIN, S-JOBLOG-EXISTS', 'S-ADMIN-LOGIN, S-JOBLOG-EXISTS, S-CLEAN-ENV'),
    'work/PRT/exploration/setup-log.yaml': PAST_SETUP,
    'tests/fixtures/auth.ts': 'export const adminLogin = 1;\n',
    'tests/fixtures/device.ts': 'export const deviceRegistered = 1;\n',
  });
  const r = pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'A']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const q = queue(root);
  const kinds = Object.fromEntries(q.cards.map((c) => [c.state_id, c.kind]));
  // F-001 のシナリオ(SC-PRT-09 の S-USER-LOGIN)は対象外
  assert.deepEqual(kinds, { 'S-ADMIN-LOGIN': 'setup.reuse', 'S-DEVICE-REGISTERED': 'setup.build' });
  assert.equal(q.cards.find((c) => c.state_id === 'S-ADMIN-LOGIN').reuse.flow_id, 'F-001');
  // 流用元に steps がない S-DEVICE-REGISTERED は、記録を取り直す setup.build(作り直し)
  assert.equal(q.cards.find((c) => c.state_id === 'S-DEVICE-REGISTERED').rebuild.reason, 'old_record');
  // 初期状態セット外と S-CLEAN-ENV は pms が記録する
  const log = setupLog(root).filter((e) => e._flow === 'F-003');
  const ext = log.find((e) => e.state_id === 'S-JOBLOG-EXISTS');
  assert.equal(ext.classification, 'blocked');
  assert.equal(ext.blocked_by.reason, '初期状態外');
  assert.match(ext.blocked_by.handoff, /^HO-PRT-001$/);
  assert.equal(log.find((e) => e.state_id === 'S-CLEAN-ENV').classification, 'provided');
  assert.ok(q.warnings.some((w) => /S-JOBLOG-EXISTS/.test(w)));
  // 過去のフローの文書は変えない
  assert.ok(read(root, 'work/PRT/exploration/setup-log.yaml').startsWith(PAST_SETUP.trimEnd()));
  // 申し送り台帳はテンプレートから作り、表の形どおりに1行足す(テンプレートの空の行は外す)
  const ho = read(root, 'work/_common/handoff-register.md');
  assert.match(ho, /\| HO-PRT-001 \| 前提状態 S-JOBLOG-EXISTS が初期状態セットにない\(要求元 SC-PRT-02\) \| 初期状態外 \| 連結シナリオ \|  \| F-003 \/ 作業10 \/ SC-PRT-02 \| 2026-10-07 \| open \|/);
  assert.ok(!/\| HO-XXX-001 \|/.test(ho.split('## 記入例')[0]));
  // 作り直さない
  assert.equal(pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'A']).code, 2);
});

test('queue build: 状態需要リストで 採用 の状態は初期状態セットに含める。--scenarios で前のフローのシナリオを対象にできる', () => {
  const sd = fs.readFileSync(path.join(REAL_ROOT, 'procedure/templates/96_状態需要リスト_記入用.md'), 'utf8')
    .replace('| SD-001 |  |  |  | 提案 |  |  |  |  |  |  |  |', '| SD-001 | S-JOBLOG-EXISTS | ジョブログが1件以上ある | DATA | 採用 | HO-PRT-009 | 印刷して収集 | 一覧に自データの行 | 2026-10-06 |  | 2026-10-01 |  |');
  const root = makeRepo({ 'work/_common/state-demand.md': sd });
  pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'A']);
  assert.ok(queue(root).cards.some((c) => c.state_id === 'S-JOBLOG-EXISTS' && c.kind === 'setup.build'));
  const body = pms(root, ['next', '--flow', 'F-003']).json.body;
  assert.match(body, /S-ADMIN-LOGIN/);
  const root2 = makeRepo();
  const r = pms(root2, ['queue', 'build', '--flow', 'F-004', '--phase', 'A', '--scenarios', 'SC-PRT-09']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(queue(root2, 'F-004').cards.map((c) => c.state_id), ['S-USER-LOGIN']);
  assert.equal(pms(root2, ['queue', 'build', '--flow', 'F-005', '--phase', 'A', '--scenarios', 'SC-NONE-01']).code, 2);
});

test('submit(blocked): 申し送り台帳と外部操作需要リストに行を足す。同じ外部操作と操作対象なら要求元の追記にする', () => {
  const root = setup();
  pms(root, ['next', '--flow', 'F-003']); // C-0001 S-ADMIN-LOGIN
  const blocked = (detail) => ({
    result: 'blocked', seqs: [], established_check_seq: null, fragile: [], notes: null,
    blocked: { reason: '操作手段なし', detail, ref: null, ext_demand: { operation: '機器パネルでペアリングを承認', target: 'シミュレータ', gap: 'skillなし', alternative: '不明', prohibition: '該当なし' } },
  });
  const r1 = submitOut(root, 'C-0001', blocked('管理者の登録には機器パネルでのペアリング操作が要り、使える skill がない'));
  assert.equal(r1.code, 0, r1.stdout);
  pms(root, ['next', '--flow', 'F-003']); // C-0002 S-DEVICE-REGISTERED
  const r2 = submitOut(root, 'C-0002', blocked('テスト用デバイスの登録には機器パネルでのペアリング操作が要り、使える skill がない'));
  assert.equal(r2.code, 0, r2.stdout);
  const ext = read(root, 'work/_common/external-op-demand.md');
  const rows = ext.split('## 台帳')[1].split('### 各列')[0].split('\n').filter((l) => /^\| EXT-\d{3} \|/.test(l));
  assert.equal(rows.length, 1, rows.join('\n'));
  assert.match(rows[0], /^\| EXT-001 \| 機器パネルでペアリングを承認 \| シミュレータ \| 未整備 \| skillなし \| HO-PRT-002, HO-PRT-003 \| 不明 \| 該当なし \|  \|  \|  \| 2026-10-07 \|  \|$/);
  const ho = read(root, 'work/_common/handoff-register.md');
  assert.match(ho, /\| HO-PRT-002 \| 前提状態 S-ADMIN-LOGIN の整備: .* \| 操作手段なし \| 要人間判断 \| EXT-001 \| F-003 \/ 作業10 \/ S-ADMIN-LOGIN\(SC-PRT-01, SC-PRT-02\) \| 2026-10-07 \| open \|/);
  const e = setupLog(root).find((x) => x.state_id === 'S-DEVICE-REGISTERED');
  assert.deepEqual(e.blocked_by, { reason: '操作手段なし', handoff: 'HO-PRT-003', ext_demand: 'EXT-001' });
  // 禁止操作は禁止IDの参照がないと red_flag
  const root2 = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN });
  pms(root2, ['next', '--flow', 'F-003']);
  const r3 = submitOut(root2, 'C-0001', { result: 'blocked', seqs: [], established_check_seq: null, fragile: [], notes: null, blocked: { reason: '禁止操作', detail: '管理者のログインに機器の再起動が要る', ref: null, ext_demand: null } });
  assert.equal(r3.code, 1);
  assert.ok(r3.json.failures.some((f) => f.category === 'red_flag' && /禁止ID/.test(f.message)));
});

// ════════════════════════════════════════════════════════
// submit(built・code)
// ════════════════════════════════════════════════════════

test('submit: 合格すると setup-log に付録Bの形の built-by-ui を書き(steps は記録から)、lint を通る。setup.code の合格で fixture などを埋める', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN });
  pms(root, ['next', '--flow', 'F-003']);
  loginActs(root, 'C-0001');
  const r = submitOut(root, 'C-0001', BUILT);
  assert.equal(r.code, 0, r.stdout);
  let e = setupLog(root).find((x) => x.state_id === 'S-ADMIN-LOGIN');
  assert.equal(e.classification, 'built-by-ui');
  assert.deepEqual(e.steps, [
    { action: 'goto', detail: '<env:pms.url>' },
    { action: 'fill', locator: "getByLabel('ユーザーID')", value: '<env:pms.admin.user>' },
    { action: 'fill', locator: "getByLabel('パスワード')", value: '<env:pms.admin.password>' },
    { action: 'click', locator: "getByRole('button', { name: 'ログイン' })" },
  ]);
  assert.equal(e.established_check, "getByRole('link', { name: 'ログアウト' }) が表示される");
  assert.deepEqual(e.act, { card: 'C-0001', seqs: [1, 2, 3, 5], established_check_seq: 6 });
  assert.equal(e.verified, false);
  // 続く setup.code のカード
  const next = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(next.json.kind, 'setup.code');
  assert.match(next.json.body, /getByLabel\('ユーザーID'\)\.fill\(envValue\('pms\.admin\.user'\)\)/);
  codeFiles(root);
  const c = submitOut(root, 'C-0002', CODED);
  assert.equal(c.code, 0, c.stdout);
  e = setupLog(root).find((x) => x.state_id === 'S-ADMIN-LOGIN');
  assert.equal(e.fixture, 'fixtures/auth.ts#adminLogin');
  assert.equal(e.flow, 'flows/auth.ts#loginAsAdmin');
  assert.equal(e.verified, true);
  assert.equal(pms(root, ['next', '--flow', 'F-003']).json.state, 'done');
  // lint(proc-v017 のフロー)
  write(root, 'work/PRT/exploration/status.yaml', 'stage: "10"\nflow_id: F-003\nfeature_code: PRT\nprocedure_version: proc-v017\n');
  const l = lint(root, 'setup_steps_recorded,no_temp_locator,act_log_linked,phase_a_queue_complete');
  assert.equal(l.code, 0, JSON.stringify(l.json?.results, null, 2) + l.stderr);
  // submit-log に合否
  const sl = read(root, 'work/_flows/F-003/submit-log.jsonl').trim().split('\n').map((x) => JSON.parse(x));
  assert.deepEqual(sl.map((x) => [x.card, x.ok]), [['C-0001', true], ['C-0002', true]]);
});

test('submit: 2回の実行のどちらかが失敗なら verified: false。状態需要リストの 採用 は確認できたときだけ 整備済 にする', () => {
  const sd = fs.readFileSync(path.join(REAL_ROOT, 'procedure/templates/96_状態需要リスト_記入用.md'), 'utf8')
    .replace('| SD-001 |  |  |  | 提案 |  |  |  |  |  |  |  |', '| SD-001 | S-ADMIN-LOGIN | 管理者でログイン済 | AUTH | 採用 | HO-PRT-009 | ログイン画面 | ログアウトが見える | 2026-10-06 |  | 2026-10-01 |  |');
  for (const [codes, status] of [[[0, 1], '採用'], [[0, 0], '整備済']]) {
    const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN, 'work/_common/state-demand.md': sd });
    pms(root, ['next', '--flow', 'F-003']);
    loginActs(root, 'C-0001');
    submitOut(root, 'C-0001', BUILT);
    pms(root, ['next', '--flow', 'F-003']);
    codeFiles(root);
    const c = submitOut(root, 'C-0002', { ...CODED, runs: codes.map((x) => run(x)) });
    assert.equal(c.code, 0, c.stdout);
    assert.equal(setupLog(root).find((x) => x.state_id === 'S-ADMIN-LOGIN').verified, codes.every((x) => x === 0));
    const row = read(root, 'work/_common/state-demand.md').split('\n').find((l) => l.startsWith('| SD-001 |'));
    assert.ok(row.includes(`| ${status} |`), row);
    if (status === '整備済') assert.ok(row.includes('fixtures/auth.ts#adminLogin'), row);
  }
});

test('submit の不合格: 区分ごとの理由と直し方を返し、カードは出したままにする', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN }, { config: { max_rejections: 20 } });
  pms(root, ['next', '--flow', 'F-003']);
  loginActs(root, 'C-0001');
  const cat = (out) => {
    const r = submitOut(root, 'C-0001', out);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(r.json.failures.every((f) => f.fix), '直し方がない');
    assert.match(r.json.next, /submit --flow F-003 --card C-0001/);
    return [...new Set(r.json.failures.map((f) => f.category))];
  };
  assert.deepEqual(cat({ ...BUILT, seqs: [1, 2, 3, 99] }), ['seq_missing']);       // 記録のない連番
  assert.deepEqual(cat({ ...BUILT, seqs: [1, 2, 3, 4, 5] }), ['seq_missing']);     // snapshot を含む
  assert.deepEqual(cat({ ...BUILT, seqs: [2, 1, 3, 5] }), ['seq_missing']);        // 順序
  assert.deepEqual(cat({ ...BUILT, established_check_seq: 5 }), ['seq_missing']);  // assert でない
  assert.deepEqual(cat({ ...BUILT, notes: '必要に応じて保存ボタンを押す' }), ['red_flag']);
  assert.deepEqual(cat({ ...BUILT, notes: 'x'.repeat(201) }), ['red_flag']);
  assert.deepEqual(cat({ ...BUILT, result: 'done' }), ['schema']);
  assert.deepEqual(cat({ result: 'built', seqs: [1] }), ['schema']);
  write(root, 'work/_flows/F-003/out/C-0001.json', '{ not json');
  assert.equal(JSON.parse(pms(root, ['submit', '--flow', 'F-003', '--card', 'C-0001']).stdout).failures[0].category, 'schema');
  // CSS のロケータを fragile に挙げずに使う / 一意でない
  const a = (args) => pms(root, ['act', '--flow', 'F-003', '--card', 'C-0001', ...args]);
  a(['--intent', 'メニューを開く', 'click', 'e9']); // 7
  a(['--intent', '詳細を開く', 'click', 'e10']); // 8
  a(['--intent', 'ログアウトのリンクが見える', 'assert', 'e12', 'visible']); // 9
  assert.deepEqual(cat({ ...BUILT, seqs: [1, 2, 3, 5, 7], established_check_seq: 9 }), ['unstable_locator']);
  assert.deepEqual(cat({ ...BUILT, seqs: [1, 2, 3, 5, 8], established_check_seq: 9 }), ['unstable_locator']);
  // fragile に挙げても testid-requests.md に載っていなければ不合格。載せれば合格
  const fr = { ...BUILT, seqs: [1, 2, 3, 5, 7], established_check_seq: 9, fragile: [{ seq: 7, reason: 'メニューのリンクに名前がなく role で取れないため CSS で暫定指定' }] };
  assert.deepEqual(cat(fr), ['unstable_locator']);
  write(root, 'work/_common/testid-requests.md', '| メニュー | 管理リンク | div.menu > a |\n');
  const ok = submitOut(root, 'C-0001', fr);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(setupLog(root).find((x) => x.state_id === 'S-ADMIN-LOGIN').steps[4].fragile, fr.fragile[0].reason);
  assert.equal(queue(root).cards[0].rejections, 12);
});

test('submit の不合格: 別のカードの連番、code_mismatch(ファイル・名前・ロケータ・起動確認テスト)、runs の回数', () => {
  const root = setup({}, { config: { max_rejections: 20 } });
  pms(root, ['next', '--flow', 'F-003']);
  loginActs(root, 'C-0001');
  assert.equal(submitOut(root, 'C-0001', BUILT).code, 0);
  pms(root, ['next', '--flow', 'F-003']); // C-0002 S-DEVICE-REGISTERED
  const a = (args) => pms(root, ['act', '--flow', 'F-003', '--card', 'C-0002', ...args]);
  a(['--intent', 'ログアウトのリンクが見える', 'assert', 'e12', 'visible']); // 7
  const other = submitOut(root, 'C-0002', { ...BUILT, seqs: [5], established_check_seq: 7 });
  assert.equal(other.code, 1);
  assert.ok(other.json.failures.some((f) => f.category === 'seq_missing' && /別のカード C-0001/.test(f.message)));
  // C-0002 を blocked で終え、C-0003(S-ADMIN-LOGIN の setup.code)へ
  submitOut(root, 'C-0002', { result: 'blocked', seqs: [], established_check_seq: null, fragile: [], notes: null, blocked: { reason: '状態未整備', detail: 'デバイスの登録は画面になく、DB 投入でしか作れない', ref: null, ext_demand: null } });
  assert.equal(pms(root, ['next', '--flow', 'F-003']).json.kind, 'setup.code');
  const cats = (out) => [...new Set(submitOut(root, 'C-0003', out).json.failures.map((f) => f.category))];
  assert.deepEqual(cats(CODED), ['code_mismatch']); // ファイルがない
  codeFiles(root);
  write(root, 'tests/pages/LoginPage.ts', "export class LoginPage { constructor(page) { this.user = page.getByLabel('ユーザーID'); } }\n");
  fs.rmSync(path.join(root, 'tests/readiness/server-ready.setup.ts'));
  const r = submitOut(root, 'C-0003', CODED);
  assert.ok(r.json.failures.some((f) => /パスワード/.test(f.message)), r.stdout);
  assert.ok(r.json.failures.some((f) => /起動確認テスト/.test(f.message)), r.stdout);
  assert.deepEqual(cats({ ...CODED, fixture: 'fixtures/auth.ts#noSuchFixture' }).includes('code_mismatch'), true);
  codeFiles(root);
  assert.deepEqual(cats({ ...CODED, runs: [run(0)] }), ['runs']);
});

// ════════════════════════════════════════════════════════
// setup.reuse
// ════════════════════════════════════════════════════════

test('setup.reuse: reused なら流用元の steps を写した provided を書く。broken なら作り直しの setup.build と、同じ名前の setup.code を出す', () => {
  const files = {
    'work/PRT/scenarios.md': ONLY_LOGIN,
    'work/PRT/exploration/setup-log.yaml': PAST_SETUP,
    'tests/fixtures/auth.ts': 'export const adminLogin = 1;\n',
  };
  // reused
  const root = setup(files);
  let n = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(n.json.kind, 'setup.reuse');
  assert.match(n.json.body, /fixtures\/auth\.ts#adminLogin/);
  const ok = submitOut(root, 'C-0001', { result: 'reused', runs: [run(0)], notes: null });
  assert.equal(ok.code, 0, ok.stdout);
  const e = setupLog(root).find((x) => x._flow === 'F-003' && x.state_id === 'S-ADMIN-LOGIN');
  assert.equal(e.classification, 'provided');
  assert.deepEqual(e.steps, setupLog(root).find((x) => x._flow === 'F-001' && x.state_id === 'S-ADMIN-LOGIN').steps);
  assert.deepEqual(e.reused_from, { flow_id: 'F-001', feature_code: 'PRT' });
  assert.equal(e.fixture, 'fixtures/auth.ts#adminLogin');
  assert.equal(e.verified, true);
  assert.equal(pms(root, ['next', '--flow', 'F-003']).json.state, 'done');
  write(root, 'work/PRT/exploration/status.yaml', 'stage: "10"\nflow_id: F-003\nfeature_code: PRT\nprocedure_version: proc-v017\n');
  assert.equal(lint(root, 'setup_steps_recorded,phase_a_queue_complete').code, 0);
  // reused なのに終了コードが 0 でない / runs が2回
  const root3 = setup(files, { config: { max_rejections: 20 } });
  pms(root3, ['next', '--flow', 'F-003']);
  assert.deepEqual(submitOut(root3, 'C-0001', { result: 'reused', runs: [run(1)], notes: null }).json.failures.map((f) => f.category), ['runs']);
  assert.deepEqual(submitOut(root3, 'C-0001', { result: 'reused', runs: [run(0), run(0)], notes: null }).json.failures.map((f) => f.category), ['runs']);
  fs.rmSync(path.join(root3, 'tests/fixtures/auth.ts'));
  assert.ok(submitOut(root3, 'C-0001', { result: 'reused', runs: [run(0)], notes: null }).json.failures.some((f) => f.category === 'reuse_source'));

  // broken
  const root2 = setup(files);
  pms(root2, ['next', '--flow', 'F-003']);
  const br = submitOut(root2, 'C-0001', { result: 'broken', runs: [run(1)], notes: 'ログインボタンの名前が変わっており、fixture のクリックで止まった' });
  assert.equal(br.code, 0, br.stdout);
  assert.ok(!setupLog(root2).some((x) => x._flow === 'F-003' && x.state_id === 'S-ADMIN-LOGIN'), 'broken では setup-log に書かない');
  n = pms(root2, ['next', '--flow', 'F-003']);
  assert.equal(n.json.kind, 'setup.build');
  assert.match(n.json.body, /成立しなかった/);
  loginActs(root2, 'C-0002');
  assert.equal(submitOut(root2, 'C-0002', BUILT).code, 0);
  assert.match(setupLog(root2).find((x) => x._flow === 'F-003').notes, /作り直した/);
  n = pms(root2, ['next', '--flow', 'F-003']);
  assert.equal(n.json.kind, 'setup.code');
  assert.match(n.json.body, /同じ名前のまま/);
  codeFiles(root2);
  const renamed = submitOut(root2, 'C-0003', { ...CODED, fixture: 'fixtures/auth.ts#adminLogin2' });
  assert.ok(renamed.json.failures.some((f) => /同じ名前/.test(f.message)), renamed.stdout);
});

// ════════════════════════════════════════════════════════
// next / status
// ════════════════════════════════════════════════════════

test('next: 提出されないまま呼ばれたら同じカードを出し直し(記録済みの連番を添える)、上限を超えたら STOP。STOP のあとは残りを続け、最後に done', () => {
  const root = setup();
  const n1 = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(n1.code, 0);
  assert.equal(n1.json.card, 'C-0001');
  assert.ok(exists(root, 'work/_flows/F-003/cards/C-0001.md'));
  pms(root, ['act', '--flow', 'F-003', '--card', 'C-0001', 'open', '<env:pms.url>']);
  const n2 = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(n2.json.card, 'C-0001');
  assert.equal(n2.json.issued_count, 2);
  assert.match(n2.json.body, /このカードを出すのは 2 回目である。\*\* 前回は合格する提出がないまま終わった。 このカードで記録済みの操作: 1.open./);
  pms(root, ['next', '--flow', 'F-003']); // 3 回目
  const stop = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(stop.code, 3);
  assert.equal(stop.json.state, 'STOP');
  assert.equal(stop.json.card, 'C-0001');
  assert.match(stop.json.message, /上限/);
  const st = pms(root, ['status', '--flow', 'F-003', '--json']);
  assert.equal(st.json.counts.stopped, 1);
  const n5 = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(n5.json.card, 'C-0002');
  assert.equal(submitOut(root, 'C-0002', { result: 'cannot_proceed', seqs: [], established_check_seq: null, fragile: [], blocked: null, notes: 'デバイス登録の画面が権限エラーで開けず、原因をカードの範囲で判断できない' }).code, 0);
  const s2 = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(s2.code, 3);
  assert.equal(s2.json.card, 'C-0002');
  const done = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(done.code, 0);
  assert.equal(done.json.state, 'done');
  assert.deepEqual(done.json.stopped.map((x) => x.card), ['C-0001', 'C-0002']);
  // 人間が戻す
  const re = pms(root, ['reopen', '--flow', 'F-003', '--card', 'C-0001']);
  assert.equal(re.code, 0);
  assert.equal(pms(root, ['next', '--flow', 'F-003']).json.card, 'C-0001');
  assert.match(pms(root, ['status', '--flow', 'F-003']).stdout, /現在のカード: C-0001/);
});

test('submit: 不合格が上限(max_rejections)に達したらカードを STOP にする', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN }, { config: { max_rejections: 2 } });
  pms(root, ['next', '--flow', 'F-003']);
  assert.equal(submitOut(root, 'C-0001', { result: 'x' }).json.stopped, false);
  const r = submitOut(root, 'C-0001', { result: 'x' });
  assert.equal(r.json.stopped, true);
  assert.equal(pms(root, ['next', '--flow', 'F-003']).code, 3);
  assert.equal(pms(root, ['submit', '--flow', 'F-003', '--card', 'C-0001']).code, 2);
});

test('設定の誤りは終了コード 2(config/pms.json の知らないキー・playwright_cli の形)', () => {
  const root = setup({ 'work/PRT/scenarios.md': ONLY_LOGIN });
  write(root, 'config/pms.json', JSON.stringify({ playwrite_cli: ['x'] }));
  assert.equal(pms(root, ['next', '--flow', 'F-003']).code, 2);
  write(root, 'config/pms.json', JSON.stringify({ playwright_cli: 'playwright-cli' }));
  assert.equal(pms(root, ['next', '--flow', 'F-003']).code, 2);
  assert.equal(pms(root, ['next', '--flow', 'F3']).code, 2);
});

test('カード: 規則IDの行を原本から差し込み、保護ブロックは文言を変えずに差し込む(テンプレートの差し込みはすべて埋まる)', () => {
  const root = setup();
  const body = pms(root, ['next', '--flow', 'F-003']).json.body;
  assert.ok(!/\{\{/.test(body));
  assert.match(body, /- \[R-PMS-1\] 画面操作は必ず `pms act` で行う/);
  assert.match(body, /- \[R-LOC-1\] 採用したロケータは/);
  const common = fs.readFileSync(path.join(REAL_ROOT, 'procedure/00_common.md'), 'utf8');
  const block = common.split('<!-- protected:PROHIBITED_OPS -->')[1].split('<!-- /protected:PROHIBITED_OPS -->')[0].trim();
  assert.ok(body.includes(block), '保護ブロックが文言どおりに入っていない');
  for (const kind of ['setup.build', 'setup.code', 'setup.reuse']) {
    const t = fs.readFileSync(path.join(REAL_ROOT, `procedure/cards/${kind}.md`), 'utf8');
    for (const m of t.matchAll(/\{\{rule:(R-[A-Z]+-\d+)\}\}/g)) assert.match(common + fs.readFileSync(path.join(REAL_ROOT, 'procedure/stages.md'), 'utf8'), new RegExp(`\\*\\*\\[${m[1]}\\]\\*\\*`), `${kind} の ${m[1]} が原本にない`);
  }
});
