#Requires -Version 5.1
<#
.SYNOPSIS
  pms-remote — リモートコマンドの CLI 本体(docs/003_リモートコマンド整備方針.html 第1部 6章)。
  skill もテストコードも JEA を直接呼ばず、この CLI だけを呼ぶ(W-1)。

.DESCRIPTION
  pms-remote.ps1 <サブコマンド> [-Target <接続先名>] [引数]
  リポジトリのルートで実行する(クライアント設定 config/remote-targets.json を上位へ探索する。PMS_REMOTE_CONFIG で上書き可)。

  サブコマンド:
    info          -Target <名前>                         版・ロール・モジュールと設定がリポジトリと同じかを返す
    check-target  -Target <名前>                         接続先の一度きりの前提(WinRM・管理者・パスワード無期限など)を確かめる
    deploy        -Target <名前> [-Force]                共通インストーラを接続先へ送り込んで実行する(配置用の資格情報を使う)
    cred-set      <参照名> [-UserName <コンピューター名>\<ユーザー名>]
                                                         資格情報を参照名で保存する(端末で対話入力。パスワードは2回)
    restore       [-Purpose ...] [-FlowId ...] [-SkipReadiness] [-InfoOnly]
                                                         ゴールデンイメージの復元(復元後の配置・起動確認を含む)
    logs-collect  -From <時刻> -To <時刻> -OutDir <dir> [-InfoOnly]
                                                         ログ収集(ログIDと件数の一覧を返す)
    logs-ids      -OutDir <dir>                          集めたログ一式から一覧だけを作り直す(接続しない)

  出力(6.2): 標準出力の最後の1行に JSON(snake_case。非ASCII は \uXXXX)。進捗は標準エラー。
  共通のキー: success / command / target / error_code / message / started_at / completed_at / duration_sec
  終了コード: 0 = 成功 / 1 = 実行の失敗 / 2 = 設定・資格情報・引数・実行環境の誤り / 3 = 実行中(LOCKED) /
             4 = 成功したが人間の確認が要る(restore で起動確認テストがまだない)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 info -Target pms-vm
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\remote\pms-remote.ps1 logs-collect -From 2026-10-03T13:49:50+09:00 -To 2026-10-03T13:56:10+09:00 -OutDir work\PRT\health\inquiries\SC-PRT-03-1-logs
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Command = '',
    [Parameter(Position = 1)][string]$Name = '',
    [string]$Target = '',
    [string]$ConfigPath = '',
    # restore
    [string]$Purpose = 'manual',
    [string]$FlowId = '',
    [switch]$SkipReadiness,
    [switch]$InfoOnly,
    # logs-collect / logs-ids
    [string]$From = '',
    [string]$To = '',
    [string]$OutDir = '',
    # deploy
    [switch]$Force,
    # cred-set
    [string]$UserName = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$libDir = Join-Path $PSScriptRoot 'lib'
foreach ($lib in @('Client.ps1', 'Core.ps1', 'Restore.ps1', 'Logs.ps1')) {
    . (Join-Path $libDir $lib)
}

$Out = New-Result $Command $Target
try {
    switch ($Command) {
        'info'         { Invoke-InfoCommand (Read-RemoteConfig $ConfigPath) $Target }
        'check-target' { Invoke-CheckTargetCommand (Read-RemoteConfig $ConfigPath) $Target }
        'deploy'       { Invoke-DeployCommand -cfg (Read-RemoteConfig $ConfigPath) -targetName $Target -Force:$Force }
        'cred-set'     { Invoke-CredSetCommand $Name $UserName }
        'restore'      { Invoke-RestoreCommand -cfg (Read-RemoteConfig $ConfigPath) -purpose $Purpose -flowId $FlowId -SkipReadiness:$SkipReadiness -InfoOnly:$InfoOnly -targetOverride $Target }
        'logs-collect' { Invoke-LogsCollectCommand -cfg (Read-RemoteConfig $ConfigPath) -from $From -to $To -outDir $OutDir -InfoOnly:$InfoOnly -targetOverride $Target }
        'logs-ids'     { Invoke-LogsIdsCommand (Read-RemoteConfig $ConfigPath) $OutDir }
        default {
            throw "UNKNOWN_COMMAND: '$Command' (commands: info, check-target, deploy, cred-set, restore, logs-collect, logs-ids)"
        }
    }
} catch {
    Set-ResultError $_.Exception.Message
} finally {
    Close-RemoteSessions
}

$exitCode = Complete-Result
$json = ConvertTo-AsciiJson $Out
try { Save-CollectResult $json } catch { Write-Log "WARN: cannot write $($script:ResultFileName): $($_.Exception.Message)" }
[Console]::Out.WriteLine($json)
exit $exitCode
