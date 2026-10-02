// status.mjs — status.yaml の契約の検査(status_yaml_valid / procedure_version_present)

import { STAGES, flowNumber } from '../lib/repo.mjs';

// 分岐に使うキーのうち、あとの手順版で追加したもの(それより前の版で始めたフローでは求めない)
const KEY_SINCE = { health_signal: 7, scenario_source: 11 }; // scenario_source は作業10のシナリオ策定方式(proc-v011)
// 作業ごとに、あとの版で分岐キーを加えたもの(作業15の escalation は proc-v008)
const STAGE_KEY_SINCE = { '15': { escalation: 8 } };
// 最上位の項目のうち、あとの手順版で追加したもの
const PRE_STAGE_SINCE = 8;
const ENVIRONMENT_SINCE = 10; // 最上位の environment(使った検証環境の環境ID。作業10・15・20)

export function versionNumber(v) {
  const m = String(v ?? '').match(/^proc-v(\d{3})$/);
  return m ? Number(m[1]) : null;
}

/** 範囲(--flow / --stage)に入る status.yaml */
export function statusInScope(repo) {
  return repo.statusFiles.filter((s) => {
    if (repo.stage && s.stage !== repo.stage) return false;
    if (repo.flow) return s.flow === repo.flow;
    return true;
  });
}

export function status_yaml_valid(repo) {
  const findings = [];
  const add = (file, message) => findings.push({ file, message });
  const vocab = repo.vocab;
  const ctxVocab = vocab.context_key ?? {};
  const reasonKeys = Object.keys(vocab.reason_code ?? {});

  for (const s of statusInScope(repo)) {
    const d = s.data;
    if (!d) continue; // 読めないファイルは fileErrors で報告される
    if (typeof d !== 'object' || Array.isArray(d)) { add(s.rel, 'status.yaml の最上位がマッピングではありません'); continue; }
    if (!s.stage || !STAGES.includes(s.stage)) { add(s.rel, `stage が不正です(${d.stage ?? 'なし'})。${STAGES.join(' / ')} のいずれか`); continue; }
    const slot = repo.slot8.get(s.stage);
    if (!slot) { add(s.rel, `stages.md に §${s.stage} のスロット8(status.yaml 契約)が見つからないため検査できません`); continue; }

    // outcome
    const outcomeEnum = slot.top.get('outcome') ?? ctxVocab.outcome;
    if (d.outcome == null) add(s.rel, 'outcome がありません');
    else if (Array.isArray(outcomeEnum) && !outcomeEnum.includes(String(d.outcome))) add(s.rel, `outcome の値 ${d.outcome} は ${outcomeEnum.join(' / ')} のいずれかでなければなりません`);

    // 作業10・20の最上位の必須項目
    if (s.stage === '10' || s.stage === '20') {
      if (!/^F-\d{3}$/.test(String(d.flow_id ?? ''))) add(s.rel, `flow_id がない、または書式(F-<3桁>)に合いません(${d.flow_id ?? 'なし'})`);
      if (d.feature_code == null || d.feature_code === '') add(s.rel, 'feature_code がありません');
      const er = d.env_restore;
      if (!er || typeof er !== 'object') add(s.rel, 'env_restore がありません(工程0の復元の記録。00 ■status.yaml 契約 6)');
      else {
        if (!er.restore_id) add(s.rel, 'env_restore.restore_id がありません');
        const want = `work${s.stage}`;
        if (er.purpose !== want) add(s.rel, `env_restore.purpose は ${want} でなければなりません(${er.purpose ?? 'なし'})`);
        if (!['auto', 'human'].includes(String(er.readiness))) add(s.rel, `env_restore.readiness は auto / human のいずれかでなければなりません(${er.readiness ?? 'なし'})`);
      }
      const v = versionNumber(d.procedure_version);
      if (v === null || v >= PRE_STAGE_SINCE) {
        const ps = d.pre_stage;
        const ok = Object.keys(vocab.pre_stage_state ?? {}).filter((k) => k !== 'failed');
        if (!ps || typeof ps !== 'object') add(s.rel, 'pre_stage がありません(工程0の開始前シナリオの記録。設定がなければ state: skipped。00 ■status.yaml 契約 6)');
        else {
          if (!ok.includes(String(ps.state))) add(s.rel, `pre_stage.state は ${ok.join(' / ')} のいずれかでなければなりません(${ps.state ?? 'なし'}。failed のときは作業を始めない)`);
          if (!/^PRE-\d{8}-\d{6}-[0-9a-f]{4}$/.test(String(ps.run_id ?? ''))) add(s.rel, `pre_stage.run_id がない、または書式(PRE-<日時>-<識別子>)に合いません(${ps.run_id ?? 'なし'})`);
        }
      }
    }
    if (s.stage === '10' || s.stage === '15' || s.stage === '20') {
      const v = versionNumber(d.procedure_version);
      if (v === null || v >= ENVIRONMENT_SINCE) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(d.environment ?? ''))) {
          add(s.rel, `environment がない、または環境IDの書式に合いません(${d.environment ?? 'なし'})。使った検証環境の環境ID(node tools/env/env.mjs require の出力の env)を書く。00 ■status.yaml 契約 9`);
        }
      }
    }
    if (s.stage === '15') {
      if (!/^F-\d{3}$/.test(String(d.flow_id ?? ''))) add(s.rel, `flow_id がない、または書式(F-<3桁>)に合いません(${d.flow_id ?? 'なし'})`);
      if (d.feature_code == null || d.feature_code === '') add(s.rel, 'feature_code がありません');
      if (!d.stage10_restore_id) add(s.rel, 'stage10_restore_id がありません(どの作業10のあとに実施したか。00 ■status.yaml 契約 8)');
      if (d.env_restore) add(s.rel, 'env_restore があります(作業15は環境を復元しない)');
    }
    if (s.stage === '10') {
      const po = d.prohibited_ops;
      const states = Object.keys(vocab.prohibited_ops_state ?? {});
      if (!po || typeof po !== 'object') add(s.rel, 'prohibited_ops がありません(工程0のあとの禁止操作リストの記録。00 ■status.yaml 契約 7)');
      else {
        if (!states.includes(String(po.state))) add(s.rel, `prohibited_ops.state は ${states.join(' / ')} のいずれかでなければなりません(${po.state ?? 'なし'})`);
        if (!po.digest) add(s.rel, 'prohibited_ops.digest がありません');
      }
    }

    // context_updates
    const cu = d.context_updates;
    if (!cu || typeof cu !== 'object' || Array.isArray(cu)) { add(s.rel, 'context_updates がない、またはマッピングではありません'); continue; }
    for (const [k, v] of Object.entries(cu)) {
      const inVocab = Object.prototype.hasOwnProperty.call(ctxVocab, k);
      const inSlot = slot.context.has(k);
      if (!inVocab && !inSlot) {
        add(s.rel, `context_updates.${k} は vocab.context_key にも stages.md §${s.stage} のスロット8にもないキーです`);
        continue;
      }
      const en = (inSlot && slot.context.get(k)) || (Array.isArray(ctxVocab[k]) ? ctxVocab[k] : null);
      if (en && !(v != null && en.includes(String(v)))) add(s.rel, `context_updates.${k} の値 ${fmt(v)} は ${en.join(' / ')} のいずれかでなければなりません`);
    }
    if ('env_keys_added' in cu && !Array.isArray(cu.env_keys_added)) add(s.rel, 'context_updates.env_keys_added はリストでなければなりません(キー名だけを書く。値は書かない)');
    // 分岐に使うキー(vocab.context_key にあり、スロット8が列挙値で定めるもの)は必須
    const ver = versionNumber(d.procedure_version);
    for (const [k, en] of slot.context) {
      const since = STAGE_KEY_SINCE[s.stage]?.[k] ?? KEY_SINCE[k];
      if (since && ver !== null && ver < since) continue;
      if (en && Object.prototype.hasOwnProperty.call(ctxVocab, k) && !(k in cu)) add(s.rel, `context_updates.${k} がありません(pipeline.dot の分岐に使うキー)`);
    }
    if (s.stage === '15') {
      if (!('codeable_items' in cu)) add(s.rel, 'context_updates.codeable_items がありません(該当がなければ [] と書く)');
      else if (!Array.isArray(cu.codeable_items)) add(s.rel, 'context_updates.codeable_items はリストでなければなりません');
      const ho = cu.health_outcomes;
      const outcomes = Object.keys(vocab.health_outcome ?? {});
      if (ho == null) add(s.rel, 'context_updates.health_outcomes がありません(対象がなければ {} と書く)');
      else if (typeof ho !== 'object' || Array.isArray(ho)) add(s.rel, 'context_updates.health_outcomes はマッピングでなければなりません');
      else for (const [id, v] of Object.entries(ho)) {
        if (!outcomes.includes(String(v))) add(s.rel, `context_updates.health_outcomes.${id} の値 ${fmt(v)} は ${outcomes.join(' / ')} のいずれかでなければなりません`);
      }
    }
    if (s.stage === '10' && !(ver !== null && ver < KEY_SINCE.health_signal)) {
      if (!('health_signal_items' in cu)) add(s.rel, 'context_updates.health_signal_items がありません(該当がなければ [] と書く)');
      else if (!Array.isArray(cu.health_signal_items)) add(s.rel, 'context_updates.health_signal_items はリストでなければなりません');
    }
    if (s.stage === '10') {
      for (const k of ['codeable_items', 'blocked_by_prohibition']) {
        if (!(k in cu)) add(s.rel, `context_updates.${k} がありません(該当がなければ [] と書く)`);
        else if (!Array.isArray(cu[k])) add(s.rel, `context_updates.${k} はリストでなければなりません`);
      }
      const hb = cu.handoff_by_reason;
      if (hb == null) add(s.rel, 'context_updates.handoff_by_reason がありません(vocab.reason_code の全キーを出す)');
      else if (typeof hb !== 'object' || Array.isArray(hb)) add(s.rel, 'context_updates.handoff_by_reason はマッピングでなければなりません');
      else {
        const missing = reasonKeys.filter((r) => !(r in hb));
        const extra = Object.keys(hb).filter((r) => !reasonKeys.includes(r));
        if (missing.length) add(s.rel, `context_updates.handoff_by_reason に理由コードが足りません: ${missing.join(', ')}`);
        if (extra.length) add(s.rel, `context_updates.handoff_by_reason に vocab.reason_code にない理由コードがあります: ${extra.join(', ')}`);
      }
    }
    // 最上位の未知のキーは検査しない(規則の対象は context_updates のキー)
  }

  // 存在の検査: 対象フローの探索記録がある機能に、そのフローの作業10の status.yaml があること
  if (repo.flow && (!repo.stage || repo.stage === '10')) {
    const features = [...new Set(repo.explorationRecords.filter((r) => r.flow === repo.flow).map((r) => r.dirFeature))];
    for (const fc of features) {
      const rel = `work/${fc}/exploration/status.yaml`;
      const st = repo.statusFiles.find((s) => s.rel === rel);
      if (!st) { add(rel, `${repo.flow} の探索記録があるのに、作業10の status.yaml がありません`); continue; }
      if (!st.data) continue;
      const n = flowNumber(st.flow);
      const want = flowNumber(repo.flow);
      if (n !== null && want !== null && n < want) add(rel, `status.yaml が前のフロー(${st.flow})のままです。${repo.flow} の作業10が status.yaml を出力していません`);
    }
  }
  if (repo.flow && repo.stage && repo.statusFor(repo.stage, repo.flow).length === 0) {
    add('work/', `${repo.flow} の作業${repo.stage}の status.yaml が見つかりません`);
  }
  return { findings };
}

export function procedure_version_present(repo) {
  const findings = [];
  const add = (file, message) => findings.push({ file, message });
  const re = /^proc-v\d{3}$/;
  for (const s of statusInScope(repo)) {
    const d = s.data;
    if (!d || typeof d !== 'object') continue;
    if (s.stage === '40' && d.procedure_version == null) {
      for (const k of ['procedure_version_before', 'procedure_version_after']) {
        if (!re.test(String(d[k] ?? ''))) add(s.rel, `${k} がない、または書式(proc-v<3桁>)に合いません(${d[k] ?? 'なし'})`);
      }
      continue;
    }
    if (!re.test(String(d.procedure_version ?? ''))) add(s.rel, `procedure_version がない、または書式(proc-v<3桁>)に合いません(${d.procedure_version ?? 'なし'})`);
  }
  // 同一フローの作業10・15・20で一致すること(フローごとに、範囲の stage 指定によらず全部を見る)
  const FLOW_STAGES = ['10', '15', '20'];
  const flows = new Set(repo.statusFiles.filter((s) => FLOW_STAGES.includes(s.stage) && s.flow && repo.inFlow(s.flow)).map((s) => s.flow));
  for (const f of [...flows].sort()) {
    const list = repo.statusFiles.filter((s) => s.flow === f && FLOW_STAGES.includes(s.stage) && s.data?.procedure_version);
    const versions = [...new Set(list.map((s) => String(s.data.procedure_version)))];
    if (versions.length > 1) {
      add(list.map((s) => s.rel).join(', '), `${f} の作業10・15・20で procedure_version が一致しません(${list.map((s) => `作業${s.stage}: ${s.data.procedure_version}`).join(' / ')})。1フローは1つの版で実行する`);
    }
  }
  return { findings };
}

function fmt(v) {
  if (v === null || v === undefined) return '(なし)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
