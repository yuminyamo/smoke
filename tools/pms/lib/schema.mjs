// schema.mjs — カードの出力の JSON Schema の検査(外部パッケージ不要。procedure/schemas/*.out.json が使う範囲だけ)
//
// 対応するキーワード: type(配列も可)・enum・const・pattern・minLength・maxLength・minimum・maximum・
//   required・properties・additionalProperties(false のみ)・items・minItems・maxItems・uniqueItems・
//   allOf・if / then / else・description(表示用)
// 独自のキーワード: x-vocab: "<vocab のキー>" — 値がそのキーのマッピングのキーのいずれかであること
//   (統制語彙の値を schema に書き写さないため。00 ■文書の5層構成)

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

/** vocab のキーの値の一覧(x-vocab)。「a.b」は入れ子のキー */
export function vocabValues(vocab, key) {
  let node = vocab;
  for (const k of String(key).split('.')) node = node && typeof node === 'object' ? node[k] : undefined;
  if (Array.isArray(node)) return node.map(String);
  if (node && typeof node === 'object') return Object.keys(node);
  return null;
}

/**
 * @returns {{path:string, message:string}[]} 違反の一覧(空なら合格)
 */
export function validate(schema, value, vocab, at = '$') {
  const out = [];
  const add = (message) => out.push({ path: at, message });
  if (!schema || typeof schema !== 'object') return out;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      add(`型が違います(${types.join(' / ')} が必要。実際は ${typeOf(value)})`);
      return out;
    }
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) add(`値は ${JSON.stringify(schema.const)} でなければなりません`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) add(`値 ${JSON.stringify(value)} は許されません(${schema.enum.map((e) => JSON.stringify(e)).join(' / ')})`);
  if (schema['x-vocab'] && value !== null && value !== undefined) {
    const allowed = vocabValues(vocab, schema['x-vocab']);
    if (!allowed) add(`vocab.${schema['x-vocab']} がありません(schema の誤り)`);
    else if (!allowed.includes(String(value))) add(`値「${value}」は vocab.${schema['x-vocab']} にありません(${allowed.join(' / ')})`);
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength != null && len < schema.minLength) add(`短すぎます(${len} 文字。${schema.minLength} 文字以上)`);
    if (schema.maxLength != null && len > schema.maxLength) add(`長すぎます(${len} 文字。${schema.maxLength} 文字以下)`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) add(`書式が違います(パターン ${schema.pattern})`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) add(`${schema.minimum} 以上でなければなりません`);
    if (schema.maximum != null && value > schema.maximum) add(`${schema.maximum} 以下でなければなりません`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) add(`要素が少なすぎます(${value.length} 個。${schema.minItems} 個以上)`);
    if (schema.maxItems != null && value.length > schema.maxItems) add(`要素が多すぎます(${value.length} 個。${schema.maxItems} 個以下)`);
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) add('要素が重複しています');
    if (schema.items) value.forEach((item, i) => out.push(...validate(schema.items, item, vocab, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) out.push({ path: `${at}.${k}`, message: '必須の欄がありません' });
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) out.push(...validate(props[k], v, vocab, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push({ path: `${at}.${k}`, message: '定義されていない欄です' });
    }
  }
  for (const sub of schema.allOf ?? []) out.push(...validate(sub, value, vocab, at));
  if (schema.if) {
    const cond = validate(schema.if, value, vocab, at).length === 0;
    if (cond && schema.then) out.push(...validate(schema.then, value, vocab, at));
    if (!cond && schema.else) out.push(...validate(schema.else, value, vocab, at));
  }
  return out;
}

/**
 * カードに載せる「各欄の許される値」の表(schema の properties から作る)
 */
export function schemaTable(schema, vocab) {
  const rows = ['| 欄 | 必須 | 許される値 | 内容 |', '|---|---|---|---|'];
  const req = new Set(schema.required ?? []);
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const walk = (props, prefix, required) => {
    for (const [k, p] of Object.entries(props ?? {})) {
      const name = prefix ? `${prefix}.${k}` : k;
      rows.push(`| \`${name}\` | ${required.has(k) ? 'はい' : p['x-required-when'] ?? '—'} | ${cell(allowed(p, vocab))} | ${cell(p.description ?? '')} |`);
      const obj = Array.isArray(p.type) ? p.type.includes('object') : p.type === 'object';
      if (obj && p.properties) walk(p.properties, name, new Set(p.required ?? []));
      if (p.items?.properties) walk(p.items.properties, `${name}[]`, new Set(p.items.required ?? []));
    }
  };
  walk(schema.properties, '', req);
  return rows.join('\n');
}

function allowed(p, vocab) {
  const parts = [];
  const types = Array.isArray(p.type) ? p.type : p.type ? [p.type] : [];
  if (p.enum) parts.push(p.enum.map((e) => (e === null ? 'null' : `\`${e}\``)).join(' / '));
  else if (p['x-vocab']) {
    const vals = vocabValues(vocab, p['x-vocab']) ?? [];
    parts.push(`vocab.${p['x-vocab']}(${vals.map((v) => `\`${v}\``).join(' / ')})`);
    if (types.includes('null')) parts.push('null');
  } else {
    const named = { string: '文字列', integer: '整数', number: '数', boolean: 'true / false', array: '配列', object: 'オブジェクト', null: 'null' };
    parts.push(types.map((t) => named[t] ?? t).join(' / '));
  }
  const len = [];
  if (p.minLength != null) len.push(`${p.minLength}`);
  if (p.maxLength != null) len.push(`${p.maxLength}`);
  if (len.length) parts.push(`${p.minLength ?? 0}〜${p.maxLength ?? ''} 文字`);
  if (p.pattern) parts.push(`書式 \`${p.pattern}\``);
  if (p.minItems != null || p.maxItems != null) parts.push(`${p.minItems ?? 0}〜${p.maxItems ?? ''} 個`);
  if (p.minimum != null) parts.push(`${p.minimum} 以上`);
  return parts.join('。');
}
