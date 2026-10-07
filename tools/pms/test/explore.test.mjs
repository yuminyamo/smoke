// explore.test.mjs — 段2(proc-v018)のテスト: パートCのカード・pms report・pms stats・pms run(node --test tools/pms/test/)
//
// playwright-cli と AI の CLI は偽物(test-support/stub-playwright-cli.mjs・stub-ai-cli.mjs)に差し替える。
// カードを行うAIの代わりは test-support/explore-agent.mjs(同じ会話の中のカードとしても、pms run のセッションとしても使う)。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, write, read, exists, pms, queue, submitOut, SECRET, NOW, REAL_ROOT, PMS_DIR } from '../test-support/helpers.mjs';
import agent, { OUT } from '../test-support/explore-agent.mjs';
import { parseYamlDocs } from '../../lint/lib/yaml-lite.mjs';

process.env.PMS_NOW = NOW;

const SC = `---
review_status: unreviewed
flow_id: F-003
---

## SC-PRT-01: 印刷ジョブの投入と結果の確認

- **目的**: 利用者が印刷を実行し、結果を確認できる
- **策定方式**: manual_usecase(F-003)
- **requires**: S-ADMIN-LOGIN
- **持ち回るデータ**: ジョブID
- **合格条件**: ジョブが受け付けられ、一覧に表示され、完了する

| Step ID | 順序 | 項目名 | 確認内容 | 期待結果 | 検証手段 | 根拠 | review |
|---|---|---|---|---|---|---|---|
| SC-PRT-01-S1 | 1 | 投入 | 印刷を指示する | ジョブが受け付けられる | 両方 | 利用者マニュアル4-2 | unreviewed |
| SC-PRT-01-S2 | 2 | 一覧 | 一覧を開く | 投入したジョブが表示される | 画面 | 利用者マニュアル4-3 | unreviewed |
| SC-PRT-01-S3 | 3 | 完了 | 機器で印刷する | 完了状態になる | 両方 | 利用者マニュアル4-4 | unreviewed |

## SC-PRT-02: ジョブログの表示

- **目的**: ジョブログを確認できる
- **策定方式**: manual_usecase(F-003)
- **requires**: S-ADMIN-LOGIN, S-DEVICE-REGISTERED

| Step ID | 順序 | 項目名 | 確認内容 | 期待結果 | 検証手段 | 根拠 | review |
|---|---|---|---|---|---|---|---|
| SC-PRT-02-S1 | 1 | 表示 | ジョブログを開く | ログが表示される | 画面 | 画面観察 | unreviewed |
| SC-PRT-02-S2 | 2 | 詳細 | 詳細を開く | 詳細が表示される | 画面 | 画面観察 | unreviewed |
`;

const PAST = `feature_code: PRT
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
`;

function prohibitedOps(root) {
  const r = spawnSync(process.execPath, [path.join(REAL_ROOT, 'tools/checks/prohibited-ops.mjs'), '--root', root], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  return { state: j.state, digest: j.digest };
}

function context(root, extra = {}) {
  return {
    environment: 'vm01',
    env_restore: { restore_id: 'RST-20261007-095000-ab12', purpose: 'work10', readiness: 'auto' },
    pre_stage: { state: 'skipped', run_id: 'PRE-20261007-095500-ab12' },
    prohibited_ops: prohibitedOps(root),
    flow_kind: 'new', flow_seq: 'subsequent', scenario_source: 'manual_usecase',
    env_keys_added: [], kb_t05_registered: [], kb_t05_reused: [],
    ext_demand_added: [], ext_demand_appended: [], ext_demand_established: [], ext_demand_unresolved: [],
    state_demand_added: [], state_demand_appended: [], signals_recorded: [], recheck_of: null, reexplore_of: null,
    ...extra,
  };
}

function repo(files = {}, opts = {}) {
  const root = makeRepo({
    'work/PRT/scenarios.md': SC,
    'work/PRT/exploration/setup-log.yaml': PAST,
    'tests/fixtures/auth.ts': 'export const adminLogin = 1;\n',
    'kb/00_索引.md': '# KB 索引\n',
    ...files,
  }, opts);
  // lint の prohibition_recheck が呼ぶ照合スクリプト
  fs.mkdirSync(path.join(root, 'tools/checks'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, 'tools/checks/prohibited-ops.mjs'), path.join(root, 'tools/checks/prohibited-ops.mjs'));
  write(root, 'work/_flows/F-003/stage10-context.json', JSON.stringify(context(root)));
  return root;
}

function build(root, phase = 'all') {
  const r = pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', phase]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return r;
}

/** カードを1枚、同じ会話の中で行う(B1 の代わり) */
async function doNext(root) {
  const n = pms(root, ['next', '--flow', 'F-003']);
  if (n.json?.state !== 'card') return n;
  const res = await agent({ root, flow: 'F-003', card: n.json.card, kind: n.json.kind, body: n.json.body, pms: (args) => pms(root, args) });
  assert.equal(res.submit, 0, `${n.json.card} ${n.json.kind}: ${JSON.stringify(res.failures)}`);
  return n;
}

async function doAll(root) {
  for (let i = 0; i < 30; i++) {
    const n = await doNext(root);
    if (n.json?.state !== 'card') return n;
  }
  throw new Error('終わらない');
}

function lint(root, rules) {
  const args = [path.join(REAL_ROOT, 'tools/lint/lint.mjs'), '--root', root, '--json', '--flow', 'F-003', '--stage', '10'];
  if (rules) args.push('--rule', rules); else args.push('--skip', 'skills_in_sync');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout || 'null'), stderr: r.stderr };
}

function explorationLog(root) {
  return parseYamlDocs(read(root, 'work/PRT/exploration/exploration-log.yaml')).find((d) => d.flow_id === 'F-003');
}

// ════════════════════════════════════════════════════════
// queue build
// ════════════════════════════════════════════════════════

test('queue build --phase all: フェーズAのあとに、ステップごとの explore.step・シナリオごとの explore.close・session_close・report.findings を作る。stage10-context.json が要る', () => {
  const root = repo();
  fs.rmSync(path.join(root, 'work/_flows/F-003/stage10-context.json'));
  const no = pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'all']);
  assert.equal(no.code, 2);
  assert.match(no.json.error, /stage10-context\.json がありません/);
  write(root, 'work/_flows/F-003/stage10-context.json', JSON.stringify({ ...context(root), flow_kind: 'other' }));
  assert.match(pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'all']).json.error, /flow_kind/);
  write(root, 'work/_flows/F-003/stage10-context.json', JSON.stringify(context(root)));
  build(root);
  const q = queue(root);
  assert.deepEqual(q.cards.map((c) => [c.id, c.kind, c.phase, c.step_id ?? c.scenario ?? c.state_id ?? null]), [
    ['C-0001', 'setup.reuse', 'A', 'S-ADMIN-LOGIN'], ['C-0002', 'setup.build', 'A', 'S-DEVICE-REGISTERED'],
    ['C-0003', 'explore.step', 'C', 'SC-PRT-01-S1'], ['C-0004', 'explore.step', 'C', 'SC-PRT-01-S2'], ['C-0005', 'explore.step', 'C', 'SC-PRT-01-S3'],
    ['C-0006', 'explore.close', 'C', 'SC-PRT-01'],
    ['C-0007', 'explore.step', 'C', 'SC-PRT-02-S1'], ['C-0008', 'explore.step', 'C', 'SC-PRT-02-S2'],
    ['C-0009', 'explore.close', 'C', 'SC-PRT-02'],
    ['C-0010', 'explore.session_close', 'C', null], ['C-0011', 'report.findings', 'C', null],
  ]);
  assert.equal(q.rounds.length, 1);
  assert.equal(q.cards[2].digest, '印刷を指示する\u0000ジョブが受け付けられる');
  // パートCのカードが残っている間は、次のラウンドを作れない
  assert.equal(pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'C']).code, 2);
});

test('queue build: --phase A のあとに --phase C を足せる(段1のキューに探索のカードを足す)', () => {
  const root = repo();
  build(root, 'A');
  assert.deepEqual(queue(root).cards.map((c) => c.kind), ['setup.reuse', 'setup.build']);
  build(root, 'C');
  const q = queue(root);
  assert.equal(q.cards.length, 11);
  assert.equal(q.phase, 'A+C');
  // フェーズAのカードを先に出す
  assert.equal(pms(root, ['next', '--flow', 'F-003']).json.kind, 'setup.reuse');
});

// ════════════════════════════════════════════════════════
// カードと記録(同じ会話の中で行う形)
// ════════════════════════════════════════════════════════

test('explore: 合格した提出から pms が付録Aの探索記録・DISC・申し送り・外部操作需要・手順改善シグナルを書き、blocked のあとと前提状態が blocked のシナリオは skipped にする', async () => {
  const root = repo();
  build(root);
  const done = await doAll(root);
  assert.equal(done.json.state, 'done', JSON.stringify(done.json));
  const q = queue(root);
  assert.deepEqual(q.cards.map((c) => c.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'skipped', 'skipped', 'skipped', 'passed', 'passed']);

  const doc = explorationLog(root);
  assert.equal(doc.environment, 'vm01');
  const [s1, s2] = doc.scenarios;
  assert.equal(s1.id, 'SC-PRT-01');
  assert.equal(s1.verdict, 'blocked');
  assert.match(s1.requires_setup, /S-ADMIN-LOGIN: fixtures\/auth\.ts#adminLogin\(既存流用\(F-001\)\)で成立を確認/);
  assert.deepEqual(s1.carried_data, { job_id: 'JOB-1' });
  assert.equal(s1.invariants['INV-003'], 'pass');
  assert.deepEqual(s1.discrepancies, ['DISC-PRT-001']);
  const [a, b, c] = s1.steps;
  // ステップ1: actions・時刻・証跡・act は pms act の記録から
  assert.equal(a.verdict, 'passed');
  assert.deepEqual(a.actions, [
    { action: 'fill', locator: "getByLabel('ユーザーID')", value: '<env:pms.admin.user>' },
    { action: 'click', locator: "getByRole('button', { name: 'ログイン' })" },
  ]);
  assert.equal(a.started_at, NOW);
  assert.equal(a.verification, '両方');
  assert.match(a.verified_by.screen, /getByRole\('link', \{ name: 'ログアウト' \}\) が表示される/);
  assert.match(a.verified_by.db, /SELECT COUNT\(\*\) FROM PrintJob .* → 1 件/);
  assert.deepEqual(a.evidence, ['evidence/SC-PRT-01-S1_5.png']);
  assert.ok(exists(root, 'work/PRT/exploration/evidence/SC-PRT-01-S1_5.png'));
  assert.deepEqual(a.act, { card: 'C-0003', seqs: [2, 3], screen_seqs: [4], evidence_seqs: [5] });
  assert.deepEqual(a.nondeterministic, [{ value: 'ジョブID', catalog_id: '未登録' }]);
  // ステップ2: 健全性シグナル
  assert.equal(b.verdict, 'human-check');
  assert.equal(b.health_signal.observed_at, NOW);
  // ステップ3: blocked。申し送りと外部操作需要リストは pms が書く
  assert.equal(c.verdict, 'blocked');
  assert.deepEqual(c.blocked_by, { reason: '操作手段なし', handoff: 'HO-PRT-003', ext_demand: 'EXT-002', resume_from: 'SC-PRT-01-S3' });
  assert.equal(c.started_at, undefined);
  // 前提状態が blocked(フェーズAで 操作手段なし)のシナリオ: 全ステップを blocked と記録し、参照は setup-log から
  assert.equal(s2.id, 'SC-PRT-02');
  assert.equal(s2.verdict, 'blocked');
  assert.deepEqual(s2.steps[0].blocked_by, { reason: '操作手段なし', handoff: 'HO-PRT-001', ext_demand: 'EXT-001', resume_from: 'SC-PRT-02-S1' });
  assert.deepEqual(s2.steps[1].blocked_by, { reason: '前ステップが blocked' });
  assert.match(s2.invariants['INV-003'], /^未実施/);
  // 台帳
  assert.match(read(root, 'work/_common/discrepancies.md'), /## DISC-PRT-001\n\n- \*\*種別\*\*: 実画面≠マニュアル\n- \*\*関連項目\*\*: SC-PRT-01-S1/);
  assert.match(read(root, 'work/_common/discrepancies.md'), /\*\*証跡\*\*: evidence\/SC-PRT-01-S1_5\.png/);
  const ho = read(root, 'work/_common/handoff-register.md');
  assert.match(ho, /\| HO-PRT-002 \| 印刷部数に上限値を入れたときの受付の確認 \| 異常系 \| ステップ2 \|  \| F-003 \/ 作業10 \/ SC-PRT-01-S1 \|/);
  assert.match(ho, /\| HO-PRT-003 \| SC-PRT-01-S3 の実行: 機器パネルで印刷を実行する操作に使える skill がない \| 操作手段なし \| 要人間判断 \| EXT-002 \|/);
  assert.match(read(root, 'work/_common/external-op-demand.md'), /\| EXT-002 \| 機器パネルから印刷実行 \| シミュレータ \| 未整備 \| skillなし \| HO-PRT-003 \|/);
  assert.match(read(root, 'work/_common/procedure-improvement.md'), /\| SIG-0001 \| F-003 \/ 10 \/ SC-PRT-01-S1 \| ST\/10\/4-C \| 曖昧 \| 自己申告 \|/);
  // 記録の lint(探索記録・setup-log・pms の記録)
  const l = lint(root, 'verdict_enum,reason_code_enum,blocked_recorded,no_temp_locator,ext_demand_linked,requires_covered,explore_act_linked,setup_steps_recorded');
  assert.equal(l.code, 0, JSON.stringify(l.json?.results?.filter((x) => x.findings.length), null, 1));
});

test('explore: カードの入力に、前のステップの記録の抜粋・前提状態の操作列・期待結果(原文)・保護ブロックが入る', async () => {
  const root = repo();
  build(root);
  await doNext(root); // setup.reuse
  await doNext(root); // setup.build(blocked)
  const n1 = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(n1.json.kind, 'explore.step');
  assert.match(n1.json.body, /\| 期待結果 \| ジョブが受け付けられる \|/);
  assert.match(n1.json.body, /S-ADMIN-LOGIN\(provided・fixture `fixtures\/auth\.ts#adminLogin`\)/);
  assert.match(n1.json.body, /- \[R-EXP-13\] `blocked` にするのは実行できないステップ\*\*以降\*\*に限る/);
  assert.match(n1.json.body, /<!-- 保護ブロック EXPECTED_IMMUTABLE/);
  assert.match(n1.json.body, /<!-- 保護ブロック PROHIBITED_OPS/);
  assert.equal(n1.json.next, 'node tools/pms/pms.mjs act --flow F-003 --card C-0003 snapshot');
  await agent({ root, flow: 'F-003', card: 'C-0003', kind: 'explore.step', body: n1.json.body, pms: (args) => pms(root, args) });
  const n2 = pms(root, ['next', '--flow', 'F-003']);
  assert.match(n2.json.body, /- SC-PRT-01-S1: passed。操作: fill getByLabel\('ユーザーID'\) ← <env:pms\.admin\.user> → click getByRole/);
  assert.match(n2.json.body, /"job_id": "JOB-1"/);
  assert.match(n2.json.body, /前のステップのあとの画面から続ける/);
});

test('explore.step の検査: 期待結果の書き換え・証跡なし・健全性シグナルの時刻・blocked の参照・別のカードの連番・検証手段の欠け', async () => {
  const root = repo({}, { config: { max_rejections: 10 } });
  build(root);
  await doNext(root);
  await doNext(root);
  pms(root, ['next', '--flow', 'F-003']); // C-0003
  const act = (args) => pms(root, ['act', '--flow', 'F-003', '--card', 'C-0003', ...args]);
  act(['open', '<env:pms.url>']);
  const op = act(['--intent', '印刷', 'click', 'e7']).json.seq;
  const as = act(['--intent', '確認', 'assert', 'e12', 'visible']).json.seq;
  const ok = {
    result: 'explored', verdict: 'passed', seqs: [op], fragile: [],
    verification: { method: '両方', screen_seqs: [as], db: { query: 'SELECT COUNT(*) FROM PrintJob', result: '1 件' }, reason: null },
    observed: '受付完了のメッセージが表示された', assertion_hint: 'DB: SELECT COUNT(*) FROM PrintJob WHERE JobId = <carried_data.job_id> = 1',
    carried_data: {}, nondeterministic: [], wait: null, health_signal: null, blocked_by: null, discrepancies: [], handoffs: [], procedure_signals: [], ops_registered: [], evidence: [], notes: null,
  };
  const cats = (out) => submitOut(root, 'C-0003', out).json.failures?.map((f) => f.category) ?? [];
  // 期待結果・判定基準を書き換えたと述べる
  assert.deepEqual(cats({ ...ok, notes: '期待結果を変更して受付だけを確認した' }), ['expected_changed']);
  // human-check なのに証跡がない
  assert.deepEqual(cats({ ...ok, verdict: 'human-check' }), ['verdict_evidence']);
  // 健全性シグナルの時刻が操作の範囲の外 / passed のまま
  assert.deepEqual(cats({ ...ok, verdict: 'human-check', evidence: [], health_signal: { kind: 'エラー表示', detail: 'エラーのダイアログが出た', observed_at: '2026-10-07T11:00:00+09:00' } }).sort(), ['health_time', 'verdict_evidence']);
  // 検証手段が 両方 なのに DB がない / SELECT 以外
  assert.deepEqual(cats({ ...ok, verification: { ...ok.verification, db: null } }), ['red_flag']);
  assert.deepEqual(cats({ ...ok, verification: { ...ok.verification, db: { query: 'DELETE FROM PrintJob WHERE 1=1', result: '0 件' } } }), ['lint']);
  // 連番: assert を seqs に入れた / 記録にない連番
  assert.deepEqual(cats({ ...ok, seqs: [as] }), ['seq_missing']);
  assert.deepEqual(cats({ ...ok, seqs: [99] }), ['seq_missing']);
  // blocked: 禁止IDがリストにない・理由コードが語彙にない・resume_from が前のステップ
  const blk = { ...ok, verdict: 'blocked', seqs: [], verification: null, observed: null, assertion_hint: null };
  const by = { reason: '禁止操作', detail: 'シミュレータの再起動が要許可に当たる', ref: 'PROH-009', handoff: null, ext_demand: null, resume_from: 'SC-PRT-01-S1' };
  assert.deepEqual(cats({ ...blk, blocked_by: by }), ['blocked_refs']);
  assert.deepEqual(cats({ ...blk, blocked_by: { ...by, reason: '面倒', ref: null } }), ['blocked_refs']);
  assert.deepEqual(cats({ ...blk, blocked_by: { ...by, ref: '包括原則2', handoff: 'HO-PRT-099' } }), ['blocked_refs']);
  // ここまでで不合格が上限(10)に達して STOP になっている
  const q = queue(root);
  assert.equal(q.cards[2].status, 'stopped');
  assert.equal(q.cards[2].stop.code, 'reject_limit');
  // 後続のステップも人間の確認待ち(伝えるのは元のカードの1回だけ)
  assert.equal(q.cards[3].status, 'stopped');
  assert.equal(q.cards[3].stop.chained_from, 'C-0003');
  const stop = pms(root, ['next', '--flow', 'F-003']);
  assert.equal(stop.code, 3);
  assert.equal(stop.json.card, 'C-0003');
  assert.equal(stop.json.code, 'reject_limit');
  // reopen は後続のステップも戻す
  const ro = pms(root, ['reopen', '--flow', 'F-003', '--card', 'C-0003']);
  assert.deepEqual(ro.json.reopened, ['C-0003', 'C-0004', 'C-0005']);
});

test('explore.step の検査: scenarios.md のステップの行を書き換えたら expected_changed', async () => {
  const root = repo();
  build(root);
  await doNext(root);
  await doNext(root);
  const n = pms(root, ['next', '--flow', 'F-003']);
  write(root, 'work/PRT/scenarios.md', SC.replace('ジョブが受け付けられる', 'ジョブが受け付けられる(画面の表示だけ)'));
  const r = await agent({ root, flow: 'F-003', card: n.json.card, kind: 'explore.step', body: n.json.body, pms: (args) => pms(root, args) });
  assert.deepEqual(r.failures.map((f) => f.category), ['expected_changed']);
});

test('explore.close・session_close の検査: INV の全キー、fail と violations の対応、反映先のファイル。report.findings は INV を優先レビューに求める', async () => {
  const root = repo();
  build(root);
  for (let i = 0; i < 5; i++) await doNext(root); // reuse・build・S1・S2・S3
  pms(root, ['next', '--flow', 'F-003']); // C-0006 close
  const cats = (out) => submitOut(root, 'C-0006', out).json.failures?.map((f) => f.category) ?? [];
  const ok = OUT['explore.close']();
  const { 'INV-005': _drop, ...partial } = ok.invariants;
  void _drop;
  assert.deepEqual(cats({ ...ok, invariants: partial }), ['schema']);
  assert.deepEqual(cats({ ...ok, invariants: { ...ok.invariants, 'INV-004': 'fail' } }), ['red_flag']);
  assert.deepEqual(cats({ ...ok, reflections: [{ operation: 'ログアウトのリンク', target: 'page', path: 'tests/pages/NoSuch.ts' }] }), ['red_flag']);
});

// ════════════════════════════════════════════════════════
// pms report
// ════════════════════════════════════════════════════════

test('report: 記録から報告書の数値・一覧と status.yaml を作り、作業10の lint(全規則)を通る', async () => {
  const root = repo();
  build(root);
  assert.equal(pms(root, ['report', '--flow', 'F-003']).code, 2, 'カードが終わる前は作れない');
  await doAll(root);
  const r = pms(root, ['report', '--flow', 'F-003']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.wrote, ['work/PRT/exploration/report.md', 'work/PRT/exploration/status.yaml']);
  const st = parseYamlDocs(read(root, 'work/PRT/exploration/status.yaml'))[0];
  assert.equal(st.stage, '10');
  assert.equal(st.procedure_version, 'proc-v018');
  assert.equal(st.environment, 'vm01');
  assert.equal(st.outcome, 'partial_success');
  const cu = st.context_updates;
  assert.deepEqual(cu.verdicts, { passed: 0, failed: 0, human_check: 0, blocked: 2 });
  assert.equal(cu.health_signal, 'found');
  assert.deepEqual(cu.health_signal_items, ['SC-PRT-01']);
  assert.equal(cu.invariant_violation, 'none');
  assert.equal(cu.escalation, 'none');
  assert.equal(cu.nd_needed, 'yes');
  assert.deepEqual(cu.ext_demand_added, ['EXT-001', 'EXT-002']);
  assert.equal(cu.handoff_by_reason['操作手段なし'], 2);
  assert.equal(cu.handoff_by_reason['異常系'], 1);
  assert.deepEqual(cu.codeable_items, []);
  assert.deepEqual(cu.blocked_by_prohibition, []);
  assert.deepEqual(st.signals_recorded, ['SIG-0001']);
  const md = read(root, 'work/PRT/exploration/report.md');
  for (const h of ['## 1. 要約', '## 2. サマリ', '## 3. 参照した', '## 4. 資産流用', '## 5. 申し送り', ...Array.from({ length: 11 }, (_, i) => `## 固有${i + 1}. `), '## 6. 未確認', '## 7. 優先レビュー', '## 8. 手順改善シグナル']) assert.ok(md.includes(h), h);
  assert.match(md, /最も重要な1件: SC-PRT-01-S2 でジョブがエラーになる健全性シグナル/);
  assert.match(md, /\| DISC-PRT-001 \| SC-PRT-01-S1 \| 実画面≠マニュアル \| ドキュメント不備疑い \|/);
  assert.match(md, /\| SC-PRT-01 \| SC-PRT-01-S3 \| 操作手段なし \| HO-PRT-003・EXT-002 \| SC-PRT-01-S3 \|/);
  assert.match(md, /- 手順改善シグナル: SIG-0001/);
  // 作業10の lint(skills_in_sync 以外の全規則。env_restored は PowerShell がなければ未実行)
  const l = lint(root);
  assert.equal(l.code, 0, JSON.stringify(l.json?.results?.filter((x) => x.findings.length), null, 1));
  // 直せない DoD があるときは --dod-unmet
  const r2 = pms(root, ['report', '--flow', 'F-003', '--dod-unmet', 'assertion_hint の自データスコープを確かめられなかった']);
  assert.equal(r2.code, 0);
  assert.match(read(root, 'work/PRT/exploration/report.md'), /DoD を満たせない項目がある: assertion_hint/);
});

// ════════════════════════════════════════════════════════
// pms stats
// ════════════════════════════════════════════════════════

test('stats: カードの種類・実行形態ごとの初回合格率・提出の回数・不合格の区分と、記録の必須欄の充足率', async () => {
  const root = repo();
  build(root);
  await doNext(root);
  await doNext(root);
  pms(root, ['next', '--flow', 'F-003']);
  submitOut(root, 'C-0003', { result: 'explored' }); // schema の不合格
  const n = pms(root, ['next', '--flow', 'F-003']); // 出し直し
  await agent({ root, flow: 'F-003', card: 'C-0003', kind: 'explore.step', body: n.json.body, pms: (args) => pms(root, args) });
  const s = pms(root, ['stats', '--flow', 'F-003', '--json']);
  assert.equal(s.code, 0, s.stdout);
  const step = s.json.by_kind.find((x) => x.kind === 'explore.step');
  assert.deepEqual({ cards: step.cards, first: step.first_pass_rate, avg: step.avg_submits, rej: step.rejections, re: step.reissues, runner: step.runner },
    { cards: 1, first: 0, avg: 2, rej: { schema: 1 }, re: 1, runner: 'b1' });
  assert.equal(s.json.by_kind.find((x) => x.kind === 'setup.reuse').first_pass_rate, 100);
  assert.equal(s.json.records['exploration.steps.act'].rate, 100);
  const t = pms(root, ['stats', '--since', '2026-10-01']);
  assert.match(t.stdout, /\| explore\.step \| b1 \| 1 \| 0% \| 2 \| schema 1 \| 1 \| 0 \|/);
  assert.equal(pms(root, ['stats']).code, 2);
});

// ════════════════════════════════════════════════════════
// pms run(AI の CLI は偽物)
// ════════════════════════════════════════════════════════

const STUB_AI = path.join(PMS_DIR, 'test-support', 'stub-ai-cli.mjs');
const AGENT = path.join(PMS_DIR, 'test-support', 'explore-agent.mjs');
function runner(extra = {}) {
  return {
    default_runner: 'fake',
    runner: { fake: { command: [process.execPath, STUB_AI, '{card_file}', '{card}', '{flow}', '{deny}'], deny_arg: ['--deny', '{pattern}'], deny: ['shell(playwright-cli:*)'], stdin: 'prompt', timeoutSec: 60, ...extra } },
    cardTypes: { 'explore.step': { deny: ['shell(npx:*)'] } },
  };
}
const runEnv = (mode) => ({ PMS_STUB_AI: AGENT, PMS_STUB_AI_LEAK: `password=${SECRET}`, ...(mode ? { PMS_STUB_AGENT_MODE: mode } : {}) });

test('run: カードを1枚ずつ新しいセッションで行わせ、報告書と lint まで終える。出力を保存し秘密情報を伏せ、提出の記録に b2 を残す', () => {
  const root = repo({}, { config: runner() });
  build(root);
  const r = pms(root, ['run', '--flow', 'F-003'], { env: runEnv() });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.state, 'done');
  assert.equal(r.json.lint.ok, true);
  assert.equal(r.json.sessions.length, 8); // 11 枚のうち 3 枚は skipped
  assert.ok(r.json.sessions.every((s) => s.status === 'passed' && s.exit_code === 0));
  assert.ok(exists(root, 'work/PRT/exploration/status.yaml'));
  const out = read(root, 'work/_flows/F-003/runs/C-0003-1.jsonl');
  assert.ok(!out.includes(SECRET), '秘密情報の値が残っている');
  assert.match(out, /password=<env:pms\.admin\.password>/);
  assert.match(out, /"runner":"b2"/);
  assert.match(out.trim().split('\n').pop(), /"pms":\{"card":"C-0003","kind":"explore\.step","runner":"fake","attempt":1,"exit_code":0/);
  const rows = read(root, 'work/_flows/F-003/submit-log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.every((x) => x.runner === 'b2'));
  const s = pms(root, ['stats', '--flow', 'F-003', '--json']);
  assert.ok(s.json.by_kind.every((x) => x.runner === 'b2'));
});

test('run: 提出せずに終わったら同じカードを出し直し、上限で STOP(終了コード 3)。もう一度 run すると残りを続ける', () => {
  const root = repo({}, { config: { ...runner(), max_issues: 2 } });
  build(root);
  const r = pms(root, ['run', '--flow', 'F-003', '--phase', 'A'], { env: runEnv('none') });
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.equal(r.json.state, 'STOP');
  assert.equal(r.json.code, 'issue_limit');
  assert.equal(r.json.card, 'C-0001');
  assert.match(r.json.message, /pms\.mjs reopen --flow F-003 --card C-0001/);
  assert.deepEqual(r.json.sessions.map((s) => [s.card, s.attempt, s.status]), [['C-0001', 1, 'issued'], ['C-0001', 2, 'issued']]);
  assert.match(read(root, 'work/_flows/F-003/cards/C-0001.md'), /このカードを出すのは 2 回目である/);
  assert.ok(exists(root, 'work/_flows/F-003/runs/C-0001-2.jsonl'));
  // もう一度 run すると、伝え済みの STOP は飛ばして残りのカード(C-0002)を続ける
  const again = pms(root, ['run', '--flow', 'F-003', '--phase', 'A'], { env: runEnv('none') });
  assert.equal(again.code, 3, again.stdout);
  assert.equal(again.json.card, 'C-0002');
  // フェーズAだけを対象にしたので、パートCには進まない
  const third = pms(root, ['run', '--flow', 'F-003', '--phase', 'A'], { env: runEnv('none') });
  assert.equal(third.code, 0, third.stdout);
  assert.equal(third.json.state, 'done');
});

test('run: 1枚の上限時間を超えたら止めて未提出として扱う。CLI が起動しなければ終了コード 1。runner がなければ 2。--dry-run は呼び出しだけを示す', () => {
  const root = repo({}, { config: { ...runner({ timeoutSec: 1 }), max_issues: 1 } });
  build(root);
  const r = pms(root, ['run', '--flow', 'F-003', '--max-cards', '1'], { env: runEnv('sleep') });
  assert.equal(r.code, 4, r.stdout + r.stderr); // --max-cards で止めた
  assert.equal(r.json.sessions[0].timed_out, true);
  assert.equal(queue(root).history.find((h) => h.event === 'session').timed_out, true);

  const dry = pms(root, ['run', '--flow', 'F-003', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(dry.json.card, 'C-0001');
  assert.deepEqual(dry.json.command.slice(-2), ['--deny', 'shell(playwright-cli:*)']);

  const root2 = repo({}, { config: { ...runner(), runner: { fake: { command: ['no-such-ai-cli-xyz', '{prompt}'] } } } });
  build(root2);
  const e = pms(root2, ['run', '--flow', 'F-003'], { env: runEnv() });
  assert.equal(e.code, 1, e.stdout);
  assert.match(e.json.error, /no-such-ai-cli-xyz を起動できない/);

  const root3 = repo();
  build(root3);
  const n = pms(root3, ['run', '--flow', 'F-003']);
  assert.equal(n.code, 2);
  assert.match(n.json.error, /runner がありません/);
});

test('run: explore.step のセッションには、種類ごとの使用禁止を足して CLI に渡す', () => {
  const root = repo({}, { config: runner() });
  build(root);
  pms(root, ['next', '--flow', 'F-003']);
  submitOut(root, 'C-0001', OUT['setup.reuse']());
  pms(root, ['next', '--flow', 'F-003']);
  submitOut(root, 'C-0002', OUT['setup.build']());
  const dry = pms(root, ['run', '--flow', 'F-003', '--dry-run']);
  assert.equal(dry.json.kind, 'explore.step');
  assert.deepEqual(dry.json.command.slice(-4), ['--deny', 'shell(playwright-cli:*)', '--deny', 'shell(npx:*)']);
  assert.equal(dry.json.stdin, true);
});

// ════════════════════════════════════════════════════════
// エージェントの定義(生成物)
// ════════════════════════════════════════════════════════

test('agents: カードの種類ごとのエージェントが生成されていて、pms run が使う名前と一致する', async () => {
  const { agentName } = await import('../lib/run.mjs');
  const { Procedure } = await import('../lib/procedure.mjs');
  const kinds = Object.keys(new Procedure(REAL_ROOT).vocab.pms_card_kind);
  for (const k of kinds) {
    assert.ok(fs.existsSync(path.join(REAL_ROOT, '.github/agents', `${agentName(k)}.agent.md`)), k);
    assert.ok(fs.existsSync(path.join(REAL_ROOT, '.kiro/agents', `${agentName(k)}.json`)), k);
  }
  const kiro = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, '.kiro/agents/pms-card-explore-step.json'), 'utf8'));
  assert.ok(kiro.permissions.rules.some((r) => r.effect === 'deny' && r.match.includes('playwright-cli *')));
  const r = spawnSync(process.execPath, [path.join(REAL_ROOT, 'tools/build-skills/build-skills.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// ════════════════════════════════════════════════════════
// lint explore_act_linked・パートPのラウンド
// ════════════════════════════════════════════════════════

test('lint explore_act_linked: 探索記録の actions を記録と違う形に書き換えると ERROR', async () => {
  const root = repo();
  build(root);
  await doAll(root);
  assert.equal(pms(root, ['report', '--flow', 'F-003']).code, 0); // 手順版は作業10の status.yaml で決まる
  const ok = lint(root, 'explore_act_linked');
  assert.equal(ok.code, 0);
  assert.match(ok.json.results[0].notes.join(), /ステップ 3 件を確認/);
  const rel = 'work/PRT/exploration/exploration-log.yaml';
  const before = read(root, rel);
  const after = before.replace("getByRole('button', { name: 'ログイン' })", "getByRole('button', { name: '印刷' })");
  assert.notEqual(after, before);
  write(root, rel, after);
  const l = lint(root, 'explore_act_linked');
  assert.equal(l.code, 1);
  assert.match(JSON.stringify(l.json.results[0].findings), /actions\[1\] の locator が記録/);
});

test('パートP: 同じフローに新しいラウンドを足し、recheck_of を付けた記録を後ろに足す(前の記録は消さない)', async () => {
  const root = repo();
  build(root);
  await doAll(root);
  write(root, 'work/_flows/F-003/stage10-context.json', JSON.stringify(context(root, { recheck_of: 'sha256:old' })));
  const r = pms(root, ['queue', 'build', '--flow', 'F-003', '--phase', 'C', '--scenarios', 'SC-PRT-01']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.cards.map((c) => c.kind), ['explore.step', 'explore.step', 'explore.step', 'explore.close', 'explore.session_close', 'report.findings']);
  await doAll(root);
  const scs = explorationLog(root).scenarios.filter((x) => x.id === 'SC-PRT-01');
  assert.equal(scs.length, 2);
  assert.equal(scs[0].recheck_of, undefined);
  assert.equal(scs[1].recheck_of, 'sha256:old');
  assert.equal(pms(root, ['report', '--flow', 'F-003']).code, 0);
  const cu = parseYamlDocs(read(root, 'work/PRT/exploration/status.yaml'))[0].context_updates;
  assert.deepEqual(cu.recheck_resolved, []);
  assert.match(read(root, 'work/PRT/exploration/report.md'), /## 固有12\. 再探索・再判定の結果/);
});
