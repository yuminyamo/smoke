// procedure.mjs — 手順書の正本(procedure/)から pms が読むもの: vocab・規則ID の行・保護ブロック・カードのテンプレート・出力の schema

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../../lint/lib/yaml-lite.mjs';
import { readText, readJson, UsageError } from './util.mjs';
import { schemaTable, vocabValues } from './schema.mjs';

// 規則IDの書式(vocab.id_format.rule)。原本の行には **[R-LOC-1]** の形で付ける
export const RULE_ID_RE = /\*\*\[(R-[A-Z]+-\d+)\]\*\*/g;
const RULE_SOURCES = ['procedure/00_common.md', 'procedure/stages.md'];

export class Procedure {
  constructor(root) {
    this.root = root;
    this.cache = new Map();
  }

  memo(k, fn) { if (!this.cache.has(k)) this.cache.set(k, fn()); return this.cache.get(k); }

  read(rel) {
    const abs = path.join(this.root, rel);
    if (!fs.existsSync(abs)) throw new UsageError(`${rel} がありません(--root を確かめてください)`);
    return readText(abs);
  }

  get vocab() {
    return this.memo('vocab', () => {
      try { return parseYaml(this.read('procedure/vocab.yaml')); } catch (e) {
        if (e instanceof UsageError) throw e;
        throw new UsageError(`procedure/vocab.yaml を読めません — ${e.message}`);
      }
    });
  }

  get version() { return this.vocab?.meta?.procedure_version ?? null; }

  values(key) { return vocabValues(this.vocab, key) ?? []; }

  /** 規則ID → { id, file, line, text }(原本の1行) */
  get rules() {
    return this.memo('rules', () => {
      const out = new Map();
      for (const rel of RULE_SOURCES) {
        const lines = this.read(rel).split('\n');
        lines.forEach((l, i) => {
          for (const m of l.matchAll(RULE_ID_RE)) {
            if (out.has(m[1])) throw new UsageError(`規則ID ${m[1]} が2箇所にあります(${out.get(m[1]).file}:${out.get(m[1]).line} と ${rel}:${i + 1})`);
            out.set(m[1], { id: m[1], file: rel, line: i + 1, text: l });
          }
        });
      }
      return out;
    });
  }

  /** カードに差し込む規則の1行(行頭の箇条書きの記号と規則IDの目印を外し、[規則ID] を前に付ける) */
  rule(id) {
    const r = this.rules.get(id);
    if (!r) throw new UsageError(`規則ID ${id} が ${RULE_SOURCES.join('・')} にありません(カードのテンプレートの誤り)`);
    let t = r.text.trim();
    if (t.startsWith('|')) {
      // 表の行: 1列目を見出しにして、残りの列をつなぐ
      const cells = t.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()).filter(Boolean);
      t = `${cells[0]}: ${cells.slice(1).join(' / ')}`;
    }
    t = t.replace(/^(?:[-*]|\d+\.)\s+/, '').replace(new RegExp(`\\*\\*\\[${id}\\]\\*\\*\\s*`), '').trim();
    return `- [${id}] ${t}`;
  }

  /** 保護ブロックの本文(目印の行を除く。文言は変えない)。00_common.md・stages.md の順に探す */
  protectedBlock(id) {
    for (const rel of RULE_SOURCES) {
      const lines = this.read(rel).split('\n');
      const s = lines.findIndex((l) => l.trim() === `<!-- protected:${id} -->`);
      if (s < 0) continue;
      const e = lines.findIndex((l, i) => i > s && l.trim() === `<!-- /protected:${id} -->`);
      if (e < 0) throw new UsageError(`${rel} の保護ブロック ${id} に終わりの目印がありません`);
      return `<!-- 保護ブロック ${id}(${rel} から文言を変えずに引用)-->\n${lines.slice(s + 1, e).join('\n').trim()}`;
    }
    throw new UsageError(`保護ブロック ${id} が ${RULE_SOURCES.join('・')} にありません(カードのテンプレートの誤り)`);
  }

  /** vocab のマッピングを箇条書きにする(値が文字列ならその意味、オブジェクトなら meaning) */
  vocabList(key) {
    let node = this.vocab;
    for (const k of key.split('.')) node = node?.[k];
    if (!node || typeof node !== 'object') throw new UsageError(`vocab.${key} がありません(カードのテンプレートの誤り)`);
    if (Array.isArray(node)) return node.map((v) => `- \`${v}\``).join('\n');
    return Object.entries(node).map(([k, v]) => {
      const meaning = typeof v === 'string' ? v : v?.meaning ?? '';
      return `- \`${k}\`${meaning ? `: ${meaning}` : ''}`;
    }).join('\n');
  }

  template(kind) { return this.read(`procedure/cards/${kind}.md`); }

  schema(kind) {
    const rel = `procedure/schemas/${kind}.out.json`;
    return this.memo(`schema:${kind}`, () => readJson(path.join(this.root, rel), rel));
  }

  /**
   * カードの本文を作る。テンプレートの差し込み:
   *   {{名前}} — vars の値 / {{rule:R-XXX-n}} — 規則の行 / {{protected:ID}} — 保護ブロック /
   *   {{vocab:キー}} — 統制語彙の一覧 / {{schema}} — 出力の各欄の許される値の表
   */
  render(kind, vars) {
    const text = this.template(kind).replace(/\{\{([^{}]+)\}\}/g, (all, expr) => {
      const [op, arg] = expr.includes(':') ? [expr.slice(0, expr.indexOf(':')), expr.slice(expr.indexOf(':') + 1)] : [null, expr];
      if (op === 'rule') return this.rule(arg.trim());
      if (op === 'protected') return this.protectedBlock(arg.trim());
      if (op === 'vocab') return this.vocabList(arg.trim());
      if (op === null && arg.trim() === 'schema') return schemaTable(this.schema(kind), this.vocab);
      if (op === null && arg.trim() in vars) return String(vars[arg.trim()] ?? '');
      throw new UsageError(`カードのテンプレート procedure/cards/${kind}.md の ${all} を埋められません`);
    });
    return text.replace(/\n{3,}/g, '\n\n');
  }
}
