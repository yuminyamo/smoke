// yaml-lite.mjs — lint 用の YAML の簡易パーサ(外部パッケージ不要)。
//
// 手順書の成果物(status.yaml / exploration-log.yaml / setup-log.yaml / vocab.yaml)が使う範囲だけを読む。
//   対応: ブロックのマッピング・シーケンス、フロー形式 {…} [...](複数行も可)、ブロックスカラー | >、
//         引用符付きスカラー、コメント、複数文書(---)、キーと同じ深さに置いたシーケンス
//   非対応: アンカー・エイリアス・タグ・複合キー
//
// 手順書の例(付録A)には、YAML としては厳密でない値(例: locator: getByRole('button', { name: '印刷実行' }))が
// あるため、「キー: 」の後ろは、{ [ 引用符 | > で始まらない限り、行末までを1つの文字列として読む(寛容に読む)。
// 数値に見える値は数値、true/false は真偽値、null・~・空は null。yes/no は文字列のまま(YAML 1.2)。

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${line}行目: ${message}` : message);
    this.line = line;
  }
}

/** 全文書を配列で返す(空の文書は除く) */
export function parseYamlDocs(text) {
  const lines = normalize(text).split('\n');
  const docs = [];
  let start = 0;
  const flush = (end) => {
    const chunk = lines.slice(start, end).map((raw, k) => ({ raw, no: start + k + 1 }));
    if (chunk.some((l) => isSignificant(l.raw))) docs.push(new Parser(chunk).parseDocument());
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*(#.*)?$/.test(lines[i])) {
      flush(i);
      start = i + 1;
    }
  }
  flush(lines.length);
  return docs;
}

/** 最初の文書を返す(文書がなければ null) */
export function parseYaml(text) {
  const docs = parseYamlDocs(text);
  return docs.length ? docs[0] : null;
}

function normalize(s) {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function isSignificant(raw) {
  const t = raw.trim();
  return t !== '' && !t.startsWith('#');
}

function indentOf(raw) {
  const m = raw.match(/^( *)/);
  if (/^ *\t/.test(raw)) return -1; // タブの字下げ
  return m[1].length;
}

// 行末のコメントを外す(引用符の中の # は残す)
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") { i++; continue; }
        q = null;
      } else if (c === '\\' && q === '"') i++;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s\[\{,:(]/.test(s[i - 1]))) { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

// 「キー: 値」の行なら { key, rest } を返す
function splitKey(text) {
  if (text.startsWith('- ') || text === '-') return null;
  if (text.startsWith('[') || text.startsWith('{')) return null;
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = findQuoteEnd(text, 0);
    if (end < 0) return null;
    const after = text.slice(end + 1);
    const m = after.match(/^\s*:(\s+|$)/);
    if (!m) return null;
    return { key: unquote(text.slice(0, end + 1)), rest: after.slice(m[0].length).trim() };
  }
  const m = text.match(/^(.*?):(\s+|$)/);
  if (!m) return null;
  const key = m[1].trim();
  if (key === '') return null;
  return { key, rest: text.slice(m[0].length).trim() };
}

function findQuoteEnd(s, start) {
  const q = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\' && q === '"') { i++; continue; }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") { i++; continue; }
      return i;
    }
  }
  return -1;
}

function unquote(s) {
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\/nrt0])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', 0: '\0' })[c] ?? c);
  }
  return s;
}

function plainScalar(s) {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^[-+]?\d+$/.test(t) && !/^[-+]?0\d/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

class Parser {
  constructor(lines) {
    this.lines = lines; // { raw, no }
    this.i = 0;
  }

  parseDocument() {
    const j = this.nextSig();
    if (j < 0) return null;
    const ind = indentOf(this.lines[j].raw);
    const v = this.parseBlock(ind);
    const k = this.nextSig();
    if (k >= 0) throw new YamlError('解釈できない行があります(字下げの誤りの可能性)', this.lines[k].no);
    return v;
  }

  nextSig() {
    let j = this.i;
    while (j < this.lines.length && !isSignificant(this.lines[j].raw)) j++;
    return j < this.lines.length ? j : -1;
  }

  lineInfo(j) {
    const l = this.lines[j];
    if (l.override) return l.override;
    const ind = indentOf(l.raw);
    if (ind < 0) throw new YamlError('字下げにタブは使えません', l.no);
    return { indent: ind, text: stripComment(l.raw.slice(ind)), no: l.no };
  }

  parseBlock(minIndent) {
    const j = this.nextSig();
    if (j < 0) return null;
    const info = this.lineInfo(j);
    if (info.indent < minIndent) return null;
    if (info.text === '-' || info.text.startsWith('- ')) return this.parseSeq(info.indent);
    if (splitKey(info.text)) return this.parseMap(info.indent);
    // スカラーだけの文書・ノード
    this.i = j + 1;
    return this.parseValue(info.text, info.indent - 1, info.no);
  }

  parseMap(indent) {
    const out = {};
    for (;;) {
      const j = this.nextSig();
      if (j < 0) break;
      const info = this.lineInfo(j);
      if (info.indent < indent) break;
      if (info.indent > indent) throw new YamlError('字下げが揃っていません', info.no);
      if (info.text === '-' || info.text.startsWith('- ')) break; // 親のシーケンスに戻る
      const kv = splitKey(info.text);
      if (!kv) throw new YamlError(`「キー: 値」の形ではありません: ${info.text}`, info.no);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new YamlError(`キー ${kv.key} が重複しています`, info.no);
      this.i = j + 1;
      if (kv.rest === '') {
        const k = this.nextSig();
        if (k < 0) { out[kv.key] = null; continue; }
        const next = this.lineInfo(k);
        if (next.indent > indent) out[kv.key] = this.parseBlock(next.indent);
        else if (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) out[kv.key] = this.parseSeq(indent);
        else out[kv.key] = null;
      } else {
        out[kv.key] = this.parseValue(kv.rest, indent, info.no);
      }
    }
    return out;
  }

  parseSeq(indent) {
    const out = [];
    for (;;) {
      const j = this.nextSig();
      if (j < 0) break;
      const info = this.lineInfo(j);
      if (info.indent !== indent || !(info.text === '-' || info.text.startsWith('- '))) {
        if (info.indent > indent) throw new YamlError('字下げが揃っていません', info.no);
        break;
      }
      const rest = info.text === '-' ? '' : info.text.slice(2);
      const lead = rest.length - rest.trimStart().length;
      const body = rest.trim();
      if (body === '') {
        this.i = j + 1;
        const k = this.nextSig();
        if (k >= 0 && this.lineInfo(k).indent > indent) out.push(this.parseBlock(this.lineInfo(k).indent));
        else out.push(null);
      } else if (splitKey(body) || body === '-' || body.startsWith('- ')) {
        // 「- キー: 値」: この行を字下げの深い行として読み直す
        this.lines[j] = { ...this.lines[j], override: { indent: indent + 2 + lead, text: body, no: info.no } };
        out.push(splitKey(body) ? this.parseMap(indent + 2 + lead) : this.parseSeq(indent + 2 + lead));
      } else {
        this.i = j + 1;
        out.push(this.parseValue(body, indent, info.no));
      }
    }
    return out;
  }

  // 「キー: 」または「- 」の後ろの値。parentIndent は親の字下げ(継続行はそれより深い)
  parseValue(text, parentIndent, no) {
    const c = text[0];
    if (c === '|' || c === '>') {
      if (!/^[|>][-+]?\d?$/.test(text)) throw new YamlError(`ブロックスカラーの指示子が不正です: ${text}`, no);
      return this.blockScalar(text, parentIndent);
    }
    if (c === '{' || c === '[') {
      let buf = text;
      let no2 = no;
      while (!flowBalanced(buf)) {
        if (this.i >= this.lines.length) throw new YamlError('フロー形式の括弧が閉じていません', no);
        const l = this.lines[this.i++];
        no2 = l.no;
        if (!isSignificant(l.raw)) continue;
        buf += ' ' + stripComment(l.raw.trim());
      }
      const fp = new FlowParser(buf, no);
      const v = fp.value();
      fp.ws();
      if (fp.pos !== buf.length) throw new YamlError(`フロー形式の後ろに余分な文字があります: ${buf.slice(fp.pos)}`, no2);
      return v;
    }
    if (c === '"' || c === "'") {
      let buf = text;
      let end = findQuoteEnd(buf, 0);
      while (end < 0) {
        if (this.i >= this.lines.length) throw new YamlError('引用符が閉じていません', no);
        buf += ' ' + this.lines[this.i++].raw.trim();
        end = findQuoteEnd(buf, 0);
      }
      const tail = buf.slice(end + 1).trim();
      if (tail !== '') throw new YamlError(`引用符の後ろに余分な文字があります: ${tail}`, no);
      return unquote(buf.slice(0, end + 1));
    }
    // 素のスカラー。字下げの深い継続行があれば空白でつなぐ
    let buf = text;
    for (;;) {
      const k = this.nextSig();
      if (k < 0) break;
      const info = this.lineInfo(k);
      if (info.indent <= parentIndent) break;
      if (splitKey(info.text) || info.text.startsWith('- ')) {
        throw new YamlError(`値のあとに字下げの深い行があります(値かブロックのどちらかにする): ${info.text}`, info.no);
      }
      buf += ' ' + info.text;
      this.i = k + 1;
    }
    return plainScalar(buf);
  }

  blockScalar(indicator, parentIndent) {
    const folded = indicator[0] === '>';
    const chomp = indicator.includes('-') ? 'strip' : indicator.includes('+') ? 'keep' : 'clip';
    const collected = [];
    let contentIndent = null;
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i].raw;
      if (raw.trim() === '') { collected.push(''); this.i++; continue; }
      const ind = indentOf(raw);
      if (ind <= parentIndent) break;
      if (contentIndent === null) contentIndent = ind;
      if (ind < contentIndent) break;
      collected.push(raw.slice(contentIndent));
      this.i++;
    }
    // 末尾の空行はブロックの外として戻す(keep 以外)
    let trailing = 0;
    while (collected.length && collected[collected.length - 1] === '') { collected.pop(); trailing++; }
    let text;
    if (folded) {
      text = '';
      for (let k = 0; k < collected.length; k++) {
        const l = collected[k];
        if (k === 0) text = l;
        else if (l === '' || collected[k - 1] === '') text += '\n' + l;
        else text += ' ' + l;
      }
    } else {
      text = collected.join('\n');
    }
    if (chomp === 'strip' || collected.length === 0) return text;
    if (chomp === 'keep') return text + '\n'.repeat(trailing + 1);
    return text + '\n';
  }
}

function flowBalanced(s) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } q = null; }
      else if (c === '\\' && q === '"') i++;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s\[\{,:]/.test(s[i - 1]))) q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth <= 0 && !q;
}

class FlowParser {
  constructor(s, no) {
    this.s = s;
    this.pos = 0;
    this.no = no;
  }
  err(msg) { throw new YamlError(`${msg}(位置 ${this.pos}: ${this.s})`, this.no); }
  ws() { while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++; }
  value() {
    this.ws();
    const c = this.s[this.pos];
    if (c === '{') return this.map();
    if (c === '[') return this.seq();
    if (c === '"' || c === "'") {
      const end = findQuoteEnd(this.s, this.pos);
      if (end < 0) this.err('引用符が閉じていません');
      const v = unquote(this.s.slice(this.pos, end + 1));
      this.pos = end + 1;
      return v;
    }
    return plainScalar(this.plain(false));
  }
  plain(isKey) {
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === ',' || c === ']' || c === '}')) break;
      else if (isKey && depth === 0 && c === ':' && /[\s,\]}]/.test(this.s[this.pos + 1] ?? ' ')) break;
      this.pos++;
    }
    return this.s.slice(start, this.pos).trim();
  }
  map() {
    const out = {};
    this.pos++; // {
    for (;;) {
      this.ws();
      if (this.s[this.pos] === '}') { this.pos++; return out; }
      if (this.pos >= this.s.length) this.err('} がありません');
      let key;
      const c = this.s[this.pos];
      if (c === '"' || c === "'") {
        const end = findQuoteEnd(this.s, this.pos);
        if (end < 0) this.err('引用符が閉じていません');
        key = unquote(this.s.slice(this.pos, end + 1));
        this.pos = end + 1;
      } else key = this.plain(true);
      this.ws();
      let val = null;
      if (this.s[this.pos] === ':') { this.pos++; val = this.value(); }
      if (key !== '') {
        if (Object.prototype.hasOwnProperty.call(out, key)) this.err(`キー ${key} が重複しています`);
        out[key] = val;
      }
      this.ws();
      if (this.s[this.pos] === ',') { this.pos++; continue; }
      if (this.s[this.pos] === '}') { this.pos++; return out; }
      this.err(', または } がありません');
    }
  }
  seq() {
    const out = [];
    this.pos++; // [
    for (;;) {
      this.ws();
      if (this.s[this.pos] === ']') { this.pos++; return out; }
      if (this.pos >= this.s.length) this.err('] がありません');
      out.push(this.value());
      this.ws();
      if (this.s[this.pos] === ',') { this.pos++; continue; }
      if (this.s[this.pos] === ']') { this.pos++; return out; }
      this.err(', または ] がありません');
    }
  }
}
