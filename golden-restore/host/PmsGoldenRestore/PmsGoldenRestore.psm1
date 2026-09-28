#Requires -Version 5.1
<#
  PmsGoldenRestore — Hyper-V ホスト側の復元モジュール
  JEA エンドポイント(PmsGoldenRestore)経由でのみ呼ばれる想定。
  公開関数は Restore-PmsGoldenImage / Get-PmsGoldenImageInfo の2つだけ。
  対象VM名・チェックポイント名は呼び出し側から指定させず、ホストの設定ファイルに固定する
  (AI やクライアントが別VM・別チェックポイントを操作する経路を作らないため)。

  設定ファイル : %ProgramData%\PmsGoldenRestore\config.psd1   (管理者のみ書込)
  状態(ログ/ロック): %ProgramData%\PmsGoldenRestore\state\    (Hyper-V Administrators に変更権限)
#>
Set-StrictMode -Version Latest

$script:BaseDir    = Join-Path $env:ProgramData 'PmsGoldenRestore'
$script:ConfigPath = Join-Path $script:BaseDir 'config.psd1'
$script:StateDir   = Join-Path $script:BaseDir 'state'
$script:LogPath    = Join-Path $script:StateDir 'restore.log'
$script:LockPath   = Join-Path $script:StateDir 'restore.lock'

function Get-RestoreConfig {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
        throw "CONFIG_NOT_FOUND: $($script:ConfigPath)"
    }
    $cfg = Import-PowerShellDataFile -LiteralPath $script:ConfigPath
    foreach ($key in @('VMName', 'CheckpointName')) {
        if (-not $cfg.ContainsKey($key) -or [string]::IsNullOrWhiteSpace([string]$cfg[$key])) {
            throw "CONFIG_INVALID: '$key' is required in $($script:ConfigPath)"
        }
    }
    $defaults = @{
        StopTimeoutSec      = 120    # 電源断(TurnOff)後に Off になるまでの上限
        BootTimeoutSec      = 900    # 起動後、ハートビートが OK になるまでの上限
        PollIntervalSec     = 5      # 状態確認の間隔(固定待機ではなく状態成立までのポーリング間隔)
        RequireHeartbeat    = $true  # 統合サービスのハートビートを待つか。無効化している場合は $false
    }
    foreach ($k in $defaults.Keys) {
        if (-not $cfg.ContainsKey($k)) { $cfg[$k] = $defaults[$k] }
    }
    return $cfg
}

function Write-RestoreLog {
    param([string]$Line)
    try {
        if (-not (Test-Path -LiteralPath $script:StateDir)) {
            New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
        }
        $stamp = (Get-Date).ToString('o')
        Add-Content -LiteralPath $script:LogPath -Value "$stamp`t$Line" -Encoding UTF8
    } catch {
        # ログ書込失敗で復元自体を失敗させない
    }
}

function Get-ErrorCode {
    param([string]$Message)
    if ($Message -match '^([A-Z_]{3,40}):') { return $Matches[1] }
    return 'HYPERV_ERROR'
}

function Wait-Condition {
    param(
        [scriptblock]$Condition,
        [int]$TimeoutSec,
        [int]$IntervalSec
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        if (& $Condition) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Seconds $IntervalSec
    }
}

function Get-PmsGoldenImageInfo {
    <#
      .SYNOPSIS 接続確認用。対象VMとチェックポイントの状態を返す(変更は一切しない)。
    #>
    [CmdletBinding()]
    param()
    $cfg = Get-RestoreConfig
    $vm = Get-VM -Name $cfg.VMName -ErrorAction Stop
    $snaps = @(Get-VMSnapshot -VM $vm -Name $cfg.CheckpointName -ErrorAction SilentlyContinue)
    $created = $null
    $type = $null
    if ($snaps.Count -eq 1) {
        $created = $snaps[0].CreationTime.ToString('o')
        $type = [string]$snaps[0].SnapshotType
    }
    [pscustomobject]@{
        HostName              = $env:COMPUTERNAME
        VMName                = $vm.Name
        State                 = [string]$vm.State
        Heartbeat             = [string]$vm.Heartbeat
        CheckpointName        = $cfg.CheckpointName
        CheckpointCount       = $snaps.Count
        CheckpointCreatedAt   = $created
        CheckpointType        = $type
    }
}

function Restore-PmsGoldenImage {
    <#
      .SYNOPSIS 設定で固定したVMを、設定で固定したチェックポイントへ戻して起動する。
      .DESCRIPTION
        1. 同名チェックポイントがちょうど1つあることを確認
        2. VM を電源断(TurnOff。状態は破棄されるため正常シャットダウンは不要)
        3. チェックポイントを適用(運用チェックポイントなので適用後は Off)
        4. 起動し、ハートビートが OK になるまでポーリング
        PMS がテスト可能になったか(Web UI にログインできるか)は、テストを実行する側の
        ネットワーク経路で確かめるべきなのでクライアント側スクリプトが行う。
      .PARAMETER RestoreId  クライアントが採番した復元ID(ログ突合用)
      .PARAMETER Purpose    regression / work10 / work20 / manual(ログ用)
    #>
    [CmdletBinding()]
    param(
        [ValidatePattern('^[A-Za-z0-9_\-]{1,64}$')]
        [string]$RestoreId = 'none',
        [ValidateSet('regression', 'work10', 'work20', 'manual')]
        [string]$Purpose = 'manual'
    )

    $started = Get-Date
    $lock = $null
    $cfg = $null
    $result = [ordered]@{
        Success             = $false
        ErrorCode           = $null
        Message             = $null
        RestoreId           = $RestoreId
        Purpose             = $Purpose
        HostName            = $env:COMPUTERNAME
        VMName              = $null
        CheckpointName      = $null
        CheckpointCreatedAt = $null
        StartedAt           = $started.ToString('o')
        CompletedAt         = $null
        DurationSec         = $null
        Heartbeat           = $null
    }

    try {
        $cfg = Get-RestoreConfig
        $result.VMName = $cfg.VMName
        $result.CheckpointName = $cfg.CheckpointName

        if (-not (Test-Path -LiteralPath $script:StateDir)) {
            New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
        }
        try {
            $lock = [System.IO.File]::Open($script:LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
        } catch {
            throw 'LOCKED: another restore is in progress on this host'
        }

        Write-RestoreLog "BEGIN`t$RestoreId`t$Purpose`t$($cfg.VMName)`t$($cfg.CheckpointName)"

        $vm = Get-VM -Name $cfg.VMName -ErrorAction Stop
        $snaps = @(Get-VMSnapshot -VM $vm -Name $cfg.CheckpointName -ErrorAction Stop)
        if ($snaps.Count -ne 1) {
            throw "CHECKPOINT_AMBIGUOUS: expected exactly 1 checkpoint named '$($cfg.CheckpointName)', found $($snaps.Count)"
        }
        $snap = $snaps[0]
        $result.CheckpointCreatedAt = $snap.CreationTime.ToString('o')

        # 1) 電源断
        if ([string]$vm.State -ne 'Off') {
            Stop-VM -VM $vm -TurnOff -Force -ErrorAction Stop
            $off = Wait-Condition -TimeoutSec $cfg.StopTimeoutSec -IntervalSec $cfg.PollIntervalSec -Condition {
                [string](Get-VM -Name $cfg.VMName).State -eq 'Off'
            }
            if (-not $off) { throw "STOP_TIMEOUT: VM did not reach Off within $($cfg.StopTimeoutSec)s" }
        }

        # 2) チェックポイント適用
        Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false -ErrorAction Stop

        # 3) 起動
        Start-VM -Name $cfg.VMName -ErrorAction Stop

        # 4) 起動完了の確認
        if ($cfg.RequireHeartbeat) {
            $ok = Wait-Condition -TimeoutSec $cfg.BootTimeoutSec -IntervalSec $cfg.PollIntervalSec -Condition {
                [string](Get-VM -Name $cfg.VMName).Heartbeat -like 'Ok*'
            }
            if (-not $ok) {
                $hb = [string](Get-VM -Name $cfg.VMName).Heartbeat
                throw "HEARTBEAT_TIMEOUT: heartbeat='$hb' after $($cfg.BootTimeoutSec)s"
            }
        } else {
            $ok = Wait-Condition -TimeoutSec $cfg.BootTimeoutSec -IntervalSec $cfg.PollIntervalSec -Condition {
                [string](Get-VM -Name $cfg.VMName).State -eq 'Running'
            }
            if (-not $ok) { throw "BOOT_TIMEOUT: VM did not reach Running within $($cfg.BootTimeoutSec)s" }
        }

        $result.Heartbeat = [string](Get-VM -Name $cfg.VMName).Heartbeat
        $result.Success = $true
        $result.Message = 'restored'
    } catch {
        $msg = $_.Exception.Message
        $result.ErrorCode = Get-ErrorCode $msg
        $result.Message = $msg
    } finally {
        $done = Get-Date
        $result.CompletedAt = $done.ToString('o')
        $result.DurationSec = [math]::Round(($done - $started).TotalSeconds, 1)
        $status = 'FAIL'
        if ($result.Success) { $status = 'OK' }
        Write-RestoreLog "END`t$RestoreId`t$status`t$($result.ErrorCode)`t$($result.DurationSec)s`t$($result.Message)"
        if ($lock) { $lock.Dispose() }
    }

    return [pscustomobject]$result
}

Export-ModuleMember -Function Restore-PmsGoldenImage, Get-PmsGoldenImageInfo
