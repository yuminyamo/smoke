/**
 * Playwright globalSetup: 回帰テストセット実行前のゴールデンイメージ復元
 *
 * 【雛形】リポジトリの tests/global-setup.ts に置く(tests/external/remote.ts と一緒に)。
 *
 * 環境変数 PMS_RESTORE=1 のときだけ復元する(既定では何もしない)。
 *   - 回帰テストの一括実行・CI:  PMS_RESTORE=1 で起動 → 実行前に必ず1回復元
 *   - 作業20の実行確認(復元せず3回連続実行)・個別のデバッグ実行: 付けない → 復元しない
 *
 * 復元の判断にAIは関与しない。成否はリモートコマンドの CLI(pms-remote.ps1 restore)の出力 JSON だけで決める。
 * CLI は復元のあと、PMS VM にリモートコマンドの窓口を配置し直す(失敗は警告。出力の deploy に残る)。
 *
 * 起動完了の確認(Web UI へのログイン成功)はここでは行わない(-SkipReadiness)。
 * 起動確認テスト tests/readiness/server-ready.setup.ts を setup project `readiness` とし、
 * 全 project の依存にしておくことで、globalSetup の復元のあと、どのテストよりも先に走る。
 *
 * 環境変数:
 *   PMS_RESTORE=1          復元を有効化
 *   PMS_REMOTE_CLI / PMS_POWERSHELL / PMS_REMOTE_CONFIG  tests/external/remote.ts を参照
 *
 * playwright.config.ts:
 *   export default defineConfig({ globalSetup: './tests/global-setup.ts', ... });
 */
import type { FullConfig } from '@playwright/test';
import { runRemote } from './external/remote';

const RESTORE_TIMEOUT_MS = 30 * 60 * 1000;

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.PMS_RESTORE !== '1') {
    console.log('[golden-restore] skipped (set PMS_RESTORE=1 to restore before the run)');
    return;
  }

  console.log('[golden-restore] restoring via pms-remote.ps1 restore');
  const { result } = runRemote(['restore', '-Purpose', 'regression', '-SkipReadiness'], {
    timeoutMs: RESTORE_TIMEOUT_MS,
  });

  if (!result.success) {
    // 復元できていない環境でスイートを走らせない
    throw new Error(`[golden-restore] ${result.error_code}: ${result.message}`);
  }

  const deploy = (result.deploy as Array<{ target: string; status: string; error_code: string | null }> | undefined) ?? [];
  for (const d of deploy.filter((x) => x.status === 'failed')) {
    console.warn(`[golden-restore] WARN: remote commands on ${d.target} are unavailable (${d.error_code}). The run continues.`);
  }

  process.env.PMS_RESTORE_ID = String(result.restore_id); // レポートや afterAll での記録用
  console.log(`[golden-restore] restored: ${result.restore_id} (${result.duration_sec}s). Web UI login is checked by the readiness project next.`);
}
