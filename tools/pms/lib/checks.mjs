// checks.mjs — pms submit の検査の部品(区分は vocab.pms_reject_kind)

import fs from 'node:fs';
import path from 'node:path';
import { setup_steps_recorded, no_temp_locator } from '../../lint/rules/exploration.mjs';
import { MIN_SECRET_LENGTH } from '../../lint/rules/environment.mjs';
import { readText } from './util.mjs';

// playwright-cli の snapshot の要素参照(lint no_temp_locator と同じ)
export const TEMP_REF = /(?:^|[^\w$.\-])(?:(?:aria-)?ref\s*[=:]\s*)?e\d{1,6}(?![\w])/;

/** 不合格の区分ごとの直し方(1行) */
export const FIX = {
  schema: '出力の JSON をカードの「出力」の表の形に直す(必須の欄・許される値)',
  seq_missing: 'pms act の出力にあった、このカードの成功した操作の連番だけを書く(記録のない操作は、pms act でやり直して記録する)',
  unstable_locator: '別の要素で pms act をやり直して安定ロケータの操作にする。どうしても取れないときは 00 ■ロケータ規約の6(CSS の暫定使用)に従い fragile に挙げ、testid-requests.md に記載する',
  red_flag: 'あいまいな語を具体的な語に置き換え、欄の長さ・参照の書き方をカードの規則どおりにする',
  code_mismatch: '部品・fixture のファイルと名前を直し、setup-log の各 step のロケータ・established check のロケータをコードに書く',
  runs: '実行の記録をカードの指定どおりの回数・形にする(実行した結果をそのまま書く)',
  reuse_source: '流用元が変わった。この提出は直せないので、出力の result を cannot_proceed にして提出する',
  lint: 'setup-log に書く予定の内容が lint に違反する。違反した操作を pms act でやり直す',
};

/** 文字列の欄をすべて取り出す(除外する欄: コマンド・ファイルの所在) */
export function stringFields(obj, skip = new Set(), at = '$') {
  const out = [];
  if (typeof obj === 'string') out.push({ path: at, value: obj });
  else if (Array.isArray(obj)) obj.forEach((v, i) => out.push(...stringFields(v, skip, `${at}[${i}]`)));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) if (!skip.has(k)) out.push(...stringFields(v, skip, `${at}.${k}`));
  }
  return out;
}

/** あいまい語(vocab.pms_vague_words)。「〜等」は「等」で終わる語として探す */
export function vagueWords(text, words) {
  const hits = [];
  for (const w of words) {
    if (w === '等' ? /[^\s、。]等(?![級分価式号])/.test(text) : text.includes(w)) hits.push(w);
  }
  return hits;
}

/** ロケータの比較用の形(空白を除き、引用符をそろえ、先頭の page. を外す) */
export function normLocator(s) {
  return String(s ?? '').replace(/^\s*page\./, '').replace(/\s+/g, '').replace(/"/g, "'").replace(/`/g, "'");
}

/** 部品・fixture のコード: そのファイルと、そこから相対 import したファイル(1段) */
export function codeGroup(root, rels) {
  const files = new Map();
  const add = (rel) => {
    const abs = path.join(root, rel);
    if (files.has(rel) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
    files.set(rel, readText(abs));
    return true;
  };
  for (const rel of rels) {
    if (!add(rel)) continue;
    for (const m of files.get(rel).matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      for (const cand of [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`]) if (add(cand)) break;
    }
  }
  return files;
}

/** lint の規則(setup_steps_recorded・no_temp_locator)を、書く予定のエントリ1つに当てる */
export function lintEntry({ feature, flow, version, entry, file }) {
  const repo = {
    flow, stage: '10',
    inFlow: (f) => f === flow,
    setupEntries: [{ file, feature, flow, e: entry }],
    explorationRecords: [],
    statusFiles: [{ rel: `work/${feature}/exploration/status.yaml`, flow, data: { procedure_version: version } }],
  };
  return [...setup_steps_recorded(repo).findings, ...no_temp_locator(repo).findings].map((f) => f.message);
}

/** lint env_value_leak と同じ基準(MIN_SECRET_LENGTH 文字以上の秘密情報の値)で、書く予定の内容に値がないか */
export function leakedSecrets(text, secrets) {
  return secrets.filter((s) => s.value.length >= MIN_SECRET_LENGTH && text.includes(s.value)).map((s) => s.key);
}
