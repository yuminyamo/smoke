<#
  PmsRemote — Hyper-V ホスト(ロール HyperVRead / HyperVChange)
  PMS サーバーVM をゴールデンイメージ(チェックポイント)へ戻す(外部操作 OP-VM-001)。
  対象の VM 名・チェックポイント名は呼び出し側から指定させず、設定の Restore セクションで固定する
  (AI やクライアントが別の VM・別のチェックポイントを操作する経路を作らないため)。

  設定(config.psd1):
    Restore = @{
        VMName           = 'PMS-TEST-01'   # 必須
        CheckpointName   = 'golden'        # 必須
        StopTimeoutSec   = 120             # 電源断(TurnOff)後に Off になるまでの上限
        BootTimeoutSec   = 900             # 起動後、ハートビートが OK になるまでの上限
        PollIntervalSec  = 5               # 状態確認の間隔
        RequireHeartbeat = $true           # 統合サービスのハートビートを無効化している場合は $false
    }
#>

$script:RestoreDefaults = @{
    StopTimeoutSec   = 120
    BootTimeoutSec   = 900
    PollIntervalSec  = 5
    RequireHeartbeat = $true
}

function Get-PmsRestoreConfig {
    return Get-PmsConfigSection -Name 'Restore' -Required @('VMName', 'CheckpointName') -Defaults $script:RestoreDefaults
}

function Initialize-PmsHyperV {
    # インストーラが呼ぶ(D-4)。対象VMと同名チェックポイントがちょうど1つあることを確かめる。戻り値は警告の配列
    $cfg = Get-PmsRestoreConfig
    $vm = Get-VM -Name $cfg.VMName -ErrorAction Stop
    $snaps = @(Get-VMSnapshot -VM $vm -Name $cfg.CheckpointName -ErrorAction SilentlyContinue)
    if ($snaps.Count -ne 1) {
        throw "CHECKPOINT_AMBIGUOUS: VM '$($cfg.VMName)' needs exactly 1 checkpoint named '$($cfg.CheckpointName)' (found $($snaps.Count))"
    }
    $warnings = @()
    if ([string]$snaps[0].SnapshotType -notmatch 'Production|Standard') {
        $warnings += "unexpected checkpoint type: $($snaps[0].SnapshotType)"
    }
    return $warnings
}

function Get-PmsGoldenImageInfo {
    <#
      .SYNOPSIS 接続確認用。対象VMとチェックポイントの状態を返す(変更は一切しない)。ロール HyperVRead。
    #>
    [CmdletBinding()]
    param()
    $r = [ordered]@{
        Success             = $false
        ErrorCode           = $null
        Message             = $null
        HostName            = $env:COMPUTERNAME
        VMName              = $null
        State               = $null
        Heartbeat           = $null
        CheckpointName      = $null
        CheckpointCount     = $null
        CheckpointCreatedAt = $null
        CheckpointType      = $null
    }
    try {
        $cfg = Get-PmsRestoreConfig
        $r.VMName = $cfg.VMName
        $r.CheckpointName = $cfg.CheckpointName
        $vm = Get-VM -Name $cfg.VMName -ErrorAction Stop
        $snaps = @(Get-VMSnapshot -VM $vm -Name $cfg.CheckpointName -ErrorAction SilentlyContinue)
        $r.State = [string]$vm.State
        $r.Heartbeat = [string]$vm.Heartbeat
        $r.CheckpointCount = $snaps.Count
        if ($snaps.Count -eq 1) {
            $r.CheckpointCreatedAt = $snaps[0].CreationTime.ToString('o')
            $r.CheckpointType = [string]$snaps[0].SnapshotType
        }
        $r.Success = $true
        $r.Message = 'info'
    } catch {
        $r.Message = $_.Exception.Message
        $r.ErrorCode = Get-PmsErrorCode $r.Message
        if ($r.ErrorCode -eq 'REMOTE_ERROR') { $r.ErrorCode = 'HYPERV_ERROR' }
    }
    return [pscustomobject]$r
}

function Restore-PmsGoldenImage {
    <#
      .SYNOPSIS 設定で固定したVMを、設定で固定したチェックポイントへ戻して起動する。ロール HyperVChange。
      .DESCRIPTION
        1. 同名チェックポイントがちょうど1つあることを確認
        2. VM を電源断(TurnOff。状態は破棄されるため正常シャットダウンは不要)
        3. チェックポイントを適用(運用チェックポイントなので適用後は Off)
        4. 起動し、ハートビートが OK になるまでポーリング
        PMS がテストできる状態になったか(Web UI にログインできるか)は、テストを実行する側の
        ネットワーク経路で確かめるべきなので CLI 側が行う。
      .PARAMETER RestoreId  クライアントが採番した復元ID(記録の突合用)
      .PARAMETER Purpose    regression / work10 / work20 / manual(記録用)
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
        $cfg = Get-PmsRestoreConfig
        $result.VMName = $cfg.VMName
        $result.CheckpointName = $cfg.CheckpointName
        $lock = Enter-PmsLock -Name 'restore' -What 'restore'

        Write-PmsOpLog "RESTORE-BEGIN`t$RestoreId`t$Purpose`t$($cfg.VMName)`t$($cfg.CheckpointName)"

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
            $off = Wait-PmsCondition -TimeoutSec $cfg.StopTimeoutSec -IntervalSec $cfg.PollIntervalSec -Condition {
                [string](Get-VM -Name $cfg.VMName).State -eq 'Off'
            }
            if (-not $off) { throw "STOP_TIMEOUT: VM did not reach Off within $($cfg.StopTimeoutSec)s" }
        }

        # 2) チェックポイント適用
        Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false -ErrorAction Stop

        # 3) 起動
        Start-VM -Name $cfg.VMName -ErrorAction Stop

        # 4) 起動完了の確認(VM としての起動まで。PMS の起動完了は CLI 側の起動確認が判定する)
        if ($cfg.RequireHeartbeat) {
            $ok = Wait-PmsCondition -TimeoutSec $cfg.BootTimeoutSec -IntervalSec $cfg.PollIntervalSec -Condition {
                [string](Get-VM -Name $cfg.VMName).Heartbeat -like 'Ok*'
            }
            if (-not $ok) {
                $hb = [string](Get-VM -Name $cfg.VMName).Heartbeat
                throw "HEARTBEAT_TIMEOUT: heartbeat='$hb' after $($cfg.BootTimeoutSec)s"
            }
        } else {
            $ok = Wait-PmsCondition -TimeoutSec $cfg.BootTimeoutSec -IntervalSec $cfg.PollIntervalSec -Condition {
                [string](Get-VM -Name $cfg.VMName).State -eq 'Running'
            }
            if (-not $ok) { throw "BOOT_TIMEOUT: VM did not reach Running within $($cfg.BootTimeoutSec)s" }
        }

        $result.Heartbeat = [string](Get-VM -Name $cfg.VMName).Heartbeat
        $result.Success = $true
        $result.Message = 'restored'
    } catch {
        $msg = $_.Exception.Message
        $result.ErrorCode = Get-PmsErrorCode $msg
        if ($result.ErrorCode -eq 'REMOTE_ERROR') { $result.ErrorCode = 'HYPERV_ERROR' }
        $result.Message = $msg
    } finally {
        $done = Get-Date
        $result.CompletedAt = $done.ToString('o')
        $result.DurationSec = [math]::Round(($done - $started).TotalSeconds, 1)
        $status = 'FAIL'
        if ($result.Success) { $status = 'OK' }
        Write-PmsOpLog "RESTORE-END`t$RestoreId`t$status`t$($result.ErrorCode)`t$($result.DurationSec)s`t$($result.Message)"
        if ($lock) { $lock.Dispose() }
    }

    return [pscustomobject]$result
}
