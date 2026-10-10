#Requires -Version 5.1
<#
.SYNOPSIS
  PMS サーバーの、指定した時間範囲のログを製品のログ収集ツールでマスクして集め、作業場所に保存する。
  外部操作 skill "collect-server-logs"(SK-LOG)の同梱実行体。
  リモートコマンドの CLI 本体 tools/remote/pms-remote.ps1 の logs-collect / logs-ids を呼ぶだけの薄い入口(docs/003 W-3)。

.DESCRIPTION
  -Mode collect(既定) pms-remote.ps1 logs-collect -From -To -OutDir
                       PMS サーバーVMの JEA エンドポイント PmsRemote で Invoke-PmsLogCollect を呼び、集めた一式を -OutDir に展開して、
                       ログIDと件数の一覧を返す(ログの本文は返さない)
  -Mode ids            pms-remote.ps1 logs-ids -OutDir(すでに集めた一式から一覧だけを作り直す。接続しない)
  -InfoOnly            pms-remote.ps1 logs-collect -InfoOnly(ツールを実行せず、設定・マスクの指定・ツールの有無を確かめる)

  出力: 標準出力の最後の1行に JSON。進捗は標準エラー。
  終了コード: 0 = 成功 / 1 = 収集の失敗 / 2 = 設定・資格情報・引数・実行環境の誤り / 3 = 実行中

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File collect-server-logs.ps1 -From 2026-10-03T13:49:50+09:00 -To 2026-10-03T13:56:10+09:00 -OutDir work\PRT\health\inquiries\SC-PRT-03-1-logs
#>
[CmdletBinding()]
param(
    [ValidateSet('collect', 'ids')]
    [string]$Mode = 'collect',
    [string]$From = '',
    [string]$To = '',
    [string]$OutDir = '',
    [string]$ConfigPath = '',
    [switch]$InfoOnly
)

function Find-PmsRemoteCli {
    # リポジトリのルート(カレントから上位)と、この skill の位置から上位を探す
    foreach ($start in @((Get-Location).Path, $PSScriptRoot)) {
        $dir = $start
        while ($dir) {
            $c = Join-Path (Join-Path (Join-Path $dir 'tools') 'remote') 'pms-remote.ps1'
            if (Test-Path -LiteralPath $c) { return $c }
            $parent = Split-Path -Parent $dir
            if (-not $parent -or $parent -eq $dir) { break }
            $dir = $parent
        }
    }
    return $null
}

$cli = Find-PmsRemoteCli
if (-not $cli) {
    [Console]::Out.WriteLine('{"success":false,"command":"logs-collect","error_code":"CLI_NOT_FOUND","message":"CLI_NOT_FOUND: tools/remote/pms-remote.ps1 not found. Run from the repository root."}')
    exit 2
}
if ($Mode -eq 'ids' -and -not $InfoOnly) {
    & $cli logs-ids -OutDir $OutDir -ConfigPath $ConfigPath
} else {
    & $cli logs-collect -From $From -To $To -OutDir $OutDir -ConfigPath $ConfigPath -InfoOnly:$InfoOnly
}
exit $LASTEXITCODE
