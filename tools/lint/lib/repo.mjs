// repo.mjs — lint が読む正本と成果物の読み込み(遅延読み込み・キャッシュ)

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, parseYamlDocs } from './yaml-lite.mjs';
import { normalize, headings, tables, tableInSection, isBlank } from './markdown.mjs';

export const STAGES = ['01', '02', '10', '15', '20', '30', '40'];

export class LintSetupError extends Error {}

export class Repo {
  /**
   * @param {string} root リポジトリのルート
   * @param {{flow?: string|null, stage?: string|null}} opts
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.flow = opts.flow ?? null;
    this.stage = opts.stage ?? null;
    this.fileErrors = new Map(); // rel → message(読み取れなかった成果物)
    this.cache = new Map();
  }

  // ── 共通 ───────────────────────────────────────────
  abs(rel) { return path.join(this.root, rel); }
  rel(abs) { return path.relative(this.root, abs).split(path.sep).join('/'); }
  exists(rel) { return fs.existsSync(this.abs(rel)); }
  read(rel) { return normalize(fs.readFileSync(this.abs(rel), 'utf8')); }

  memo(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key);
  }

  /** 成果物の YAML を読む。読めなければ fileErrors に記録して null(複数文書なら配列) */
  yamlDocs(rel) {
    return this.memo(`yaml:${rel}`, () => {
      if (!this.exists(rel)) return null;
      try {
        return parseYamlDocs(this.read(rel));
      } catch (e) {
        this.fileErrors.set(rel, `YAML として読めません — ${e.message}`);
        return null;
      }
    });
  }

  inFlow(flow) { return !this.flow || flow === this.flow; }

  // ── 正本 ───────────────────────────────────────────
  get vocab() {
    return this.memo('vocab', () => {
      const rel = 'procedure/vocab.yaml';
      if (!this.exists(rel)) throw new LintSetupError(`${rel} がありません(--root を確かめてください)`);
      try { return parseYaml(this.read(rel)); } catch (e) { throw new LintSetupError(`${rel} を読めません — ${e.message}`); }
    });
  }

  get procedureVersion() { return this.vocab?.meta?.procedure_version ?? null; }

  /** 00_common.md の lint 表: [{ id, severity, desc }] */
  get ruleTable() {
    return this.memo('ruleTable', () => {
      const rel = 'procedure/00_common.md';
      if (!this.exists(rel)) throw new LintSetupError(`${rel} がありません`);
      const t = tableInSection(this.read(rel), /^■ lint/, 'ルールID');
      if (!t) throw new LintSetupError(`${rel} の ■ lint に規則の表がありません`);
      return t.rows.map((r) => ({
        id: r.obj['ルールID'].replace(/`/g, '').trim(),
        severity: r.obj['重大度'].trim(),
        desc: r.obj['内容'],
      }));
    });
  }

  /**
   * stages.md の各節のスロット8(status.yaml 契約)。
   * @returns {Map<string, {top: Map<string, string[]|null>, context: Map<string, string[]|null>}>}
   *          値は列挙値(「a | b」の形のとき)または null
   */
  get slot8() {
    return this.memo('slot8', () => {
      const rel = 'procedure/stages.md';
      if (!this.exists(rel)) throw new LintSetupError(`${rel} がありません`);
      const lines = this.read(rel).split('\n');
      const hs = headings(lines);
      const out = new Map();
      hs.forEach((h, idx) => {
        const m = h.level === 1 && h.title.match(/^§(\d\d)\s/);
        if (!m) return;
        const next = hs.slice(idx + 1).find((x) => x.level === 1);
        const body = lines.slice(h.line, next ? next.line : lines.length);
        const s8 = body.findIndex((l) => /^##\s+8\.\s*status\.yaml/.test(l));
        if (s8 < 0) return;
        const open = body.findIndex((l, k) => k > s8 && /^```yaml\s*$/.test(l));
        const close = body.findIndex((l, k) => k > open && /^```\s*$/.test(l));
        if (open < 0 || close < 0) return;
        let doc;
        try { doc = parseYaml(body.slice(open + 1, close).join('\n')); } catch (e) {
          throw new LintSetupError(`${rel} §${m[1]} のスロット8の YAML を読めません — ${e.message}`);
        }
        const top = new Map();
        const context = new Map();
        for (const [k, v] of Object.entries(doc ?? {})) {
          if (k === 'context_updates') {
            for (const [ck, cv] of Object.entries(v ?? {})) context.set(ck, enumOf(cv));
          } else top.set(k, enumOf(v));
        }
        out.set(m[1], { top, context });
      });
      return out;
    });
  }

  // ── 成果物 ─────────────────────────────────────────
  /** work/ 直下の機能ディレクトリ(_ で始まるものを除く) */
  get features() {
    return this.memo('features', () => {
      const dir = this.abs('work');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .map((e) => e.name).sort();
    });
  }

  /** work/ 配下の全 status.yaml */
  get statusFiles() {
    return this.memo('status', () => {
      const out = [];
      const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); }
          else if (e.name === 'status.yaml') {
            const rel = this.rel(p);
            const docs = this.yamlDocs(rel);
            const data = docs && docs.length ? docs[0] : null;
            if (docs && docs.length > 1) this.fileErrors.set(rel, 'status.yaml に文書が複数あります(1ファイル1文書にする)');
            const stage = data && data.stage != null ? String(data.stage).padStart(2, '0') : null;
            const feature = rel.match(/^work\/([^/_][^/]*)\//)?.[1] ?? null;
            out.push({ rel, data, stage, flow: data?.flow_id ?? null, feature });
          }
        }
      };
      walk(this.abs('work'));
      return out.sort((a, b) => a.rel.localeCompare(b.rel));
    });
  }

  statusFor(stage, flow) {
    return this.statusFiles.filter((s) => s.stage === stage && (!flow || s.flow === flow));
  }

  /** 探索記録のシナリオ記録(全機能・全フロー。ファイル内の順) */
  get explorationRecords() {
    return this.memo('exp', () => {
      const out = [];
      let order = 0;
      for (const fc of this.features) {
        const rel = `work/${fc}/exploration/exploration-log.yaml`;
        const docs = this.yamlDocs(rel);
        if (!docs) continue;
        docs.forEach((doc) => {
          if (!doc || typeof doc !== 'object') return;
          const list = Array.isArray(doc.scenarios) ? doc.scenarios : [];
          for (const sc of list) {
            if (!sc || typeof sc !== 'object') continue;
            out.push({
              feature: doc.feature_code ?? fc,
              dirFeature: fc,
              file: rel,
              flow: sc.flow_id ?? doc.flow_id ?? null,
              id: sc.id ?? null,
              sc,
              order: order++,
            });
          }
        });
      }
      return out;
    });
  }

  /** 対象フローの、シナリオごとの最新の記録(再探索・再判定で追記されたものは後ろを採る) */
  latestRecords() {
    const map = new Map();
    for (const r of this.explorationRecords) {
      if (!this.inFlow(r.flow)) continue;
      map.set(`${r.flow}\u0000${r.id}`, r);
    }
    return [...map.values()];
  }

  /** 探索記録があるフローの一覧 */
  get flowsWithRecords() {
    return [...new Set(this.explorationRecords.map((r) => r.flow).filter(Boolean))].sort();
  }

  /** setup-log の全エントリ */
  get setupEntries() {
    return this.memo('setup', () => {
      const out = [];
      for (const fc of this.features) {
        const rel = `work/${fc}/exploration/setup-log.yaml`;
        const docs = this.yamlDocs(rel);
        if (!docs) continue;
        docs.forEach((doc) => {
          if (!doc || typeof doc !== 'object') return;
          for (const e of Array.isArray(doc.setups) ? doc.setups : []) {
            if (!e || typeof e !== 'object') continue;
            out.push({ file: rel, feature: fc, flow: e.flow_id ?? doc.flow_id ?? null, e });
          }
        });
      }
      return out;
    });
  }

  /** 進行役 pms の操作の記録(work/<機能>/exploration/act-log.jsonl)の全行: [{file, feature, line, r}] */
  get actRecords() {
    return this.memo('act', () => {
      const out = [];
      for (const fc of this.features) {
        const rel = `work/${fc}/exploration/act-log.jsonl`;
        if (!this.exists(rel)) continue;
        this.read(rel).split('\n').forEach((l, i) => {
          if (!l.trim()) return;
          try { out.push({ file: rel, feature: fc, line: i + 1, r: JSON.parse(l) }); } catch {
            this.fileErrors.set(rel, `${i + 1}行目が JSON として読めません`);
          }
        });
      }
      return out;
    });
  }

  /** 進行役 pms のタスクキュー(work/_flows/F-<番号>/queue.json): Map<フローID, {rel, data}> */
  get flowQueues() {
    return this.memo('queues', () => {
      const out = new Map();
      const dir = this.abs('work/_flows');
      if (!fs.existsSync(dir)) return out;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || !/^F-\d{3}$/.test(e.name)) continue;
        const rel = `work/_flows/${e.name}/queue.json`;
        if (!this.exists(rel)) continue;
        try { out.set(e.name, { rel, data: JSON.parse(this.read(rel)) }); } catch (err) {
          this.fileErrors.set(rel, `JSON として読めません — ${err.message}`);
        }
      }
      return out;
    });
  }

  /** scenarios.md のシナリオ定義: Map<シナリオID, {feature, file, line, requires:string[], requiresFound:boolean, steps:string[]}> */
  get scenarioDefs() {
    return this.memo('scen', () => {
      const out = new Map();
      for (const fc of this.features) {
        const rel = `work/${fc}/scenarios.md`;
        if (!this.exists(rel)) continue;
        const lines = this.read(rel).split('\n');
        const hs = headings(lines);
        hs.forEach((h, idx) => {
          const m = h.title.match(/^(SC-[A-Za-z0-9]+-\d+)\s*[:：]/);
          if (!m) return;
          const next = hs.slice(idx + 1).find((x) => x.level <= h.level);
          const body = lines.slice(h.line + 1, next ? next.line : lines.length);
          let requires = [];
          let requiresFound = false;
          for (const l of body) {
            const rm = l.match(/^\s*[-*]\s*(?:\*\*)?requires(?:\*\*)?\s*[:：]\s*(.*)$/);
            if (rm) {
              requiresFound = true;
              requires = rm[1].split(/[,、]/).map((x) => x.replace(/`/g, '').trim()).filter((x) => x && !isBlank(x) && x !== 'なし');
              break;
            }
          }
          const steps = [];
          for (const t of tables(body)) {
            const col = t.header.find((c) => /^Step\s*ID$/i.test(c) || c === 'ステップID');
            if (!col) continue;
            const ord = t.header.find((c) => c === '順序');
            const rows = t.rows.map((r, k) => ({ id: r.obj[col].replace(/`/g, '').trim(), n: ord ? Number(r.obj[ord]) : NaN, k }))
              .filter((r) => r.id.startsWith(m[1] + '-'));
            if (rows.every((r) => Number.isFinite(r.n))) rows.sort((a, b) => a.n - b.n || a.k - b.k);
            for (const r of rows) if (!steps.includes(r.id)) steps.push(r.id);
          }
          if (!out.has(m[1])) out.set(m[1], { feature: fc, file: rel, line: h.line + 1, requires, requiresFound, steps });
        });
      }
      return out;
    });
  }

  // ── 台帳・KB ───────────────────────────────────────
  /** 申し送り台帳(## 台帳 の表)の記入済みの行 */
  get handoffRows() {
    return this.memo('handoff', () => {
      const rel = 'work/_common/handoff-register.md';
      if (!this.exists(rel)) return { rel, exists: false, rows: [] };
      const t = tableInSection(this.read(rel), '台帳', 'ID');
      const rows = (t?.rows ?? []).filter((r) => !isBlank(r.obj['対象']) || !isBlank(r.obj['理由コード']));
      return { rel, exists: true, rows };
    });
  }

  /** 外部操作需要リスト(## 台帳 の表)の記入済みの行 */
  get extDemandRows() {
    return this.memo('extdemand', () => {
      const rel = 'work/_common/external-op-demand.md';
      if (!this.exists(rel)) return { rel, exists: false, rows: [] };
      const t = tableInSection(this.read(rel), '台帳', '需要ID');
      const rows = (t?.rows ?? []).filter((r) => !isBlank(r.obj['外部操作(業務語)']) || !isBlank(r.obj['操作対象']));
      return { rel, exists: true, rows };
    });
  }

  /** 状態需要リスト(## 台帳 の表)の記入済みの行 */
  get stateDemandRows() {
    return this.memo('statedemand', () => {
      const rel = 'work/_common/state-demand.md';
      if (!this.exists(rel)) return { rel, exists: false, rows: [] };
      const t = tableInSection(this.read(rel), '台帳', '需要ID');
      const rows = (t?.rows ?? []).filter((r) => !isBlank(r.obj['状態ID']) || !isBlank(r.obj['定義(業務語)']));
      return { rel, exists: true, rows };
    });
  }

  /** 禁止操作リスト(## 禁止操作表)の操作欄が記入された行 */
  get prohibitedRows() {
    return this.memo('prohibited', () => {
      const rel = 'work/_common/prohibited-operations.md';
      if (!this.exists(rel)) return { rel, state: 'absent', rows: [] };
      const t = tableInSection(this.read(rel), '禁止操作表', '禁止ID');
      const rows = (t?.rows ?? []).filter((r) => !isBlank(r.obj['操作']));
      return { rel, state: rows.length ? 'filled' : 'unfilled', rows };
    });
  }

  /** KB T05 の操作索引: Set<操作ID>(索引がなければ null) */
  get kbOpsIndex() {
    return this.memo('kbindex', () => {
      const rel = 'kb/external-ops/00_操作索引.md';
      if (!this.exists(rel)) return null;
      const ids = new Set();
      for (const t of tables(this.read(rel).split('\n'))) {
        const col = t.header.find((c) => c.replace(/\s/g, '') === '操作ID');
        if (!col) continue;
        for (const r of t.rows) for (const m of r.obj[col].matchAll(/OP-[A-Z0-9]+-\d{3}/g)) ids.add(m[0]);
      }
      return { rel, ids };
    });
  }

  /** KB T05 の操作のエントリ(ファイルの冒頭5行に操作IDがあるもの) */
  kbOpEntry(opId) {
    const entries = this.memo('kbentries', () => {
      const dir = this.abs('kb/external-ops');
      const out = [];
      if (!fs.existsSync(dir)) return out;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('00_')) continue;
        const rel = `kb/external-ops/${e.name}`;
        const text = this.read(rel);
        const head = text.split('\n').filter((l) => !/^\s*(---)?\s*$/.test(l) && !/^\w+:/.test(l)).slice(0, 5).join('\n');
        out.push({ rel, text, head });
      }
      return out;
    });
    return entries.find((x) => new RegExp(`\\b${opId}\\b`).test(x.head)) ?? null;
  }

  /** 突合表の行: [{file, obj}] */
  get matrixRows() {
    return this.memo('matrix', () => {
      const dir = this.abs('traceability');
      const out = [];
      if (!fs.existsSync(dir)) return out;
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('-matrix.md')).sort()) {
        const rel = `traceability/${f}`;
        for (const t of tables(this.read(rel).split('\n'))) {
          if (!t.header.includes('シナリオID')) continue;
          for (const r of t.rows) out.push({ file: rel, line: r.line, obj: r.obj });
        }
      }
      return out;
    });
  }
}

/** 「a | b | c」の形の値なら列挙値の配列、そうでなければ null */
function enumOf(v) {
  if (typeof v !== 'string' || !v.includes('|')) return null;
  const parts = v.split('|').map((x) => x.trim());
  if (parts.length < 2 || !parts.every((p) => /^[A-Za-z0-9_\-]+$/.test(p))) return null;
  return parts;
}

export function flowNumber(f) {
  const m = String(f ?? '').match(/^F-(\d+)$/);
  return m ? Number(m[1]) : null;
}
