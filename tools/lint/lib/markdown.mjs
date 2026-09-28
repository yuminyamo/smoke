// markdown.mjs — lint 用の Markdown の簡易読み取り(見出しで区切った節と、パイプ表)

export function normalize(s) {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * 見出しの一覧を返す(コードブロックの中の # は見出しとみなさない)
 * @returns {{level:number, title:string, line:number}[]} line は 0 始まりの行番号
 */
export function headings(lines) {
  const out = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, title: m[2], line: i });
  });
  return out;
}

/**
 * 見出しが test(文字列または正規表現)に合う節の本文の行を返す。次の同じ深さ以上の見出しまで。
 * 見つからなければ null。
 */
export function sectionLines(text, test, level = null) {
  const lines = normalize(text).split('\n');
  const hs = headings(lines);
  const match = (t) => (typeof test === 'string' ? t === test : test.test(t));
  const idx = hs.findIndex((h) => (level === null || h.level === level) && match(h.title));
  if (idx < 0) return null;
  const h = hs[idx];
  const next = hs.slice(idx + 1).find((x) => x.level <= h.level);
  const end = next ? next.line : lines.length;
  return { lines: lines.slice(h.line + 1, end), offset: h.line + 1 };
}

/** 表の1行をセルに分ける(バッククォートの中の | と、\| は区切りとみなさない) */
export function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * 行の並びからパイプ表を取り出す。
 * @returns {{header:string[], rows:{cells:string[], obj:Object, line:number}[], line:number}[]}
 *          line は offset を足した 1 始まりの行番号
 */
export function tables(lines, offset = 0) {
  const out = [];
  let fence = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; i++; continue; }
    if (fence || !l.trim().startsWith('|')) { i++; continue; }
    const header = splitRow(l);
    const sep = lines[i + 1];
    if (!sep || !splitRow(sep).every((c) => /^:?-{3,}:?$/.test(c))) { i++; continue; }
    const t = { header, rows: [], line: offset + i + 1 };
    i += 2;
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      const cells = splitRow(lines[i]);
      const obj = {};
      header.forEach((h, k) => { obj[h] = cells[k] ?? ''; });
      t.rows.push({ cells, obj, line: offset + i + 1 });
      i++;
    }
    out.push(t);
  }
  return out;
}

/** 見出し test の節にある最初の表(列 requiredColumn を持つもの)を返す。なければ null */
export function tableInSection(text, test, requiredColumn) {
  const sec = sectionLines(text, test);
  if (!sec) return null;
  return tables(sec.lines, sec.offset).find((t) => t.header.includes(requiredColumn)) ?? null;
}

/** セルの値から ID を抜き出す */
export function idsIn(cell, re) {
  return [...String(cell ?? '').matchAll(re)].map((m) => m[0]);
}

/** セルが空(未記入)か。`-`・`—`・`―` も空とみなす */
export function isBlank(cell) {
  const t = String(cell ?? '').trim();
  return t === '' || t === '-' || t === '—' || t === '―';
}
