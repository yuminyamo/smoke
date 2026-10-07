// yaml-write.mjs — setup-log を書くための YAML の出力(外部パッケージ不要)
//
// 出力は YAML として正しく、tools/lint/lib/yaml-lite.mjs で読み戻せる範囲に限る:
// ブロックのマッピング・シーケンス、二重引用符のスカラー(\\ \" \n \t \r だけを使う)、複数行は | のブロックスカラー。

const PLAIN_SAFE = /^[A-Za-z0-9　-鿿＀-￯_][^:#'"{}\[\],&*!|>%@`]*$/;

function needsQuote(s) {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true; // 日時は文字列のまま残す
  return !PLAIN_SAFE.test(s);
}

export function quote(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r') + '"';
}

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuote(s) ? quote(s) : s;
}

function isScalar(v) {
  return v === null || v === undefined || typeof v !== 'object';
}

function blockScalar(s, indent) {
  const pad = ' '.repeat(indent);
  const body = s.replace(/\n+$/, '').split('\n').map((l) => (l ? pad + l : '')).join('\n');
  return `|\n${body}`;
}

/**
 * 値を YAML のブロック形式の行にする。
 * @param {*} v       マッピング(オブジェクト)・シーケンス(配列)・スカラー
 * @param {number} indent 字下げ(空白の数)
 */
export function emit(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}[]`;
    return v.map((item) => {
      if (isScalar(item)) return `${pad}- ${scalar(item)}`;
      if (Array.isArray(item)) return `${pad}-\n${emit(item, indent + 2)}`;
      const inner = emit(item, indent + 2).split('\n');
      inner[0] = `${pad}- ${inner[0].slice(indent + 2)}`;
      return inner.join('\n');
    }).join('\n');
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (keys.length === 0) return `${pad}{}`;
    return keys.map((k) => {
      const val = v[k];
      const key = needsQuote(k) ? quote(k) : k;
      if (typeof val === 'string' && val.includes('\n')) return `${pad}${key}: ${blockScalar(val, indent + 2)}`;
      if (isScalar(val)) return `${pad}${key}: ${scalar(val)}`;
      if (Array.isArray(val) && val.length === 0) return `${pad}${key}: []`;
      if (!Array.isArray(val) && Object.keys(val).length === 0) return `${pad}${key}: {}`;
      return `${pad}${key}:\n${emit(val, indent + 2)}`;
    }).join('\n');
  }
  return `${pad}${scalar(v)}`;
}

/** 1つの YAML 文書(末尾に改行) */
export function emitDoc(obj) {
  return emit(obj, 0) + '\n';
}
