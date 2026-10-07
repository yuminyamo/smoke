// explore-agent.mjs — テスト用の「カードを行うAI」(pms のコマンドだけで、カードの種類ごとに決まったことをする)
//
// test/explore.test.mjs が同じ会話の中のカード(B1 の代わり)として直接呼び、stub-ai-cli.mjs が pms run のセッション(B2)として呼ぶ。
// ステップごとのふるまい:
//   SC-PRT-01-S1  open → fill → click、assert と screenshot。passed(両方)。DISC・申し送り・手順改善シグナル・未登録の非決定値を1件ずつ
//   SC-PRT-01-S2  hover、assert(text)と screenshot。健全性シグナルで human-check
//   SC-PRT-01-S3  操作手段なし で blocked(外部操作需要リストに書く項目)
// setup.build は 操作手段なし で blocked(前提状態が blocked のシナリオを作るため)
// 環境変数 PMS_STUB_AGENT_MODE=none なら何もしない(提出しない)、sleep なら長く眠る(時間切れの確認)。

import fs from 'node:fs';
import path from 'node:path';

export const OUT = {
  'setup.build': () => ({
    result: 'blocked', seqs: [], established_check_seq: null, fragile: [], notes: null,
    blocked: { reason: '操作手段なし', detail: 'テスト用デバイスの登録には機器パネルでのペアリングが要り、使える skill がない', ref: null,
      ext_demand: { operation: '機器パネルでペアリングを承認', target: 'シミュレータ', gap: 'skillなし', alternative: '不明', prohibition: '該当なし' } },
  }),
  'setup.reuse': () => ({ result: 'reused', runs: [{ command: 'npx playwright test tests/specs/auth.spec.ts --workers=1', exit_code: 0, started_at: process.env.PMS_NOW, ended_at: process.env.PMS_NOW }], notes: null }),
  'explore.close': () => ({
    result: 'closed',
    invariants: { 'INV-001': '未実施(課金スキーマ未確認)', 'INV-002': '未実施(課金スキーマ未確認)', 'INV-003': 'pass', 'INV-004': 'pass', 'INV-005': 'pass' },
    violations: [], reflections: [{ operation: 'ログアウトのリンクの見つけ方', target: 'kb', path: 'kb/00_索引.md' }],
    manual_gap: false, handoffs: [], procedure_signals: [], notes: null,
  }),
  'explore.session_close': () => ({
    result: 'checked',
    invariants: { 'INV-001': '未実施(課金スキーマ未確認)', 'INV-002': '未実施(課金スキーマ未確認)', 'INV-003': 'pass', 'INV-004': 'pass', 'INV-005': 'pass' },
    violations: [], notes: null,
  }),
  'report.findings': () => ({
    result: 'written',
    headline: 'SC-PRT-01-S2 でジョブがエラーになる健全性シグナルが出た(作業15で問い合わせる)',
    inputs_note: null,
    open_questions: ['SC-PRT-01-S3 の機器での印刷に使える skill がないため、完了状態の確認ができていない'],
    priority_review: [{ item: 'explore.close の INV-003〜005 の SQL', reason: '誤った INV は偽の失敗を全シナリオに撒くため' }],
    prohibition_proposals: [],
    knowledge_gap: { needed: false, reason: null },
    nd_increment: { needed: true, reason: '未登録の非決定値(ジョブID)があるため' },
    notes: null,
  }),
};

const base = {
  result: 'explored', fragile: [], observed: null, assertion_hint: null, carried_data: {}, nondeterministic: [], wait: null, health_signal: null,
  blocked_by: null, discrepancies: [], handoffs: [], procedure_signals: [], ops_registered: [], evidence: [], notes: null,
};

function step(id, act) {
  if (id.endsWith('-S1')) {
    act(['open', '<env:pms.url>']);
    const a = act(['--intent', '管理者IDを入力', 'fill', 'e3', '<env:pms.admin.user>']).json.seq;
    const b = act(['--intent', '印刷を指示する', 'click', 'e7']).json.seq;
    const c = act(['--intent', '受付を確かめる', 'assert', 'e12', 'visible']).json.seq;
    const d = act(['--intent', '受付の画面', 'screenshot']).json.seq;
    return {
      ...base, verdict: 'passed', seqs: [a, b],
      verification: { method: '両方', screen_seqs: [c], db: { query: "SELECT COUNT(*) FROM PrintJob WHERE JobId = 'JOB-1'", result: '1 件' }, reason: null },
      observed: '受付完了のメッセージが表示され、ジョブID JOB-1 が採番された',
      assertion_hint: "DB: SELECT COUNT(*) FROM PrintJob WHERE JobId = <carried_data.job_id> = 1",
      carried_data: { job_id: 'JOB-1' },
      nondeterministic: [{ value: 'ジョブID', catalog_id: '未登録', strength: null }],
      discrepancies: [{ kind: '実画面≠マニュアル', spec: '記載なし(仕様書3章)', manual: '利用者マニュアル4-2「印刷ボタンを押す」', existing_test: null, actual: '印刷ボタンではなくログインボタンの名前で表示される', evidence_seq: d, assessment: 'ドキュメント不備疑い', notes: null }],
      handoffs: [{ target: '印刷部数に上限値を入れたときの受付の確認', reason: '異常系', means: null }],
      procedure_signals: [{ type: '曖昧', location: 'ST/10/4-C', event: '検証手段 両方 の DB 側の対象テーブルが文書から特定できなかった', impact: '調査1回', response: 'KB の DB 定義から PrintJob を選んだ', proposal: null }],
      evidence: [d],
    };
  }
  if (id.endsWith('-S2')) {
    const a = act(['--intent', '一覧を開く', 'hover', 'e12']).json.seq;
    const c = act(['--intent', '一覧の行を確かめる', 'assert', 'e12', 'text', 'ログアウト']).json.seq;
    const d = act(['--intent', '一覧の画面', 'screenshot']).json.seq;
    return {
      ...base, verdict: 'human-check', seqs: [a],
      verification: { method: '画面', screen_seqs: [c], db: null, reason: null },
      observed: '一覧にジョブは表示されたが、状態がエラーになっている',
      assertion_hint: "画面: ジョブ一覧で JobId = <carried_data.job_id> の行が表示される",
      health_signal: { kind: '自データの異常状態', detail: '投入したジョブの状態がエラー(認証エラー)になっている', observed_at: process.env.PMS_NOW },
      evidence: [d],
    };
  }
  return {
    ...base, verdict: 'blocked', seqs: [], verification: null,
    blocked_by: {
      reason: '操作手段なし', detail: '機器パネルで印刷を実行する操作に使える skill がない', ref: null, handoff: null,
      ext_demand: { operation: '機器パネルから印刷実行', target: 'シミュレータ', gap: 'skillなし', alternative: 'なし', prohibition: '該当なし' },
      resume_from: id,
    },
  };
}

/**
 * @param {{root, flow, card, kind, body, pms}} a  pms(args) は pms を実行して {code, json} を返す
 */
export default async function agent({ root, flow, card, kind, body, pms }) {
  const mode = process.env.PMS_STUB_AGENT_MODE;
  if (mode === 'none') return 'none';
  if (mode === 'sleep') { await new Promise((r) => setTimeout(r, 5000)); return 'slept'; }
  const actf = (args) => pms(['act', '--flow', flow, '--card', card, ...args]);
  let out;
  if (kind === 'explore.step') {
    const id = body.match(/ステップ \*\*(SC-[A-Za-z0-9]+-\d+-S\d+)\*\*/)[1];
    out = step(id, actf);
  } else {
    out = OUT[kind]();
  }
  const file = path.join(root, 'work/_flows', flow, 'out', `${card}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  const r = pms(['submit', '--flow', flow, '--card', card]);
  return { submit: r.code, failures: r.json?.failures ?? null };
}
