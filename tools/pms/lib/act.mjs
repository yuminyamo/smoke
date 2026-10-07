// act.mjs — pms act: 画面操作を1回ずつ実行し、そのたびに操作の記録(act-log.jsonl)に1行書く

import { PlaywrightCli, classifyLocator, envGet, parsePageUrl, parseRanCode, runExternal } from './cli.mjs';
import { secretsToMask, mask, maskDeep, MIN_MASK_LENGTH } from './store.mjs';
import { PMS, todoOf, submitCommand } from './queue.mjs';
import { timestamp, UsageError } from './util.mjs';

const ENV_REF = /^<env:([a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*)>$/;
const EXT_OP = /^OP-[A-Z0-9]+-\d{3}$/;

/** JavaScript の文字列リテラル(単一引用符) */
function jsString(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all));
}

/**
 * @param ctx  { root, paths, store, proc, cfg }
 * @param opt  { flow, card, intent }
 * @param args 操作と引数(例 ['fill', 'e15', '<env:pms.user>'])
 * @returns {{ code: number, out: object|string }}
 */
export function act(ctx, opt, args) {
  const { root, paths, store, proc, cfg } = ctx;
  const q = store.loadQueue(opt.flow);
  if (!opt.card) throw new UsageError('--card がありません');
  const c = store.card(q, opt.card);
  if (c.kind !== 'setup.build') throw new UsageError(`${c.id} は ${c.kind} のカードです。pms act は setup.build のカードで使う`);
  if (c.status !== 'issued') {
    throw new UsageError(`${c.id} は出ていないカードです(状態 ${c.status})。${PMS} next --flow ${q.flow_id} で今のカードを確かめる`);
  }
  const [action, ...rest] = args;
  const allowed = proc.values('pms_act_action');
  if (!action) throw new UsageError(`操作がありません(${allowed.join(' / ')})`);
  if (!allowed.includes(action)) throw new UsageError(`操作 ${action} は vocab.pms_act_action にありません(${allowed.join(' / ')})`);
  if (!['open', 'goto', 'snapshot'].includes(action) && !opt.intent) throw new UsageError(`${action} には --intent "<この操作の目的>" が要ります`);

  const now = { flow: q.flow_id, card: c.id, kind: c.kind, state_id: c.state_id, todo: todoOf(c) };
  const actCmd = `${PMS} act --flow ${q.flow_id} --card ${c.id}`;
  const masks = secretsToMask(root);
  const warnings = [];
  const prev = [...store.actRecords(q)].reverse().find((a) => a.url_after);
  const row = {
    flow: q.flow_id, seq: store.nextSeq(q), card: c.id, state_id: c.state_id, action,
    ref: null, locator: null, locator_class: null, unique: null, value: null, intent: opt.intent ?? null,
    code: null, url_before: prev?.url_after ?? null, url_after: null,
    started_at: timestamp(), ended_at: null, ok: false, error: null,
  };
  const resolve = (v) => {
    const m = String(v).match(ENV_REF);
    if (!m) return { actual: v, recorded: v };
    const r = envGet(cfg, root, m[1]);
    if (!r.ok) throw new ActError(r.message);
    masks.push({ key: m[1], value: r.value });
    if (r.value.length < MIN_MASK_LENGTH) warnings.push(`<env:${m[1]}> の値は ${MIN_MASK_LENGTH} 文字未満のため、出力で伏せられない`);
    return { actual: r.value, recorded: v };
  };
  const cli = new PlaywrightCli(cfg, q.flow_id, root);
  let rawOut = '';

  try {
    if (action === 'snapshot') {
      const r = cli.call(['snapshot']);
      rawOut = r.stdout;
      row.url_after = parsePageUrl(r.stdout) ?? row.url_before;
      row.ok = r.code === 0;
      if (!row.ok) row.error = `snapshot が失敗した(終了コード ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    } else if (action === 'open' || action === 'goto') {
      if (rest.length !== 1) throw new UsageError(`${action} <URL|<env:キー>>`);
      const u = resolve(rest[0]);
      row.value = u.recorded;
      if (action === 'open') {
        const ver = cli.version();
        row.cli_version = ver;
        if (cfg.playwright_cli_version && ver && !ver.includes(String(cfg.playwright_cli_version))) {
          warnings.push(`playwright-cli の版 ${ver} が想定(config/pms.json の playwright_cli_version: ${cfg.playwright_cli_version})と違う`);
        }
      }
      const r = cli.call(action === 'open' ? ['open', u.actual, ...cfg.open_args] : ['goto', u.actual]);
      rawOut = r.stdout;
      row.ok = r.code === 0;
      row.code = `await page.goto(${jsString(u.recorded)});`;
      row.url_after = parsePageUrl(r.stdout) ?? (row.ok ? cli.evaluate('page.url()').value : null);
      if (!row.ok) row.error = `${action} が失敗した(終了コード ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    } else if (action === 'ext') {
      const dd = rest.indexOf('--');
      const opIdx = rest.indexOf('--op');
      const opId = opIdx >= 0 ? rest[opIdx + 1] : null;
      if (!opId || !EXT_OP.test(opId) || dd < 0 || dd === rest.length - 1) throw new UsageError('ext --op <操作ID(OP-<対象略号>-<3桁>)> -- <実行体の呼び出し...>');
      const argv = rest.slice(dd + 1).map((a) => resolve(a));
      row.operation_id = opId;
      row.value = argv.map((a) => a.recorded).join(' ');
      const r = runExternal(argv.map((a) => a.actual), root);
      rawOut = r.stdout;
      row.exit_code = r.code;
      let parsed = null;
      try { parsed = JSON.parse(r.stdout.trim()); } catch { /* JSON でない出力は先頭だけ残す */ }
      row.output = parsed ?? r.stdout.trim().slice(0, 2000);
      row.ok = r.code === 0;
      row.code = `await external.${opId}(/* tests/external/ のラッパ */);`;
      row.url_after = row.url_before;
      if (!row.ok) row.error = `実行体が終了コード ${r.code} で終わった: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    } else {
      // 要素の操作と assert: 操作の前にロケータを取る(操作のあとは画面が変わり ref が無効になることがある)
      const ref = rest[0];
      if (!ref || !/^[A-Za-z0-9]+$/.test(ref)) throw new UsageError(`${action} <ref(snapshot の要素参照。例 e15)> …`);
      row.ref = ref;
      const g = cli.generateLocator(ref);
      if (!g.locator) throw new ActError(`generate-locator ${ref} でロケータを取れない(終了コード ${g.raw.code})。snapshot で画面を取り直し、別の ref で操作する`);
      row.locator = g.locator;
      row.locator_class = classifyLocator(g.locator);
      const n = cli.evaluate(`await page.${g.locator}.count()`).value;
      row.unique = n === '1';
      if (row.locator_class === 'css') warnings.push('ロケータが安定でない(CSS・構造)。別の要素で操作し直すか、00 ■ロケータ規約の6(CSS の暫定使用と testid-requests への記録)に従う');
      if (!row.unique) warnings.push(`ロケータが一意でない(${n ?? '数えられない'} 件に当たる)。別の要素で操作し直すか、00 ■ロケータ規約の6(CSS の暫定使用と testid-requests への記録)に従う`);

      if (action === 'assert') {
        const cond = rest[1];
        if (!['visible', 'hidden', 'text'].includes(cond)) throw new UsageError('assert <ref> visible|hidden|text "<文言>"');
        const text = cond === 'text' ? rest[2] : null;
        if (cond === 'text' && (text == null || text === '')) throw new UsageError('assert <ref> text "<文言>"');
        const L = `page.${g.locator}`;
        const expr = cond === 'visible' ? `await ${L}.isVisible()`
          : cond === 'hidden' ? `!(await ${L}.isVisible())`
            : `((await ${L}.textContent()) ?? '').includes(${jsString(text)})`;
        const r = cli.evaluate(expr);
        rawOut = r.raw.stdout;
        row.assert = { condition: cond, text };
        row.ok = r.value === 'true';
        row.code = cond === 'visible' ? `await expect(${L}).toBeVisible();` : cond === 'hidden' ? `await expect(${L}).toBeHidden();` : `await expect(${L}).toContainText(${jsString(text)});`;
        if (!row.ok) row.error = `条件を満たさない(${cond}${text ? ` 「${text}」` : ''}。結果 ${r.value ?? '取得できない'})`;
        row.url_after = row.url_before;
      } else {
        const op = cfg.ops[action];
        if (!op) throw new UsageError(`操作 ${action} の呼び出しが config/pms.json の ops にありません`);
        const needsValue = !!op.value;
        if (needsValue && rest.length < 2) throw new UsageError(`${action} <ref> <値|<env:キー>>`);
        if (!needsValue && rest.length > 1) throw new UsageError(`${action} <ref>(値は取らない)`);
        const v = needsValue ? resolve(rest[1]) : null;
        row.value = v ? v.recorded : null;
        const vars = { ref, value: v?.actual ?? '', js_value: v ? jsString(v.actual) : '', locator: g.locator };
        const r = op.cli ? cli.call(op.cli.map((a) => fill(a, vars))) : cli.exec(`await page.${g.locator}.${fill(op.run_code, vars)}`);
        rawOut = r.stdout;
        row.ok = r.code === 0;
        const ran = parseRanCode(r.stdout);
        row.code = ran ?? `await page.${g.locator}.${fill(op.code ?? op.run_code ?? `${action}()`, { ...vars, js_value: v ? jsString(v.recorded) : '' })};`;
        row.url_after = parsePageUrl(r.stdout) ?? (row.ok ? cli.evaluate('page.url()').value : null);
        if (!row.ok) row.error = `${action} が失敗した(終了コード ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
      }
    }
  } catch (e) {
    if (!(e instanceof ActError)) throw e;
    row.ok = false;
    row.error = e.message;
  }
  row.ended_at = timestamp();
  const rec = maskDeep(row, masks);
  store.appendAct(c.feature, rec);

  let next;
  let hint;
  if (!rec.ok) {
    next = `${actCmd} snapshot`;
    hint = '操作に失敗した(記録は残した)。snapshot で画面を確かめてからやり直す';
  } else if (action === 'assert') {
    next = submitCommand(q, c, paths);
    hint = `状態の成立を確かめた。${paths.out(q.flow_id, c.id)} に出力の JSON を書いてから提出する(seqs に成功した最短の操作の連番、established_check_seq に ${rec.seq})`;
  } else if (action === 'snapshot') {
    next = `${actCmd} --intent "<この操作の目的>" <操作> <ref> [値]`;
    hint = '画面の要素参照(ref)を使って次の操作をする。状態ができたら assert で確かめる';
  } else {
    next = `${actCmd} snapshot`;
    hint = '画面が変わったかを snapshot で確かめて次の操作をする。状態ができたら assert <ref> visible|hidden|text で確かめる';
  }
  const result = {
    ok: rec.ok, seq: rec.seq, action, locator: rec.locator, locator_class: rec.locator_class, unique: rec.unique,
    url_after: rec.url_after, error: rec.error, warnings: maskDeep(warnings, masks), now, next, hint,
  };
  if (action === 'snapshot') {
    return { code: rec.ok ? 0 : 1, out: `${mask(rawOut, masks).replace(/\n*$/, '')}\n\n--- pms ---\n${JSON.stringify(result)}` };
  }
  void rawOut;
  return { code: rec.ok ? 0 : 1, out: result };
}

class ActError extends Error {}
