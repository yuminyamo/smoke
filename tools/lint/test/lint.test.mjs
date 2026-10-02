// lint.test.mjs — tools/lint/lint.mjs の自己完結テスト(node --test tools/lint/test/)
//
// 一時ディレクトリに小さなリポジトリ(正本は実物の procedure/ を写す)を作り、ランナーを実行して結果を確かめる。
// build-skills・照合スクリプトは、終了コードだけを返す差し替え版を置く(呼び出しの配線を確かめるため)。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LINT_DIR = path.resolve(here, '..');
const REAL_ROOT = path.resolve(LINT_DIR, '..', '..');

// ── 基準のリポジトリ(全規則が通る) ─────────────────────────
const BASE = {
  'work/PRT/scenarios.md': `---
review_status: unreviewed
generated_by: 作業10(F-001)
flow_id: F-001
---

## SC-PRT-01: 印刷ジョブの投入と実行結果の確認

- **目的**: 印刷を実行して結果を確認する
- **requires**: S-USER-LOGIN, S-DEVICE-REGISTERED
- **使用する外部操作**: OP-CLI-001(KB T05 登録済)

| Step ID | 順序 | 項目名 | 確認内容 | 期待結果 | 検証手段 | 根拠 | review |
|---|---|---|---|---|---|---|---|
| SC-PRT-01-S1 | 1 | 投入 | 印刷指示 | 受付 | 両方 | 利用者マニュアル4-2 | unreviewed |
| SC-PRT-01-S2 | 2 | 実行 | 実行 | 完了 | 両方 | 利用者マニュアル4-4 | unreviewed |
| SC-PRT-01-S3 | 3 | 確認 | 一覧 | 表示 | 両方 | 画面観察 | unreviewed |

## SC-PRT-02: スキャン結果の確認

- **requires**: S-USER-LOGIN, S-DEVICE-REGISTERED

| Step ID | 順序 | 項目名 | 確認内容 | 期待結果 | 検証手段 | 根拠 | review |
|---|---|---|---|---|---|---|---|
| SC-PRT-02-S1 | 1 | 画面 | 画面を開く | 表示 | 画面 | 画面観察 | unreviewed |
| SC-PRT-02-S2 | 2 | 投入 | パネルからスキャン投入(EXT-001) | 受付 | 両方 | 推測(仕様未記載) | unreviewed |
| SC-PRT-02-S3 | 3 | 確認 | 一覧 | 表示 | 両方 | 画面観察 | unreviewed |

## SC-PRT-03: 大量印刷の実行

- **requires**: S-ADMIN-LOGIN

| Step ID | 順序 | 項目名 | 確認内容 | 期待結果 | 検証手段 | 根拠 | review |
|---|---|---|---|---|---|---|---|
| SC-PRT-03-S1 | 1 | 設定 | 設定 | 保存 | 両方 | 画面観察 | unreviewed |
| SC-PRT-03-S2 | 2 | 指示 | 指示 | 受付 | 両方 | 画面観察 | unreviewed |
| SC-PRT-03-S3 | 3 | 実行 | 50ページ印刷 | 完了 | 両方 | 画面観察 | unreviewed |
`,
  'work/PRT/exploration/exploration-log.yaml': `feature_code: PRT
flow_id: F-001
explored_at: 2026-09-26
scenarios:
  - id: SC-PRT-01
    verdict: passed
    requires_setup: |
      S-USER-LOGIN: fixtures/auth.ts#userLogin で成立を確認
      S-DEVICE-REGISTERED: fixtures/device.ts#deviceRegistered で成立を確認
    carried_data: {}
    steps:
      - step_id: SC-PRT-01-S1
        verdict: passed
        actions:
          - action: external
            operation_id: OP-CLI-001
        verification: 両方
        assertion_hint: |
          DB: SELECT COUNT(*) FROM PrintJob WHERE JobId = <job_id> = 1
      - step_id: SC-PRT-01-S2
        verdict: passed
        actions:
          - action: click
            locator: getByRole('button', { name: '実行' })
        verification: 両方
        assertion_hint: x
      - step_id: SC-PRT-01-S3
        verdict: passed
        actions:
          - action: goto
            detail: /jobs
        verification: 両方
        assertion_hint: x
  - id: SC-PRT-02
    verdict: blocked
    requires_setup: |
      S-USER-LOGIN: 既存流用 / S-DEVICE-REGISTERED: 本フローで整備
    steps:
      - step_id: SC-PRT-02-S1
        verdict: passed
        actions:
          - action: goto
            detail: /scan
        verification: 画面
        assertion_hint: x
      - step_id: SC-PRT-02-S2
        verdict: blocked
        blocked_by:
          reason: 操作手段なし
          ext_demand: EXT-001
          handoff: HO-PRT-001
          resume_from: SC-PRT-02-S2
      - step_id: SC-PRT-02-S3
        verdict: blocked
        blocked_by: { reason: 前ステップが blocked }
  - id: SC-PRT-03
    verdict: blocked
    requires_setup: |
      S-ADMIN-LOGIN: fixtures/auth.ts#adminLogin で成立を確認
    steps:
      - step_id: SC-PRT-03-S1
        verdict: passed
        verification: 両方
        assertion_hint: x
      - step_id: SC-PRT-03-S2
        verdict: human-check
        verification: 両方
        assertion_hint: x
      - step_id: SC-PRT-03-S3
        verdict: blocked
        blocked_by:
          reason: 禁止操作
          prohibition: PROH-001
          handoff: HO-PRT-002
          resume_from: SC-PRT-03-S3
`,
  'work/PRT/exploration/setup-log.yaml': `feature_code: PRT
flow_id: F-001
setups:
  - state_id: S-USER-LOGIN
    classification: built-by-ui
    fixture: fixtures/auth.ts#userLogin
    steps:
      - action: fill
        locator: getByLabel('ユーザーID')
    established_check: ログアウトのリンクが表示される
    verified: true
  - state_id: S-ADMIN-LOGIN
    classification: built-by-ui
    fixture: fixtures/auth.ts#adminLogin
    established_check: 管理メニューが表示される
    verified: true
  - state_id: S-DEVICE-REGISTERED
    classification: built-by-ui
    fixture: fixtures/device.ts#deviceRegistered
    established_check: デバイス一覧にテスト用デバイスがある
    verified: true
`,
  'work/PRT/exploration/status.yaml': `stage: "10"
flow_id: F-001
feature_code: PRT
procedure_version: proc-v005
outcome: partial_success
review_status: unreviewed
env_restore:
  restore_id: RST-20260926-101500-a1b2
  purpose: work10
  readiness: human
prohibited_ops:
  state: filled
  digest: sha256:0123456789abcdef
context_updates:
  flow_kind: new
  flow_seq: first
  escalation: none
  invariant_violation: none
  nd_needed: no
  verdicts: { passed: 1, failed: 0, human_check: 0, blocked: 2 }
  handoff_by_reason: { 同一経路: 0, 異常系: 0, 基本操作外: 0, 初期状態外: 0,
                       状態未整備: 0, 操作手段なし: 1, 禁止操作: 1, E2E非効率: 0, 判定不能: 0 }
  rediscovery_rate: 0.0
  codeable_items: [SC-PRT-01]
  assertion_gap_items: []
  setup_unverified: []
  blocked_by_prohibition: [SC-PRT-03-S3]
  kb_t05_registered: [OP-CLI-001]
signals_recorded: []
`,
  'work/PRT/codegen/status.yaml': `stage: "20"
flow_id: F-001
feature_code: PRT
procedure_version: proc-v005
outcome: success
env_restore:
  restore_id: RST-20260926-140000-c3d4
  purpose: work20
  readiness: auto
prohibition_check: ok
context_updates:
  rework_required: no
  state_catalog_requested: no
  traceability_unmatched: 0
  codified: 1
  skipped: 2
  clean_run: { green: 1, red: 0, red_setup_missing: [] }
signals_recorded: []
`,
  'traceability/PRT-matrix.md': `| シナリオID | フロー | ステップ数 | 判定(作業10) | コード化 | テストファイル | テスト名 | 備考 |
|---|---|---|---|---|---|---|---|
| SC-PRT-01 | F-001 | 3 | passed | ✅ | specs/prt/prt.spec.ts | 印刷 [SC-PRT-01] | |
| SC-PRT-02 | F-001 | 3 | blocked | ⏭ スキップ | - | - | 操作手段なし |
`,
  'tests/fixtures/auth.ts': 'export const userLogin = 1;\nexport const adminLogin = 2;\n',
  'tests/fixtures/device.ts': 'export const deviceRegistered = 1;\n',
  'work/_common/handoff-register.md': `# 申し送り台帳

## 台帳

| ID | 対象 | 理由コード | 引き継ぎ先 | 想定手段 | 発生元 | 起票日 | 状態 |
|---|---|---|---|---|---|---|---|
| HO-XXX-001 |  |  |  |  |  |  | open |
| HO-PRT-001 | パネルからのスキャン投入 | 操作手段なし | 要人間判断 | EXT-001(skill 未整備) | F-001 / 作業10 / SC-PRT-02-S2 | 2026-09-26 | open |
| HO-PRT-002 | 50ページの印刷 | 禁止操作 | 要人間判断 | PROH-001 | F-001 / 作業10 / SC-PRT-03-S3 | 2026-09-26 | open |

## 記入例

| ID | 対象 | 理由コード | 引き継ぎ先 | 想定手段 | 発生元 | 起票日 | 状態 |
|---|---|---|---|---|---|---|---|
| HO-OLD-001 | 例 | 語彙外操作 | 要人間判断 |  | F-000 | 2026-08-01 | open |
`,
  'work/_common/external-op-demand.md': `# 外部操作需要リスト

## 台帳

| 需要ID | 外部操作(業務語) | 操作対象 | 状態 | 不足の区分 | 要求元 | 代替手段 | 禁止操作との関係 | 優先度(人間) | 整備記録(人間) | 確立した操作ID | 起票日 | 備考 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EXT-001 | 機器パネルからスキャン投入 | シミュレータ | 未整備 | skillなし | HO-PRT-001 | なし | 該当なし |  |  |  | 2026-09-26 |  |
`,
  'work/_common/prohibited-operations.md': `# 禁止操作リスト

## 禁止操作表

| 禁止ID | 操作 | 適用対象 | 禁止レベル | 制約/許可条件 | 理由 | 備考 |
|---|---|---|---|---|---|---|
| PROH-001 | 印刷ジョブの実行 | 実機:ALL | 条件付き許可 | 1ジョブ10ページ以下 | 紙の消費 |  |
| PROH-002 | 電源断 | 実機:ALL | 禁止 | - | 復旧に人手 |  |
| PROH-003 |  |  |  |  |  |  |

### 記入例(参考)

| 禁止ID | 操作 | 適用対象 | 禁止レベル | 制約/許可条件 | 理由 | 備考 |
|---|---|---|---|---|---|---|
| PROH-009 | サービス停止 | PMS-OS | 要許可 | - | - |  |
`,
  'kb/external-ops/00_操作索引.md': `| 操作ID | 操作名 | 操作対象 | skill名(参考) | 登録日 |
|---|---|---|---|---|
| OP-CLI-001 | クライアントから印刷指示 | CLIENT | pms-print-submit | 2026-09-26 |
`,
  'kb/external-ops/client-print.md': `---
review_status: unreviewed
id: EXT-0001
category: T05
---
# 操作: クライアントから印刷指示(操作ID: OP-CLI-001 / 操作対象: CLIENT)
## 使用する skill(参考情報。正本は skills の機構)
- skill名: pms-print-submit
## 禁止操作リストとの適合
- 該当なし(確認日 2026-09-26)
## 前提条件(観測)
- なし
`,
  // 差し替え版のスクリプト(終了コードだけを返す)
  'tools/build-skills/build-skills.mjs': `console.log('skills_in_sync: OK — stub');\n`,
  'tools/checks/prohibited-ops.mjs': `import fs from 'node:fs';
const code = Number(fs.existsSync(new URL('./stub-exit', import.meta.url)) ? fs.readFileSync(new URL('./stub-exit', import.meta.url), 'utf8') : 0);
console.error(code === 0 ? '禁止操作リストは作業10のときから変わっていません(stub)' : code === 3 ? '禁止操作リストが作業10のあとで変わっています(stub)' : 'status.yaml に prohibited_ops がありません(stub)');
process.exit(code);
`,
};

function makeRepo(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-lint-'));
  for (const f of ['vocab.yaml', '00_common.md', 'stages.md']) {
    const dst = path.join(root, 'procedure', f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(REAL_ROOT, 'procedure', f), dst);
  }
  const files = { ...BASE, ...overrides };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return root;
}

function lint(root, ...args) {
  const r = spawnSync(process.execPath, [path.join(LINT_DIR, 'lint.mjs'), '--root', root, '--json', ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 終了コード2のときは JSON を出さない */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function findings(res, rule) {
  const x = res.json.results.find((r) => r.rule === rule);
  assert.ok(x, `規則 ${rule} の結果がありません`);
  return x.findings.map((f) => `${f.file}: ${f.message}`);
}

function assertHas(list, re) {
  assert.ok(list.some((m) => re.test(m)), `${re} に合う指摘がありません:\n${list.join('\n') || '(指摘なし)'}`);
}

const edit = (rel, from, to) => {
  const s = BASE[rel];
  assert.ok(s.includes(from), `基準の ${rel} に ${from} がありません`);
  return { [rel]: s.replace(from, to) };
};

// ════════════════════════════════════════════════════════

test('基準のリポジトリは全規則を通る(ERROR 0・終了コード 0)', () => {
  const res = lint(makeRepo());
  assert.equal(res.code, 0, res.stdout + res.stderr);
  for (const r of res.json.results) assert.deepEqual(r.findings, [], `${r.rule}: ${JSON.stringify(r.findings)}`);
  // 復元の検査は skill が置かれていないので未実行になる
  assert.ok(res.json.skipped.some((s) => s.rule === 'env_restored'));
});

test('--strict では未実行の規則を ERROR として扱う', () => {
  const res = lint(makeRepo(), '--strict');
  assert.equal(res.code, 1);
});

test('今回の事象: blocked のシナリオでセットアップが抜け、手前のステップと blocked_by が記録されていない', () => {
  const root = makeRepo({
    // setup-log から機器の登録(S-DEVICE-REGISTERED)が抜けた
    ...edit('work/PRT/exploration/setup-log.yaml', /  - state_id: S-DEVICE-REGISTERED[\s\S]*$/.exec(BASE['work/PRT/exploration/setup-log.yaml'])[0], ''),
  });
  // SC-PRT-02 は S1 を記録せず、S2 を blocked_by なしで blocked にした
  const log = BASE['work/PRT/exploration/exploration-log.yaml']
    .replace(/      - step_id: SC-PRT-02-S1\n[\s\S]*?(?=      - step_id: SC-PRT-02-S2)/, '')
    .replace(/        blocked_by:\n          reason: 操作手段なし\n          ext_demand: EXT-001\n          handoff: HO-PRT-001\n          resume_from: SC-PRT-02-S2\n/, '');
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/exploration-log.yaml'), log);
  const res = lint(root, '--flow', 'F-001', '--stage', '10');
  assert.equal(res.code, 1);
  const rc = findings(res, 'requires_covered');
  assertHas(rc, /SC-PRT-01.*S-DEVICE-REGISTERED が F-001 の setup-log にありません/);
  assertHas(rc, /SC-PRT-02.*S-DEVICE-REGISTERED.*blocked でも前提状態は整備して記録する/);
  const br = findings(res, 'blocked_recorded');
  assertHas(br, /SC-PRT-02-S1 が記録されていません/);
  assertHas(br, /SC-PRT-02-S2 に blocked_by がありません/);
});

test('requires_covered: blocked(整備不可)の状態なのにシナリオが passed / established_check なし / requires_setup なし', () => {
  const root = makeRepo({
    ...edit('work/PRT/exploration/setup-log.yaml', '    established_check: 管理メニューが表示される\n', ''),
  });
  let log = BASE['work/PRT/exploration/exploration-log.yaml'].replace("    requires_setup: |\n      S-ADMIN-LOGIN: fixtures/auth.ts#adminLogin で成立を確認\n", '');
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/exploration-log.yaml'), log);
  const setup = fs.readFileSync(path.join(root, 'work/PRT/exploration/setup-log.yaml'), 'utf8')
    .replace('state_id: S-USER-LOGIN\n    classification: built-by-ui', 'state_id: S-USER-LOGIN\n    classification: blocked');
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/setup-log.yaml'), setup);
  const rc = findings(lint(root, '--stage', '10'), 'requires_covered');
  assertHas(rc, /S-USER-LOGIN は setup-log で blocked.*判定が passed/);
  assertHas(rc, /S-ADMIN-LOGIN\(F-001\)の setup-log に established_check がありません/);
  assertHas(rc, /SC-PRT-03.*requires_setup がありません/);
});

test('requires_covered(作業20): コード化したシナリオの fixture のファイル・シンボルがない', () => {
  const root = makeRepo({ 'tests/fixtures/device.ts': null, 'tests/fixtures/auth.ts': 'export const adminLogin = 2;\n' });
  const res = lint(root, '--flow', 'F-001', '--stage', '20');
  const rc = findings(res, 'requires_covered');
  assertHas(rc, /S-DEVICE-REGISTERED の fixture fixtures\/device\.ts#deviceRegistered のファイル tests\/fixtures\/device\.ts がありません/);
  assertHas(rc, /fixture userLogin が tests\/fixtures\/auth\.ts に見つかりません/);
  assert.equal(res.code, 1);
});

test('blocked_recorded: 禁止操作の blocked と blocked_by_prohibition の食い違い・参照の欠落・後続の判定', () => {
  const root = makeRepo({
    ...edit('work/PRT/exploration/status.yaml', 'blocked_by_prohibition: [SC-PRT-03-S3]', 'blocked_by_prohibition: [SC-PRT-09-S1]'),
  });
  const log = BASE['work/PRT/exploration/exploration-log.yaml']
    .replace('          prohibition: PROH-001\n', '')
    .replace('          resume_from: SC-PRT-02-S2\n', '          resume_from: SC-XXX-01-S1\n')
    .replace('      - step_id: SC-PRT-02-S3\n        verdict: blocked\n        blocked_by: { reason: 前ステップが blocked }\n', '      - step_id: SC-PRT-02-S3\n        verdict: passed\n');
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/exploration-log.yaml'), log);
  const br = findings(lint(root, '--stage', '10'), 'blocked_recorded');
  assertHas(br, /「禁止操作」で blocked にした SC-PRT-03-S3 が blocked_by_prohibition にありません/);
  assertHas(br, /blocked_by_prohibition の SC-PRT-09-S1 は、探索記録で「禁止操作」の blocked になっていません/);
  assertHas(br, /SC-PRT-03-S3 の blocked_by に禁止ID/);
  assertHas(br, /resume_from SC-XXX-01-S1 がこのシナリオのステップではありません/);
  assertHas(br, /SC-PRT-02-S3 は blocked のステップ SC-PRT-02-S2 より後なのに判定が passed/);
});

test('status_yaml_valid: 未知のキー・列挙外の値・分岐キーの欠落・理由コードの過不足・env_restore の目的', () => {
  const root = makeRepo({
    ...edit('work/PRT/exploration/status.yaml', 'escalation: none\n', 'escalation: maybe\n  my_new_key: 1\n'),
  });
  let st = fs.readFileSync(path.join(root, 'work/PRT/exploration/status.yaml'), 'utf8')
    .replace('  invariant_violation: none\n', '')
    .replace('判定不能: 0 }', '判定不能: 0, 語彙外操作: 0 }')
    .replace('E2E非効率: 0, ', '')
    .replace('purpose: work10', 'purpose: work20')
    .replace('state: filled', 'state: maybe');
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/status.yaml'), st);
  const sv = findings(lint(root), 'status_yaml_valid');
  assertHas(sv, /context_updates\.escalation の値 maybe/);
  assertHas(sv, /context_updates\.my_new_key は vocab\.context_key にも stages\.md §10 のスロット8にもない/);
  assertHas(sv, /context_updates\.invariant_violation がありません/);
  assertHas(sv, /handoff_by_reason に理由コードが足りません: E2E非効率/);
  assertHas(sv, /handoff_by_reason に vocab\.reason_code にない理由コードがあります: 語彙外操作/);
  assertHas(sv, /env_restore\.purpose は work10/);
  assertHas(sv, /prohibited_ops\.state/);
});

test('status_yaml_valid: 対象フローの作業10の status.yaml がない・前のフローのまま', () => {
  const root = makeRepo({ 'work/PRT/exploration/status.yaml': null });
  assertHas(findings(lint(root, '--flow', 'F-001', '--stage', '10'), 'status_yaml_valid'), /F-001 の探索記録があるのに、作業10の status\.yaml がありません/);
  const root2 = makeRepo();
  const log = BASE['work/PRT/exploration/exploration-log.yaml'] + `---\nfeature_code: PRT\nflow_id: F-002\nscenarios:\n  - id: SC-PRT-01\n    verdict: passed\n    requires_setup: x\n    steps: []\n`;
  fs.writeFileSync(path.join(root2, 'work/PRT/exploration/exploration-log.yaml'), log);
  assertHas(findings(lint(root2, '--flow', 'F-002', '--stage', '10'), 'status_yaml_valid'), /前のフロー\(F-001\)のまま/);
});

test('procedure_version_present: 作業10と作業20で版が違う・書式の誤り', () => {
  const root = makeRepo({ ...edit('work/PRT/codegen/status.yaml', 'procedure_version: proc-v005', 'procedure_version: proc-v006') });
  assertHas(findings(lint(root), 'procedure_version_present'), /F-001 の作業10・15・20で procedure_version が一致しません/);
  const root2 = makeRepo({ ...edit('work/PRT/exploration/status.yaml', 'procedure_version: proc-v005', 'procedure_version: v5') });
  assertHas(findings(lint(root2), 'procedure_version_present'), /書式\(proc-v<3桁>\)に合いません\(v5\)/);
});

test('reason_code_enum: 台帳の節だけを見る(記入例は数えない)・台帳と blocked_by の語彙外', () => {
  const ok = lint(makeRepo());
  assert.deepEqual(findings(ok, 'reason_code_enum'), []);
  const root = makeRepo({ ...edit('work/_common/handoff-register.md', '| 50ページの印刷 | 禁止操作 |', '| 50ページの印刷 | 語彙外操作 |') });
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/exploration-log.yaml'), BASE['work/PRT/exploration/exploration-log.yaml'].replace('reason: 禁止操作', 'reason: 禁止'));
  const rc = findings(lint(root), 'reason_code_enum');
  assertHas(rc, /HO-PRT-002 の理由コード「語彙外操作」/);
  assertHas(rc, /SC-PRT-03-S3 の blocked_by\.reason「禁止」/);
});

test('ext_demand_linked: 申し送りの需要IDなし・存在しない需要ID・申し送りIDの理由違い', () => {
  const root = makeRepo({ ...edit('work/_common/handoff-register.md', 'EXT-001(skill 未整備)', 'skill 未整備') });
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/exploration-log.yaml'),
    BASE['work/PRT/exploration/exploration-log.yaml'].replace('ext_demand: EXT-001', 'ext_demand: EXT-009').replace('handoff: HO-PRT-001', 'handoff: HO-PRT-002'));
  const el = findings(lint(root), 'ext_demand_linked');
  assertHas(el, /HO-PRT-001\(操作手段なし\)の想定手段に需要ID/);
  assertHas(el, /SC-PRT-02-S2 が参照する EXT-009 が外部操作需要リストにありません/);
  assertHas(el, /HO-PRT-002 の理由コードが「操作手段なし」ではありません/);
});

test('operation_registered: 索引にない操作・適合の節がない・禁止の行に該当', () => {
  const root = makeRepo({ ...edit('kb/external-ops/00_操作索引.md', 'OP-CLI-001', 'OP-CLI-002') });
  assertHas(findings(lint(root), 'operation_registered'), /OP-CLI-001 が KB T05 の操作索引に登録されていません/);
  const root2 = makeRepo({ ...edit('kb/external-ops/client-print.md', '## 禁止操作リストとの適合\n- 該当なし(確認日 2026-09-26)\n', '') });
  assertHas(findings(lint(root2), 'operation_registered'), /「禁止操作リストとの適合」の節がありません/);
  const root3 = makeRepo({ ...edit('kb/external-ops/client-print.md', '- 該当なし(確認日 2026-09-26)', '- PROH-002 の範囲(確認日 2026-09-26)') });
  assertHas(findings(lint(root3), 'operation_registered'), /OP-CLI-001 は禁止操作リストの PROH-002\(禁止\)に該当します/);
  // 禁止操作リストが未記入なら、禁止の該当は問わない(禁止操作なしとして扱う)
  const root4 = makeRepo({
    ...edit('kb/external-ops/client-print.md', '- 該当なし(確認日 2026-09-26)', '- PROH-002 の範囲(確認日 2026-09-26)'),
    'work/_common/prohibited-operations.md': '# 禁止操作リスト\n\n## 禁止操作表\n\n| 禁止ID | 操作 | 適用対象 | 禁止レベル | 制約/許可条件 | 理由 | 備考 |\n|---|---|---|---|---|---|---|\n| PROH-001 |  |  |  |  |  |  |\n',
  });
  assert.deepEqual(findings(lint(root4), 'operation_registered'), []);
});

test('no_temp_locator: 探索記録と setup-log の一時ID', () => {
  const root = makeRepo({ ...edit('work/PRT/exploration/setup-log.yaml', "locator: getByLabel('ユーザーID')", 'locator: ref=e12') });
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/exploration-log.yaml'),
    BASE['work/PRT/exploration/exploration-log.yaml'].replace("locator: getByRole('button', { name: '実行' })", 'locator: e15'));
  const nt = findings(lint(root), 'no_temp_locator');
  assertHas(nt, /SC-PRT-01-S2 の locator に snapshot の一時ID が含まれています: e15/);
  assertHas(nt, /S-USER-LOGIN の locator に snapshot の一時ID が含まれています: ref=e12/);
  // 一時IDに見えないもの(e2e など)は指摘しない
  const ok = makeRepo({ ...edit('work/PRT/exploration/setup-log.yaml', "locator: getByLabel('ユーザーID')", "locator: getByText('e2e 印刷')") });
  assert.deepEqual(findings(lint(ok), 'no_temp_locator'), []);
});

test('verdict_enum: 語彙外の判定', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/exploration-log.yaml'), BASE['work/PRT/exploration/exploration-log.yaml'].replace('verdict: human-check', 'verdict: unknown'));
  assertHas(findings(lint(root), 'verdict_enum'), /SC-PRT-03-S2 の verdict「unknown」/);
});

test('prohibition_recheck: 作業20の前は照合スクリプトの終了コードで決める。作業20のあとは prohibition_check を見る', () => {
  const root = makeRepo({ 'tools/checks/stub-exit': '3', 'work/PRT/codegen/status.yaml': null });
  const res = lint(root, '--flow', 'F-001', '--stage', '10');
  assertHas(findings(res, 'prohibition_recheck'), /作業10のパートP/);
  assert.equal(res.code, 1);
  const root2 = makeRepo({ 'tools/checks/stub-exit': '2', 'work/PRT/codegen/status.yaml': null });
  assertHas(findings(lint(root2, '--stage', '10'), 'prohibition_recheck'), /照合できません\(終了コード 2\)/);
  const root3 = makeRepo({ ...edit('work/PRT/codegen/status.yaml', 'prohibition_check: ok\n', '') });
  assertHas(findings(lint(root3), 'prohibition_recheck'), /prohibition_check が ok ではありません/);
});

test('--flow で範囲を絞ると、他のフローの指摘は出ない', () => {
  const root = makeRepo();
  const log = BASE['work/PRT/exploration/exploration-log.yaml'] + `---\nfeature_code: PRT\nflow_id: F-000\nscenarios:\n  - id: SC-PRT-01\n    verdict: nonsense\n`;
  fs.writeFileSync(path.join(root, 'work/PRT/exploration/exploration-log.yaml'), log);
  assert.deepEqual(findings(lint(root, '--flow', 'F-001'), 'verdict_enum'), []);
  assertHas(findings(lint(root), 'verdict_enum'), /F-000/);
});

test('読めない YAML は「成果物の読み取り」の ERROR になる', () => {
  const res = lint(makeRepo({ 'work/PRT/exploration/setup-log.yaml': 'setups:\n  - state_id: A\n     bad: indent\n' }));
  assert.equal(res.code, 1);
  assertHas(findings(res, '(成果物の読み取り)'), /setup-log\.yaml: YAML として読めません/);
});

test('lint 表の「実装:」と実装が食い違うと実行できない(終了コード 2)', () => {
  const root = makeRepo();
  const p = path.join(root, 'procedure/00_common.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('判定値が `vocab.verdict` のいずれか。実装: `tools/lint/lint.mjs`', '判定値が `vocab.verdict` のいずれか'));
  const res = lint(root);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /表に「実装:」がない: verdict_enum/);
});

test('--rule で未実装の規則を指定すると実行できない(終了コード 2)', () => {
  const res = lint(makeRepo(), '--rule', 'vocab_sync');
  assert.equal(res.code, 2);
  assert.match(res.stderr, /未実装/);
});

// ── 健全性シグナル(proc-v007)─────────────────────────────
// SC-PRT-01-S2 で健全性シグナルが出て(作業10)、作業15で解消して追記した状態
function healthRepo({ fix = true, st15 = true, overrides = {} } = {}) {
  const log10 = BASE['work/PRT/exploration/exploration-log.yaml']
    .replace("  - id: SC-PRT-01\n    verdict: passed\n", "  - id: SC-PRT-01\n    verdict: human-check\n")
    .replace("      - step_id: SC-PRT-01-S2\n        verdict: passed\n", "      - step_id: SC-PRT-01-S2\n        verdict: human-check\n        health_signal:\n          kind: 自データの異常状態\n          detail: ジョブが認証エラー\n");
  const fixed = `  - id: SC-PRT-01
    verdict: passed
    health_fix:
      inquiries: 1
      cause: 複合機に認証設定が残っていた
      change: 登録済みのユーザー名で印刷した
      record: health/inquiries/SC-PRT-01-1.md
    requires_setup: |
      S-USER-LOGIN: fixtures/auth.ts#userLogin で成立を確認
      S-DEVICE-REGISTERED: fixtures/device.ts#deviceRegistered で成立を確認
    steps:
      - step_id: SC-PRT-01-S1
        verdict: passed
        verification: 両方
        assertion_hint: x
      - step_id: SC-PRT-01-S2
        verdict: passed
        verification: 両方
        assertion_hint: x
      - step_id: SC-PRT-01-S3
        verdict: passed
        verification: 両方
        assertion_hint: x
`;
  const st10 = BASE['work/PRT/exploration/status.yaml']
    .replace('procedure_version: proc-v005', 'procedure_version: proc-v007')
    .replace('  invariant_violation: none\n', '  invariant_violation: none\n  health_signal: found\n')
    .replace('  codeable_items: [SC-PRT-01]\n', '  codeable_items: []\n  health_signal_items: [SC-PRT-01]\n');
  const s15 = `stage: "15"
flow_id: F-001
feature_code: PRT
procedure_version: proc-v007
outcome: success
stage10_restore_id: RST-20260926-101500-a1b2
context_updates:
  invariant_violation: none
  inquiry_skill: found
  health_outcomes: { SC-PRT-01: ${fix ? 'resolved' : 'unresolved'} }
  inquiries: { SC-PRT-01: 1 }
  codeable_items: [${fix ? 'SC-PRT-01' : ''}]
  env_change_proposed: []
signals_recorded: []
`;
  return makeRepo({
    'work/PRT/exploration/exploration-log.yaml': log10 + (fix ? fixed : ''),
    'work/PRT/exploration/status.yaml': st10,
    'work/PRT/health/status.yaml': st15 ? s15 : null,
    'work/PRT/codegen/status.yaml': null,
    ...overrides,
  });
}

test('health_recorded: 作業10の健全性シグナルと作業15の解消の記録が整っていれば通る(--stage 10 / 15)', () => {
  const root = healthRepo();
  for (const stage of ['10', '15']) {
    const res = lint(root, '--flow', 'F-001', '--stage', stage);
    assert.equal(res.code, 0, res.stdout + res.stderr);
  }
  // 解消しなかった場合(追記なし・unresolved)も通る
  const res2 = lint(healthRepo({ fix: false }), '--flow', 'F-001', '--stage', '15');
  assert.equal(res2.code, 0, res2.stdout + res2.stderr);
});

test('health_recorded: 健全性シグナルのあるステップを passed にした・種類が語彙外・health_fix に signal が残る', () => {
  const root = healthRepo();
  const p = path.join(root, 'work/PRT/exploration/exploration-log.yaml');
  let log = fs.readFileSync(p, 'utf8')
    .replace("        verdict: human-check\n        health_signal:\n          kind: 自データの異常状態", "        verdict: passed\n        health_signal:\n          kind: なんとなく変")
    .replace("      - step_id: SC-PRT-01-S3\n        verdict: passed\n        verification: 両方\n        assertion_hint: x\n", "      - step_id: SC-PRT-01-S3\n        verdict: passed\n        health_signal: { kind: エラー表示, detail: 警告 }\n        verification: 両方\n        assertion_hint: x\n");
  fs.writeFileSync(p, log);
  const res = lint(root, '--flow', 'F-001', '--stage', '15');
  assert.equal(res.code, 1);
  const hr = findings(res, 'health_recorded');
  assertHas(hr, /health_fix の付いた記録に health_signal があります/);
  assertHas(hr, /SC-PRT-01-S3 は健全性シグナルがあるのに判定が passed/);
  // 解消していない(作業10の記録が最新の)場合は、その記録の種類と判定を見る
  const root2 = healthRepo({ fix: false });
  const p2 = path.join(root2, 'work/PRT/exploration/exploration-log.yaml');
  fs.writeFileSync(p2, fs.readFileSync(p2, 'utf8').replace('kind: 自データの異常状態', 'kind: なんとなく変').replace("        verdict: human-check\n        health_signal:", "        verdict: passed\n        health_signal:"));
  const hr2 = findings(lint(root2, '--flow', 'F-001', '--stage', '10'), 'health_recorded');
  assertHas(hr2, /health_signal\.kind「なんとなく変」が vocab\.health_signal_kind/);
  assertHas(hr2, /SC-PRT-01-S2 は健全性シグナルがあるのに判定が passed/);
});

test('health_recorded: 作業10の status.yaml の health_signal・health_signal_items が記録と食い違う', () => {
  const root = healthRepo({ fix: false, st15: false });
  const p = path.join(root, 'work/PRT/exploration/status.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('health_signal: found', 'health_signal: none').replace('health_signal_items: [SC-PRT-01]', 'health_signal_items: [SC-PRT-03]'));
  const hr = findings(lint(root, '--flow', 'F-001', '--stage', '10'), 'health_recorded');
  assertHas(hr, /health_signal が none なのに/);
  assertHas(hr, /SC-PRT-01 が health_signal_items にありません/);
  assertHas(hr, /health_signal_items の SC-PRT-03 は、探索記録に健全性シグナルがありません/);
});

test('health_recorded / status_yaml_valid: 作業15の status.yaml の不備(解消していない codeable・上限超え・stage10_restore_id なし)', () => {
  const root = healthRepo({ fix: false });
  const p = path.join(root, 'work/PRT/health/status.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('codeable_items: []', 'codeable_items: [SC-PRT-01]').replace('SC-PRT-01: 1 }', 'SC-PRT-01: 4 }'));
  const res = lint(root, '--flow', 'F-001', '--stage', '15');
  const hr = findings(res, 'health_recorded');
  assertHas(hr, /codeable_items の SC-PRT-01 の最新の記録が、health_fix の付いた passed ではありません/);
  assertHas(hr, /SC-PRT-01 の問い合わせが 4 回です/);
  const root2 = healthRepo();
  const p2 = path.join(root2, 'work/PRT/health/status.yaml');
  fs.writeFileSync(p2, fs.readFileSync(p2, 'utf8').replace('stage10_restore_id: RST-20260926-101500-a1b2\n', ''));
  assertHas(findings(lint(root2, '--flow', 'F-001', '--stage', '15'), 'status_yaml_valid'), /stage10_restore_id がありません/);
});

test('status_yaml_valid: proc-v007 以降の作業10は health_signal が必須(それより前の版では求めない)', () => {
  const root = makeRepo({ ...edit('work/PRT/exploration/status.yaml', 'procedure_version: proc-v005', 'procedure_version: proc-v007'), 'work/PRT/codegen/status.yaml': null });
  const sv = findings(lint(root, '--flow', 'F-001', '--stage', '10'), 'status_yaml_valid');
  assertHas(sv, /context_updates\.health_signal がありません/);
  assertHas(sv, /health_signal_items がありません/);
  assert.deepEqual(findings(lint(makeRepo(), '--flow', 'F-001', '--stage', '10'), 'status_yaml_valid'), []);
});

test('status_yaml_valid: proc-v008 以降の作業10・20は pre_stage(開始前シナリオの記録)が必須', () => {
  const v8 = (rel) => edit(rel, 'procedure_version: proc-v005', 'procedure_version: proc-v008');
  const root = makeRepo({ ...v8('work/PRT/exploration/status.yaml'), ...v8('work/PRT/codegen/status.yaml') });
  const sv = findings(lint(root), 'status_yaml_valid');
  assertHas(sv, /exploration\/status\.yaml: pre_stage がありません/);
  assertHas(sv, /codegen\/status\.yaml: pre_stage がありません/);
  const p = path.join(root, 'work/PRT/codegen/status.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('prohibition_check: ok\n', 'prohibition_check: ok\npre_stage: { state: failed, run_id: PRE-1 }\n'));
  const sv2 = findings(lint(root), 'status_yaml_valid');
  assertHas(sv2, /pre_stage\.state は skipped \/ passed \/ warning/);
  assertHas(sv2, /pre_stage\.run_id がない、または書式/);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('pre_stage: { state: failed, run_id: PRE-1 }', 'pre_stage: { state: skipped, run_id: PRE-20260928-101500-ab12 }'));
  assert.ok(!findings(lint(root), 'status_yaml_valid').some((m) => /codegen.*pre_stage/.test(m)));
});

test('status_yaml_valid: proc-v010 以降の作業10・20は environment(検証環境の環境ID)が必須', () => {
  const v10 = (rel) => edit(rel, 'procedure_version: proc-v005', 'procedure_version: proc-v010');
  const root = makeRepo({ ...v10('work/PRT/exploration/status.yaml'), ...v10('work/PRT/codegen/status.yaml') });
  const sv = findings(lint(root), 'status_yaml_valid');
  assertHas(sv, /exploration\/status\.yaml: environment がない/);
  assertHas(sv, /codegen\/status\.yaml: environment がない/);
  for (const rel of ['work/PRT/exploration/status.yaml', 'work/PRT/codegen/status.yaml']) {
    const p = path.join(root, rel);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('procedure_version: proc-v010\n', 'procedure_version: proc-v010\nenvironment: vm01\n'));
  }
  const p = path.join(root, 'work/PRT/exploration/status.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('  kb_t05_registered: [OP-CLI-001]\n', '  kb_t05_registered: [OP-CLI-001]\n  env_keys_added: mfp.a.host\n'));
  const sv2 = findings(lint(root), 'status_yaml_valid');
  assert.ok(!sv2.some((m) => /environment がない/.test(m)), sv2.join('\n'));
  assertHas(sv2, /env_keys_added はリストでなければなりません/);
});

test('status_yaml_valid: proc-v011 以降の作業10は scenario_source(シナリオ策定方式)が必須で、値は vocab の列挙', () => {
  const v11 = (rel) => edit(rel, 'procedure_version: proc-v005', 'procedure_version: proc-v011');
  const root = makeRepo({ ...v11('work/PRT/exploration/status.yaml'), ...v11('work/PRT/codegen/status.yaml') });
  const p = path.join(root, 'work/PRT/exploration/status.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('procedure_version: proc-v011\n', 'procedure_version: proc-v011\nenvironment: vm01\npre_stage: { state: skipped, run_id: PRE-20261002-101500-ab12 }\n'));
  const sv = findings(lint(root, '--flow', 'F-001', '--stage', '10'), 'status_yaml_valid');
  assertHas(sv, /context_updates\.scenario_source がありません/);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('  flow_seq: first\n', '  flow_seq: first\n  scenario_source: from_memory\n'));
  assertHas(findings(lint(root, '--flow', 'F-001', '--stage', '10'), 'status_yaml_valid'), /scenario_source の値 from_memory は manual_usecase \/ legacy_script \/ spec_new_feature \/ none/);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('scenario_source: from_memory', 'scenario_source: legacy_script'));
  const sv3 = findings(lint(root, '--flow', 'F-001', '--stage', '10'), 'status_yaml_valid');
  assert.ok(!sv3.some((m) => /scenario_source/.test(m)), sv3.join('\n'));
  // proc-v010 以前のフローでは求めない(基準のリポジトリは proc-v005)
  assert.ok(!findings(lint(makeRepo(), '--flow', 'F-001', '--stage', '10'), 'status_yaml_valid').some((m) => /scenario_source/.test(m)));
});

const ENV_SHARED = JSON.stringify({ default: 'vm01', environments: { vm01: { attributes: {
  'pms.url': { kind: 'endpoint', value: 'https://pms-test-01.example.local/pms' },
  'pms.user': { kind: 'account', value: 'e2e-user01' },
} } } });
const ENV_LOCAL = JSON.stringify({ environments: { vm01: { attributes: {
  'pms.password': { kind: 'secret', value: 'Zq9!pass-word' },
  'pin.code': { kind: 'secret', value: '1234' },
} } } });

test('env_value_leak / env_value_hardcoded: 設定がなければ OK。基準のリポジトリも OK', () => {
  const res = lint(makeRepo());
  assert.deepEqual(findings(res, 'env_value_leak'), []);
  assert.deepEqual(findings(res, 'env_value_hardcoded'), []);
  const res2 = lint(makeRepo({ 'config/environments.json': ENV_SHARED, 'config/environments.local.json': ENV_LOCAL }));
  assert.equal(res2.code, 0, res2.stdout);
  assert.deepEqual(findings(res2, 'env_value_leak'), []);
});

test('env_value_leak: 秘密情報の値が成果物にあれば ERROR(値は指摘に出さない。短い値は探さない)', () => {
  const root = makeRepo({
    'config/environments.json': ENV_SHARED,
    'config/environments.local.json': ENV_LOCAL,
    'work/PRT/exploration/setup-log.yaml': BASE['work/PRT/exploration/setup-log.yaml'].replace("locator: getByLabel('ユーザーID')", "locator: getByLabel('パスワード')\n        value: Zq9!pass-word"),
    'kb/gotchas/GOT-0001.md': 'PIN は 1234 を入れる\n',
  });
  const res = lint(root);
  assert.equal(res.code, 1);
  const f = findings(res, 'env_value_leak');
  assert.equal(f.length, 1, f.join('\n'));
  assertHas(f, /setup-log\.yaml: 秘密情報\(環境 vm01 の pms\.password\)の値が書かれています/);
  assert.ok(!res.stdout.includes('Zq9!pass-word'), '指摘に値を出さない');
  const note = res.json.results.find((r) => r.rule === 'env_value_leak').notes.join('\n');
  assert.match(note, /6 文字未満の秘密情報 1 件は探していません/);
});

test('env_value_leak: 設定ファイルの形の誤りは ERROR。env_value_hardcoded: テストコードの接続先の直書きは WARNING', () => {
  const bad = lint(makeRepo({ 'config/environments.json': JSON.stringify({ environments: { vm01: { attributes: { 'pms.url': { kind: 'uri', value: 'x' } } } } }) }));
  assertHas(findings(bad, 'env_value_leak'), /kind uri は/);
  const res = lint(makeRepo({
    'config/environments.json': ENV_SHARED,
    'tests/specs/prt/prt.spec.ts': "await page.goto('https://pms-test-01.example.local/pms/login');\n",
  }));
  assert.equal(res.code, 0, '警告だけなら終了コード 0');
  assertHas(findings(res, 'env_value_hardcoded'), /prt\.spec\.ts: 接続先\(環境 vm01 の pms\.url\)の値がそのまま書かれています/);
});
