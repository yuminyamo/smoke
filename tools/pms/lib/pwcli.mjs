// pwcli.mjs — pms pwcli: カードを使わない作業の画面操作を playwright-cli にそのまま渡し、値を伏せて返す(記録はしない)

import { PlaywrightCli, browserConfigArgs, resolveEnvArg } from './cli.mjs';
import { secretsToMask, mask } from './store.mjs';
import { UsageError } from './util.mjs';

/**
 * 引数のうち <env:キー> だけのものを値に置き換えて playwright-cli を呼び、標準出力・標準エラー出力の
 * 秘密情報(全環境の kind secret)と置き換えた値を <env:キー> に戻して返す。
 * 値の置き換えと伏せ方は pms act と同じ部品(resolveEnvArg・secretsToMask・mask)を使う。
 * pms act と違い、カード・フローを要らず、操作の記録(act-log)も書かない。open には pms act と同じく browser_config を --config で渡す。
 * @param ctx  { root, cfg }
 * @param opt  { session }(省略すると playwright-cli の既定のセッション)
 * @param args playwright-cli の引数(例 ['fill', 'e5', '<env:pms.password>'])
 * @returns {{ code: number, out: string }}
 */
export function pwcli(ctx, opt, args) {
  const { root, cfg } = ctx;
  if (args.length === 0) throw new UsageError('pwcli [--session <名前>] -- <playwright-cli の引数...>');
  const masks = secretsToMask(root);
  const warnings = [];
  const argv = args.map((a) => {
    const x = resolveEnvArg(cfg, root, a, masks, warnings);
    if (x.error) throw new UsageError(x.error);
    return x.actual;
  });
  // open には pms act と同じ playwright-cli の設定ファイル(locale など)を渡す。--config を自分で書いたときはそれに従う
  if (argv[0] === 'open' && !argv.some((a) => a === '--config' || a.startsWith('--config='))) {
    const bc = browserConfigArgs(cfg, root);
    if (bc.warning) warnings.push(bc.warning);
    argv.push(...bc.args);
  }
  const cli = new PlaywrightCli(cfg, opt.session, root);
  const r = opt.session ? cli.call(argv) : cli.callDefault(argv);
  const text = [r.stdout.replace(/\n*$/, ''), r.stderr.trim() ? `--- stderr ---\n${r.stderr.replace(/\n*$/, '')}` : '', ...warnings.map((w) => `警告: ${w}`)]
    .filter(Boolean).join('\n');
  return { code: r.code === 0 ? 0 : 1, out: mask(text, masks) };
}
