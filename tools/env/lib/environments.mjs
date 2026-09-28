// environments.mjs — 検証環境の情報(00_common.md ■検証環境の情報)の読み込み・検査・書き込み。
//
// 設定ファイル(どちらも同じ形。ない場合は空として扱う):
//   config/environments.json        共有(git に入れる)。秘密でない値
//   config/environments.local.json  各自(git に入れない。config/.gitignore)。秘密情報と、各自の上書き
//
//   {
//     "default": "vm01",                            既定の環境ID(local の default が優先)
//     "environments": {
//       "vm01": {
//         "description": "検証環境1",
//         "attributes": {
//           "pms.url": { "kind": "endpoint", "value": "https://…", "description": "…" },
//           "mfp.a.host": "192.0.2.10"              文字列だけでも書ける(kind は other として扱う)
//         }
//       }
//     }
//   }
//
// 環境の選び方(先に決まったもの): --env → 環境変数 PMS_ENV → local の default → 共有の default
//   → 環境が1つだけならそれ。属性は環境ごとに local が共有を上書きする(value・kind・description を項目ごとに)。
// 「_」で始まる項目は注記として読み飛ばす。
// 依存: Node.js 18 以上のみ(vocab.yaml の読み取りに tools/lint/lib/yaml-lite.mjs を使う)。

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../../lint/lib/yaml-lite.mjs';

export const SHARED_FILE = 'config/environments.json';
export const LOCAL_FILE = 'config/environments.local.json';
export const ENV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const KEY_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;
export const FALLBACK_KINDS = ['endpoint', 'account', 'secret', 'other'];

export class EnvError extends Error {}

/** vocab.yaml の env_attr_kind(属性の種類)と env_base_keys(基本キー) */
export function readVocab(root) {
  const rel = 'procedure/vocab.yaml';
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return { kinds: FALLBACK_KINDS, baseKeys: {} };
  let v;
  try { v = parseYaml(fs.readFileSync(p, 'utf8')); } catch (e) { throw new EnvError(`${rel} を読めません — ${e.message}`); }
  const kinds = Object.keys(v?.env_attr_kind ?? {});
  const baseKeys = {};
  for (const [k, def] of Object.entries(v?.env_base_keys ?? {})) {
    baseKeys[k] = { kind: String(def?.kind ?? 'other'), description: def?.description != null ? String(def.description) : '' };
  }
  return { kinds: kinds.length ? kinds : FALLBACK_KINDS, baseKeys };
}

/** 1つの設定ファイルを読む。ない場合は null */
export function readFile(root, rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  if (text.trim() === '') return {};
  try { return JSON.parse(text); } catch (e) { throw new EnvError(`${rel} を JSON として読めません — ${e.message}`); }
}

/** 設定ファイルの形を検査する。問題の一覧(文字列)を返す */
export function validate(data, rel, kinds) {
  const errs = [];
  if (data == null) return errs;
  if (typeof data !== 'object' || Array.isArray(data)) return [`${rel}: 最上位がオブジェクトではありません`];
  for (const k of Object.keys(data)) {
    if (k.startsWith('_') || k === 'default' || k === 'environments') continue;
    errs.push(`${rel}: 最上位の項目 ${k} は使えません(default / environments / _注記 のみ)`);
  }
  if (data.default != null && !ENV_ID_RE.test(String(data.default))) errs.push(`${rel}: default の環境ID ${data.default} が書式(英数字・_・-)に合いません`);
  const envs = data.environments ?? {};
  if (typeof envs !== 'object' || Array.isArray(envs)) return [...errs, `${rel}: environments がオブジェクトではありません`];
  for (const [id, env] of Object.entries(envs)) {
    if (id.startsWith('_')) continue;
    if (!ENV_ID_RE.test(id)) errs.push(`${rel}: 環境ID ${id} が書式(英数字・_・-)に合いません`);
    if (!env || typeof env !== 'object' || Array.isArray(env)) { errs.push(`${rel}: 環境 ${id} がオブジェクトではありません`); continue; }
    for (const k of Object.keys(env)) {
      if (k.startsWith('_') || k === 'description' || k === 'attributes') continue;
      errs.push(`${rel}: 環境 ${id} の項目 ${k} は使えません(description / attributes / _注記 のみ)`);
    }
    const attrs = env.attributes ?? {};
    if (typeof attrs !== 'object' || Array.isArray(attrs)) { errs.push(`${rel}: 環境 ${id} の attributes がオブジェクトではありません`); continue; }
    for (const [key, a] of Object.entries(attrs)) {
      if (key.startsWith('_')) continue;
      if (!KEY_RE.test(key)) errs.push(`${rel}: ${id} のキー ${key} が書式(英小文字・数字・_・- を . でつなぐ。例 pms.url)に合いません`);
      if (isScalar(a)) continue;
      if (!a || typeof a !== 'object' || Array.isArray(a)) { errs.push(`${rel}: ${id}.${key} は文字列か { kind, value, description } でなければなりません`); continue; }
      for (const f of Object.keys(a)) {
        if (!f.startsWith('_') && !['kind', 'value', 'description'].includes(f)) errs.push(`${rel}: ${id}.${key} の項目 ${f} は使えません(kind / value / description のみ)`);
      }
      if (a.kind != null && !kinds.includes(String(a.kind))) errs.push(`${rel}: ${id}.${key} の kind ${a.kind} は ${kinds.join(' / ')} のいずれかでなければなりません`);
      if (a.value != null && !isScalar(a.value)) errs.push(`${rel}: ${id}.${key} の value は文字列・数値・真偽値でなければなりません`);
    }
  }
  return errs;
}

function isScalar(v) {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function normAttr(a) {
  if (isScalar(a)) return { value: String(a) };
  const out = {};
  if (a.kind != null) out.kind = String(a.kind);
  if (a.value != null && a.value !== '') out.value = String(a.value);
  if (a.description != null) out.description = String(a.description);
  return out;
}

/**
 * 両方の設定ファイルを読み、検査してまとめる。
 * @returns {{ shared, local, errors: string[], envs: Map<string, {description, sources: string[], attributes: Map<string, {kind, value, description, source}>}>, defaults: {shared, local} }}
 */
export function load(root) {
  const { kinds, baseKeys } = readVocab(root);
  const shared = readFile(root, SHARED_FILE);
  const local = readFile(root, LOCAL_FILE);
  const errors = [...validate(shared, SHARED_FILE, kinds), ...validate(local, LOCAL_FILE, kinds)];
  const envs = new Map();
  for (const [src, data] of [['shared', shared], ['local', local]]) {
    for (const [id, env] of Object.entries(data?.environments ?? {})) {
      if (id.startsWith('_') || !env || typeof env !== 'object') continue;
      if (!envs.has(id)) envs.set(id, { description: '', sources: [], attributes: new Map() });
      const e = envs.get(id);
      e.sources.push(src);
      if (env.description) e.description = String(env.description);
      for (const [key, a] of Object.entries(env.attributes ?? {})) {
        if (key.startsWith('_') || a == null || (typeof a === 'object' && Array.isArray(a))) continue;
        const cur = e.attributes.get(key) ?? {};
        const n = normAttr(a);
        const merged = { ...cur, ...n };
        if (n.value !== undefined) merged.source = src;
        e.attributes.set(key, merged);
      }
    }
  }
  // kind の補完: 設定になければ基本キーの定義、それもなければ other
  for (const e of envs.values()) {
    for (const [key, a] of e.attributes) {
      if (!a.kind) a.kind = baseKeys[key]?.kind ?? 'other';
      if (a.description === undefined && baseKeys[key]?.description) a.description = baseKeys[key].description;
    }
  }
  return {
    kinds, baseKeys, shared, local, errors, envs,
    defaults: { shared: shared?.default ?? null, local: local?.default ?? null },
  };
}

/** 使う環境を決める。{ env, by } を返す。決まらなければ env: null */
export function selectEnv(cfg, explicit, envVar = process.env.PMS_ENV) {
  if (explicit) return { env: explicit, by: '--env' };
  if (envVar) return { env: envVar, by: 'PMS_ENV' };
  if (cfg.defaults.local) return { env: String(cfg.defaults.local), by: `${LOCAL_FILE} の default` };
  if (cfg.defaults.shared) return { env: String(cfg.defaults.shared), by: `${SHARED_FILE} の default` };
  if (cfg.envs.size === 1) return { env: [...cfg.envs.keys()][0], by: '環境が1つだけ' };
  return { env: null, by: null };
}

/** 必要なキーが揃っているかを調べる */
export function requireKeys(cfg, envId, extra = [], { base = true } = {}) {
  const want = new Map();
  if (base) for (const [k, d] of Object.entries(cfg.baseKeys)) want.set(k, { kind: d.kind, description: d.description, base: true });
  for (const { key, kind } of extra) {
    const cur = want.get(key);
    want.set(key, { kind: kind ?? cur?.kind ?? null, description: cur?.description ?? '', base: cur?.base ?? false });
  }
  const env = envId ? cfg.envs.get(envId) : null;
  const missing = [];
  const present = [];
  for (const [key, w] of want) {
    const a = env?.attributes.get(key);
    const kind = a?.kind && a.kind !== 'other' ? a.kind : (w.kind ?? a?.kind ?? 'other');
    const description = a?.description || w.description || '';
    if (a && a.value !== undefined && a.value !== '') present.push({ key, kind, source: a.source });
    else missing.push({ key, kind, description, base: w.base });
  }
  return { missing, present };
}

/** 属性を1つ書き込む。書いたファイルを返す */
export function setValue(root, { env, key, value, kind, forceKind = false, description, target }) {
  const rel = target === 'shared' ? SHARED_FILE : LOCAL_FILE;
  const p = path.join(root, rel);
  const data = readFile(root, rel) ?? {};
  if (!data.environments || typeof data.environments !== 'object') data.environments = {};
  if (!data.environments[env]) data.environments[env] = { description: '', attributes: {} };
  const e = data.environments[env];
  if (!e.attributes || typeof e.attributes !== 'object') e.attributes = {};
  const cur = e.attributes[key];
  const next = cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur } : {};
  if (kind && (forceKind || !next.kind)) next.kind = kind;
  if (value !== undefined) next.value = value;
  if (description !== undefined) next.description = description;
  e.attributes[key] = next;
  writeJson(p, data);
  return rel;
}

/** 環境の説明を書き込む(環境がなければ作る) */
export function setEnvDescription(root, { env, description, target }) {
  const rel = target === 'shared' ? SHARED_FILE : LOCAL_FILE;
  const data = readFile(root, rel) ?? {};
  if (!data.environments || typeof data.environments !== 'object') data.environments = {};
  if (!data.environments[env]) data.environments[env] = { description: '', attributes: {} };
  data.environments[env].description = description;
  writeJson(path.join(root, rel), data);
  return rel;
}

/** 既定の環境を各自の設定(local)に書く */
export function setDefault(root, env) {
  const data = readFile(root, LOCAL_FILE) ?? {};
  const out = { default: env };
  for (const [k, v] of Object.entries(data)) if (k !== 'default') out[k] = v;
  if (!out.environments) out.environments = {};
  writeJson(path.join(root, LOCAL_FILE), out);
  return LOCAL_FILE;
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

/** 成果物の検査に使う値(lint env_value_leak / env_value_hardcoded)。全環境の、指定した種類の値 */
export function valuesOfKind(cfg, kind, minLength) {
  const out = [];
  for (const [id, e] of cfg.envs) {
    for (const [key, a] of e.attributes) {
      if (a.kind === kind && a.value !== undefined && a.value.length >= minLength) out.push({ env: id, key, value: a.value });
    }
  }
  return out;
}
