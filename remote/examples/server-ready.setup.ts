/**
 * 起動確認テスト — Web UI にログインできれば、サーバーの起動が完了したとみなす
 * (procedure/00_common.md ■回帰実行の環境前提とテストデータ規約 / 起動完了の判定)。
 *
 * - ログイン画面の表示や IIS の応答では判定しない(IIS の外で動く Java アプリケーションサーバーの
 *   起動完了が分からないため)
 * - ログイン操作は、ログイン fixture が使っているシナリオ部品(tests/flows/)を呼ぶ。
 *   ここに別のログイン操作を書かない(ログイン画面が変わったときの修正箇所を1か所にするため)
 * - 成功の判定は、ログイン fixture の established check と同じ条件にする
 * - 保存済みセッション(storageState)は使わない。試行ごとに Cookie のない新しいコンテキストでログインし直す
 *   (browser.newContext() は project の use.storageState を引き継がない)
 *
 * 【雛形】tests/readiness/server-ready.setup.ts の例。ログイン状態の fixture を初めて整備したフローの作業10(フェーズA)が、
 * この形で tests/readiness/ に作る。▼▲ の間を実際の部品に合わせる。ファイルが存在すると、以後の復元で起動確認が自動で行われる。
 * ログイン fixture がないうちにこの雛形を tests/readiness/ へ置かないこと(部品がなく起動確認が必ず失敗する)。
 *
 * 実行:
 *   単独(復元の実行体が呼ぶ) … npx playwright test -c playwright.readiness.config.ts
 *   回帰テストの一括実行     … playwright.config.ts の setup project `readiness`(全 project の依存)
 * 上限時間: 環境変数 PMS_READY_TIMEOUT_SEC(既定 900 秒)
 */
import { test, type Page } from '@playwright/test';

// ▼ ログイン fixture と同じ部品に合わせる(例。実際の部品名・引数に置き換える)
import { loginAsUser, assertLoggedIn } from '../flows/auth';

async function login(page: Page): Promise<void> {
  await loginAsUser(page); // ログイン fixture が呼んでいるのと同じ部品・同じアカウント
}
async function established(page: Page): Promise<void> {
  await assertLoggedIn(page); // ログイン fixture の established check と同じ確認(例: ログアウトリンクが見える)
}
// ▲

const TOTAL_MS = Number(process.env.PMS_READY_TIMEOUT_SEC ?? 900) * 1000;
const INTERVAL_MS = 10_000; // 試行の間隔(状態成立までのポーリング間隔)
const ATTEMPT_MS = 30_000;  // 1回の試行の上限

test('server ready: Web UI login succeeds', async ({ browser }, testInfo) => {
  test.setTimeout(TOTAL_MS + 60_000);
  const deadline = Date.now() + TOTAL_MS;
  let lastError = '';

  for (let attempt = 1; ; attempt++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(ATTEMPT_MS);
    page.setDefaultNavigationTimeout(ATTEMPT_MS);
    try {
      await login(page);
      await established(page);
      await context.close();
      console.log(`[readiness] Web UI login succeeded (attempt ${attempt})`);
      return;
    } catch (e) {
      lastError = String((e as Error)?.message ?? e).split('\n')[0];
      if (Date.now() + INTERVAL_MS >= deadline) {
        // 最後の試行の画面を残す(ログイン画面の変化で部品が壊れたのか、サーバーが未起動なのかの切り分け用)
        const shot = await page.screenshot({ fullPage: true }).catch(() => null);
        if (shot) await testInfo.attach('last-attempt', { body: shot, contentType: 'image/png' });
        await context.close();
        throw new Error(
          `[readiness] Web UI login did not succeed within ${TOTAL_MS / 1000}s ` +
          `(attempts: ${attempt}). last error: ${lastError}`,
        );
      }
      await context.close();
      console.log(`[readiness] not ready (attempt ${attempt}): ${lastError}`);
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  }
});
