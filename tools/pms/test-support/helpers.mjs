// helpers.mjs — pms のテストの共通の部品(test/ の外に置く。node --test が test/ の中の .mjs をすべてテストとして実行するため)(一時ディレクトリに小さなリポジトリを作る)
//
// 正本(procedure/ の vocab・00・stages・cards・schemas・templates)は実物を写す。
// playwright-cli は偽物(stub-playwright-cli.mjs)、環境情報は偽物の設定ファイル(config/environments*.json)に差し替える。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PMS_DIR = path.resolve(here, '..');
export const REAL_ROOT = path.resolve(PMS_DIR, '..', '..');
export const STUB = path.join(here, 'stub-playwright-cli.mjs');

export const SECRET = 'S3cret-Passw0rd!';
export const ADMIN_USER = 'e2e-admin01';
export const NOW = '2026-10-07T10:00:00+09:00';

export const SCENARIOS = `---
review_status: unreviewed
flow_id: F-003
---

## SC-PRT-01: 印刷ジョブの投入と実行結果の確認

- **策定方式**: manual_usecase(F-003)
- **requires**: S-ADMIN-LOGIN, S-DEVICE-REGISTERED

| Step ID | 順序 | 項目名 | 確認内容 | 期待結果 | 検証手段 | 根拠 | review |
|---|---|---|---|---|---|---|---|
| SC-PRT-01-S1 | 1 | 投入 | 印刷指示 | 受付 | 両方 | 利用者マニュアル4-2 | unreviewed |

## SC-PRT-02: ジョブログの表示

- **策定方式**: manual_usecase(F-003)
- **requires**: S-ADMIN-LOGIN, S-JOBLOG-EXISTS

| Step ID | 順序 | 項目名 | 確認内容 | 期待結果 | 検証手段 | 根拠 | review |
|---|---|---|---|---|---|---|---|
| SC-PRT-02-S1 | 1 | 表示 | 一覧 | 表示 | 画面 | 画面観察 | unreviewed |

## SC-PRT-09: 前のフローのシナリオ

- **策定方式**: manual_usecase(F-001)
- **requires**: S-USER-LOGIN
`;

export const LOGIN_PAGE = {
  url: 'about:blank',
  refs: {
    e3: { locator: "getByLabel('ユーザーID')", count: 1, visible: true },
    e5: { locator: "getByLabel('パスワード')", count: 1, visible: true },
    e7: { locator: "getByRole('button', { name: 'ログイン' })", count: 1, visible: true, next_url: 'https://pms.test/menu' },
    e9: { locator: "locator('div.menu > a')", count: 1, visible: true },
    e10: { locator: "getByRole('link', { name: '詳細' })", count: 2, visible: true },
    e12: { locator: "getByRole('link', { name: 'ログアウト' })", count: 1, visible: true, text: 'ログアウト' },
    e20: { locator: "getByText('どこにもない')", count: 0, visible: false },
  },
  fail: [],
};

export function makeRepo(files = {}, { config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-'));
  for (const f of ['vocab.yaml', '00_common.md', 'stages.md']) copy(path.join('procedure', f), root);
  for (const d of ['cards', 'schemas', 'templates']) {
    for (const f of fs.readdirSync(path.join(REAL_ROOT, 'procedure', d))) copy(path.join('procedure', d, f), root);
  }
  const stubDir = path.join(root, '.stub');
  fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, 'page.json'), JSON.stringify(LOGIN_PAGE));
  const base = {
    'config/pms.json': JSON.stringify({ playwright_cli: [process.execPath, STUB], playwright_cli_version: '0.1.22', ...config }),
    'config/environments.json': JSON.stringify({
      default: 'vm01',
      environments: {
        vm01: {
          attributes: {
            'pms.url': { kind: 'endpoint', value: 'https://pms.test/login' },
            'pms.admin.user': { kind: 'account', value: ADMIN_USER },
            'pms.admin.password': { kind: 'secret' },
          },
        },
      },
    }),
    'config/playwright-cli.json': JSON.stringify({ browser: { contextOptions: { locale: 'ja-JP' } } }),
    'config/environments.local.json': JSON.stringify({ environments: { vm01: { attributes: { 'pms.admin.password': { kind: 'secret', value: SECRET } } } } }),
    'work/PRT/scenarios.md': SCENARIOS,
  };
  for (const [rel, content] of Object.entries({ ...base, ...files })) {
    if (content === null) continue;
    write(root, rel, content);
  }
  return root;
}

export function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

export function read(root, rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
export function exists(root, rel) { return fs.existsSync(path.join(root, rel)); }

function copy(rel, root) {
  const dst = path.join(root, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, rel), dst);
}

/** pms を実行する。JSON の出力は json に入る(snapshot は「--- pms ---」の後ろの JSON) */
export function pms(root, args, { now = NOW, env = {} } = {}) {
  const e = { ...process.env, PMS_STUB_DIR: path.join(root, '.stub'), PMS_NOW: now, ...env };
  delete e.PMS_ENV;
  const r = spawnSync(process.execPath, [path.join(PMS_DIR, 'pms.mjs'), '--root', root, ...args], { encoding: 'utf8', env: e });
  let json = null;
  const tail = r.stdout.includes('\n--- pms ---\n') ? r.stdout.split('\n--- pms ---\n').pop() : r.stdout;
  try { json = JSON.parse(tail); } catch { /* status のテキストなど */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

export function stubCalls(root) {
  const f = path.join(root, '.stub', 'calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export function actLog(root, feature = 'PRT') {
  const f = path.join(root, `work/${feature}/exploration/act-log.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export function queue(root, flow = 'F-003') { return JSON.parse(read(root, `work/_flows/${flow}/queue.json`)); }

/** 出力を書いて提出する */
export function submitOut(root, card, out, flow = 'F-003', opts = {}) {
  write(root, `work/_flows/${flow}/out/${card}.json`, JSON.stringify(out));
  return pms(root, ['submit', '--flow', flow, '--card', card], opts);
}

/** S-ADMIN-LOGIN をログイン画面で作る操作(連番 1〜5)と assert(6) */
export function loginActs(root, card, flow = 'F-003') {
  const a = (args) => pms(root, ['act', '--flow', flow, '--card', card, ...args]);
  return [
    a(['open', '<env:pms.url>']),
    a(['--intent', '管理者IDを入力', 'fill', 'e3', '<env:pms.admin.user>']),
    a(['--intent', 'パスワードを入力', 'fill', 'e5', '<env:pms.admin.password>']),
    a(['snapshot']),
    a(['--intent', 'ログインする', 'click', 'e7']),
    a(['--intent', 'ログアウトのリンクが見える', 'assert', 'e12', 'visible']),
  ];
}
