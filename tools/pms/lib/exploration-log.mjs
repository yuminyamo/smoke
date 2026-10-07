// exploration-log.mjs — exploration-log.yaml(stages.md 付録A)の読み書き(proc-v018 以降、パートCの記録は pms が書く)
//
// フローごとの文書(--- で区切る)に、シナリオの記録を置く。同じフローの中で同じシナリオを探索し直したとき
// (パートPの recheck_of・再探索の reexplore_of)は、印の違う記録として後ろに足し、前の記録は消さない。

import { readDocs, writeFlowDoc } from './flow-doc.mjs';

// シナリオの記録の欄の順(付録A)
const SC_KEYS = ['id', 'verdict', 'reexplore_of', 'recheck_of', 'requires_setup', 'carried_data', 'steps', 'invariants', 'discrepancies', 'manual_gap'];
// ステップの記録の欄の順(付録A)
const STEP_KEYS = ['step_id', 'verdict', 'started_at', 'ended_at', 'actions', 'verification', 'verified_by', 'assertion_hint', 'nondeterministic',
  'wait', 'health_signal', 'observed', 'evidence', 'blocked_by', 'notes', 'act'];

function ordered(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out) && obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}

export function orderStep(step) { return ordered(step, STEP_KEYS); }

/** 記録の印(同じフローの中で、どの探索の記録か) */
export function sameTag(sc, tag) {
  return (sc.recheck_of ?? null) === (tag.recheck_of ?? null) && (sc.reexplore_of ?? null) === (tag.reexplore_of ?? null);
}

/** フローの文書のシナリオの記録(なければ []) */
export function readScenarios(abs, rel, flow) {
  const out = [];
  for (const doc of readDocs(abs, rel)) {
    for (const sc of Array.isArray(doc.scenarios) ? doc.scenarios : []) {
      if (sc && typeof sc === 'object' && (sc.flow_id ?? doc.flow_id) === flow) out.push(sc);
    }
  }
  return out;
}

/**
 * シナリオの記録を1つ書き直す(なければ足す)。
 * @param {{feature, flow, environment, date}} head 文書の先頭の欄(既にあれば explored_at・environment は変えない)
 * @param {{id, recheck_of?, reexplore_of?}} tag
 * @param {(sc: object|null) => object} mutate
 */
export function upsertScenario(abs, rel, head, tag, mutate) {
  writeFlowDoc(abs, rel, head.flow, (doc) => {
    const scenarios = Array.isArray(doc?.scenarios) ? doc.scenarios : [];
    const at = scenarios.findIndex((sc) => sc && sc.id === tag.id && sameTag(sc, tag));
    const cur = at >= 0 ? scenarios[at] : null;
    const next = ordered(mutate(cur ? { ...cur } : null), SC_KEYS);
    if (at >= 0) scenarios[at] = next; else scenarios.push(next);
    return {
      feature_code: doc?.feature_code ?? head.feature,
      flow_id: head.flow,
      explored_at: doc?.explored_at ?? head.date,
      environment: doc?.environment ?? head.environment ?? '',
      scenarios,
    };
  });
}

/**
 * シナリオの判定(ステップの判定から機械的に決める。stages.md §10 パートC):
 * failed が1つでもあれば failed、なければ blocked があれば blocked、なければ human-check があれば human-check、どれもなければ passed
 */
export function scenarioVerdict(steps) {
  const v = new Set((steps ?? []).map((s) => s?.verdict));
  if (v.has('failed')) return 'failed';
  if (v.has('blocked')) return 'blocked';
  if (v.has('human-check')) return 'human-check';
  return 'passed';
}
