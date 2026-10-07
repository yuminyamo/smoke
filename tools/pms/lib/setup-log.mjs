// setup-log.mjs — setup-log.yaml(stages.md 付録B)の読み書き
//
// 1つのファイルに複数のフローの文書(--- で区切る)があってよい。pms は対象のフローの文書だけを書き直し、
// ほかのフローの文書は1文字も変えない。同じフローの文書の中では、state_id ごとにエントリを置き換える。

import { readDocs, writeFlowDoc } from './flow-doc.mjs';

/** フローの setup-log のエントリ(なければ []) */
export function readEntries(abs, rel, flow) {
  return readAllEntries(abs, rel).filter((x) => x.flow === flow).map((x) => x.e);
}

/** 全フローのエントリ(流用元を探すため) */
export function readAllEntries(abs, rel) {
  const out = [];
  for (const doc of readDocs(abs, rel)) {
    for (const e of Array.isArray(doc.setups) ? doc.setups : []) {
      if (e && typeof e === 'object') out.push({ flow: e.flow_id ?? doc.flow_id ?? null, e });
    }
  }
  return out;
}

/**
 * フローの文書のエントリを1つ書く(同じ state_id があれば置き換える)。
 * @param {string} abs  setup-log.yaml の絶対パス
 * @param {object} entry 付録B のエントリ
 */
export function upsertEntry(abs, rel, { feature, flow }, entry) {
  writeFlowDoc(abs, rel, flow, (doc) => {
    const setups = Array.isArray(doc?.setups) ? doc.setups : [];
    const at = setups.findIndex((e) => e && e.state_id === entry.state_id);
    if (at >= 0) setups[at] = entry; else setups.push(entry);
    return { feature_code: doc?.feature_code ?? feature, flow_id: flow, setups };
  });
}

/** 1つのエントリ(なければ null) */
export function findEntry(abs, rel, flow, stateId) {
  return readEntries(abs, rel, flow).find((e) => e.state_id === stateId) ?? null;
}
