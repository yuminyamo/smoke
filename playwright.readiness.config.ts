/**
 * 起動確認だけを実行する Playwright 設定(リポジトリのルートに置く)。
 *
 * 復元の実行体(skill restore-golden-image)が、config/golden-restore.json の readiness.command から呼ぶ。
 * globalSetup / globalTeardown を持たない(復元の入れ子や、DB 全体の不変条件検査を起こさないため)。
 */
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  testDir: './tests/readiness',
  testMatch: /server-ready\.setup\.ts/,
  workers: 1,
  retries: 0,
  reporter: 'line',
  // 接続先などは回帰テストの設定と揃える(storageState は起動確認テスト側で使わない)
  use: {
    baseURL: base.use?.baseURL,
    ignoreHTTPSErrors: base.use?.ignoreHTTPSErrors,
  },
});
