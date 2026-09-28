/**
 * Playwright globalSetup: 回帰テストセット実行前のゴールデンイメージ復元
 *
 * 環境変数 PMS_RESTORE=1 のときだけ復元する(既定では何もしない)。
 *   - 回帰テストの一括実行・CI:  PMS_RESTORE=1 で起動 → 実行前に必ず1回復元
 *   - 作業20の実行確認(復元せず3回連続実行)・個別のデバッグ実行: 付けない → 復元しない
 *
 * 復元の判断にAIは関与しない。成否は実行体の終了コードと出力JSONだけで決める。
 *
 * 起動完了の確認(Web UI へのログイン成功)はここでは行わない(-SkipReadiness)。
 * 起動確認テスト tests/readiness/server-ready.setup.ts を setup project `readiness` とし、
 * 全 project の依存にしておくことで、globalSetup の復元のあと、どのテストよりも先に走る。
 *
 * 環境変数:
 *   PMS_RESTORE=1          復元を有効化
 *   PMS_RESTORE_SCRIPT     実行体のパス(既定: .kiro/skills/restore-golden-image/scripts/restore-golden-image.ps1)
 *   PMS_POWERSHELL         PowerShell 実行ファイル(既定: powershell.exe。pwsh でも可)
 *   PMS_RESTORE_CONFIG     設定ファイルのパス(既定: config/golden-restore.json を上位探索)
 *
 * playwright.config.ts:
 *   export default defineConfig({ globalSetup: './tests/global-setup.ts', ... });
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { FullConfig } from '@playwright/test';

interface RestoreResult {
  success: boolean;
  restore_id: string;
  error_code: string | null;
  message: string | null;
  duration_sec: number | null;
}

const DEFAULT_SCRIPT = '.kiro/skills/restore-golden-image/scripts/restore-golden-image.ps1';
const RESTORE_TIMEOUT_MS = 30 * 60 * 1000;

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.PMS_RESTORE !== '1') {
    console.log('[golden-restore] skipped (set PMS_RESTORE=1 to restore before the run)');
    return;
  }

  const script = path.resolve(process.cwd(), process.env.PMS_RESTORE_SCRIPT ?? DEFAULT_SCRIPT);
  const shell = process.env.PMS_POWERSHELL ?? 'powershell.exe';
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Purpose', 'regression', '-SkipReadiness',
  ];

  console.log(`[golden-restore] restoring via ${script}`);
  let stdout = '';
  try {
    stdout = execFileSync(shell, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'], // 進捗(stderr)はそのまま表示
      timeout: RESTORE_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (e) {
    // 終了コード≠0 でも stdout に結果JSONがあるので取り出す
    const err = e as { stdout?: string; message?: string };
    stdout = err.stdout ?? '';
    if (!stdout) {
      throw new Error(`[golden-restore] failed to run restore script: ${err.message ?? String(e)}`);
    }
  }

  const lastLine = stdout.trim().split(/\r?\n/).pop() ?? '';
  let result: RestoreResult;
  try {
    result = JSON.parse(lastLine) as RestoreResult;
  } catch {
    throw new Error(`[golden-restore] unexpected output: ${lastLine}`);
  }

  if (!result.success) {
    // 復元できていない環境でスイートを走らせない
    throw new Error(`[golden-restore] ${result.error_code}: ${result.message}`);
  }

  process.env.PMS_RESTORE_ID = result.restore_id; // レポートや afterAll での記録用
  console.log(`[golden-restore] restored: ${result.restore_id} (${result.duration_sec}s). Web UI login is checked by the readiness project next.`);
}
