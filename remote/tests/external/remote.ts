/**
 * リモートコマンドの CLI 本体(tools/remote/pms-remote.ps1)を子プロセスとして呼ぶヘルパー
 * (docs/003_リモートコマンド整備方針.html W-4)。テストコードは JEA を直接呼ばず、必ずこのヘルパーを使う。
 *
 * 【雛形】リポジトリの tests/external/remote.ts に置く。
 *
 * 約束事(docs/003 6.2):
 *   - CLI は標準出力の最後の1行に JSON を出す(非ASCII は \uXXXX)。進捗は標準エラー(そのまま表示する)
 *   - 終了コード: 0 = 成功 / 1 = 実行の失敗 / 2 = 設定・資格情報・引数の誤り / 3 = 実行中 / 4 = 成功したが人間の確認が要る
 *
 * 環境変数:
 *   PMS_REMOTE_CLI     CLI のパス(既定: tools/remote/pms-remote.ps1。カレントからの相対)
 *   PMS_POWERSHELL     PowerShell の実行ファイル(既定: powershell.exe。pwsh でも可)
 *   PMS_REMOTE_CONFIG  クライアント設定のパス(既定: config/remote-targets.json を上位探索。CLI が読む)
 *
 * 例:
 *   const { result } = runRemote(['logs-collect', '-From', from, '-To', to, '-OutDir', dir]);
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export interface RemoteResult {
  success: boolean;
  command: string;
  target: string | null;
  error_code: string | null;
  message: string | null;
  started_at?: string;
  completed_at?: string;
  duration_sec?: number;
  [key: string]: unknown;
}

export interface RemoteRun {
  exitCode: number;
  result: RemoteResult;
}

export interface RemoteOptions {
  /** 上限時間(ミリ秒)。既定 10 分 */
  timeoutMs?: number;
  /** 実行するディレクトリ(既定: カレント = リポジトリのルート) */
  cwd?: string;
}

const DEFAULT_CLI = 'tools/remote/pms-remote.ps1';

export function runRemote(args: string[], options: RemoteOptions = {}): RemoteRun {
  const cwd = options.cwd ?? process.cwd();
  const cli = path.resolve(cwd, process.env.PMS_REMOTE_CLI ?? DEFAULT_CLI);
  const shell = process.env.PMS_POWERSHELL ?? 'powershell.exe';
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cli, ...args];

  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(shell, argv, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'], // 進捗(stderr)はそのまま表示
      timeout: options.timeoutMs ?? 10 * 60 * 1000,
      windowsHide: true,
    });
  } catch (e) {
    // 終了コード≠0 でも stdout に結果の JSON がある
    const err = e as { stdout?: string; status?: number | null; message?: string };
    stdout = err.stdout ?? '';
    exitCode = err.status ?? 1;
    if (!stdout) {
      throw new Error(`[pms-remote] failed to run ${cli}: ${err.message ?? String(e)}`);
    }
  }

  const lastLine = stdout.trim().split(/\r?\n/).pop() ?? '';
  let result: RemoteResult;
  try {
    result = JSON.parse(lastLine) as RemoteResult;
  } catch {
    throw new Error(`[pms-remote] unexpected output: ${lastLine}`);
  }
  return { exitCode, result };
}
