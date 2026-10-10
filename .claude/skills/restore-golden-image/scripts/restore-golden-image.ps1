#Requires -Version 5.1
<#
.SYNOPSIS
  PMS 検証環境をゴールデンイメージへ戻す。外部操作 skill "restore-golden-image"(操作ID OP-VM-001)の同梱実行体。
  リモートコマンドの CLI 本体 tools/remote/pms-remote.ps1 の restore を呼ぶだけの薄い入口(docs/003 W-3)。

.DESCRIPTION
  CLI の restore が行うこと:
    1. Hyper-V ホストの JEA エンドポイント PmsRemote で Restore-PmsGoldenImage(停止 → チェックポイント適用 → 起動)
    2. 復元した PMS VM にリモートコマンドの窓口を配置し直す(失敗しても復元は成功として扱い、出力の deploy に残す)
    3. 起動完了の確認(Web UI へのログイン。テストコード側の起動確認テストを呼ぶ)
    4. 復元記録(マーカー)を追記

  出力: 標準出力の最後の1行に JSON(restore_id / purpose / readiness / deploy など)。進捗は標準エラー。
  終了コード:
    0 = 復元し、起動確認(ログイン)まで成功(-SkipReadiness 時は復元のみ成功)
    1 = 復元または起動確認の失敗
    2 = 設定・資格情報・実行環境の誤り
    3 = 別の復元が実行中
    4 = 復元は成功。起動確認テストがまだないため、起動完了は人間が確かめる

.PARAMETER Purpose        regression / work10 / work20 / manual
.PARAMETER FlowId         作業10・20 のときのフローID(例: F-003)。復元記録に残る
.PARAMETER SkipReadiness  起動確認を呼ばない(globalSetup 用)
.PARAMETER InfoOnly       復元せず、接続確認と対象の状態表示だけ行う

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File restore-golden-image.ps1 -Purpose work10 -FlowId F-003
#>
[CmdletBinding()]
param(
    [string]$Purpose = 'manual',
    [string]$FlowId = '',
    [string]$ConfigPath = '',
    [switch]$SkipReadiness,
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
    [Console]::Out.WriteLine('{"success":false,"command":"restore","error_code":"CLI_NOT_FOUND","message":"CLI_NOT_FOUND: tools/remote/pms-remote.ps1 not found. Run from the repository root."}')
    exit 2
}
$a = @{ Purpose = $Purpose; FlowId = $FlowId; ConfigPath = $ConfigPath; SkipReadiness = $SkipReadiness; InfoOnly = $InfoOnly }
& $cli restore @a
exit $LASTEXITCODE
