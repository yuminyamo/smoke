<#
  pms-remote CLI — restore(ゴールデンイメージの復元。外部操作 OP-VM-001)
  1. hyperv-host(既定。restore.target)の HyperVChange で Restore-PmsGoldenImage(停止 → チェックポイント適用 → 起動)
  2. restoredBy がこの接続先を指す接続先(pms-vm など)に、WinRM の応答を待ってから deploy(docs/003 5.3)
     配置に失敗しても復元は成功として扱い、出力の deploy に記録する(警告)
  3. 起動完了の確認(Web UI へのログイン)。判定の中身はテストコード側の起動確認テストが持つ。ここは restore.readiness.command を呼ぶだけ
     - 起動確認テストがまだない(ログイン fixture 未整備)場合は終了コード 4。人間がログインを確かめる
     - -SkipReadiness のときは呼ばない(回帰テストの一括実行では setup project が行う)
  4. 復元記録(マーカー)を JSON Lines で追記(lint env_restored が参照する)

  出力のキー(従来の restore-golden-image.ps1 と同じ): restore_id / purpose / flow_id / readiness / vm / checkpoint /
  checkpoint_created_at / restore_sec / readiness_sec / marker_log / deploy
  終了コード: 0 = 成功 / 1 = 復元または起動確認の失敗 / 2 = 設定・資格情報・実行環境の誤り / 3 = 別の復元が実行中 /
             4 = 復元は成功。起動確認テストがまだないため、起動完了は人間が確かめる
#>

function Write-RestoreMarker($obj, [string]$path) {
    try {
        $dir = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $line = New-Object psobject -Property $obj | ConvertTo-Json -Compress -Depth 6
        [System.IO.File]::AppendAllText($path, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-Log "WARN: cannot write the restore marker: $($_.Exception.Message)"
    }
}

function Wait-TargetWinRM($t, [int]$timeoutSec) {
    $p = @{ ComputerName = $t.Host; ErrorAction = 'Stop' }
    if ($t.Transport -eq 'https') { $p.UseSSL = $true }
    if ($t.Port -gt 0) { $p.Port = $t.Port }
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ($true) {
        try { $null = Test-WSMan @p; return $true } catch { }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Seconds 5
    }
}

function Invoke-RestoreCommand($cfg, [string]$purpose, [string]$flowId, [switch]$SkipReadiness, [switch]$InfoOnly, [string]$targetOverride) {
    if (@('regression', 'work10', 'work20', 'manual') -notcontains $purpose) {
        throw "INVALID_ARGUMENT: -Purpose must be regression, work10, work20 or manual"
    }
    if ($flowId -and $flowId -notmatch '^[A-Za-z0-9_\-]{1,32}$') { throw 'INVALID_ARGUMENT: -FlowId must match ^[A-Za-z0-9_\-]{1,32}$' }

    $rc = Get-Prop $cfg 'restore' $null
    $targetName = [string](Get-Prop $rc 'target' 'hyperv-host')
    if ($targetOverride) { $targetName = $targetOverride }
    $Out.target = $targetName
    $readinessCfg = Get-Prop $rc 'readiness' $null
    $readyCmd = @(Get-Prop $readinessCfg 'command' @())
    $readyReq = [string](Get-Prop $readinessCfg 'requiredPath' 'tests/readiness/server-ready.setup.ts')
    $readyTimeout = [int](Get-Prop $readinessCfg 'timeoutSec' 900)
    $winrmTimeout = [int](Get-Prop $rc 'winrmTimeoutSec' 30)
    $markerRel = [string](Get-Prop $rc 'markerLog' 'work/_common/env-restore-log.jsonl')
    $markerLog = $markerRel
    if (-not [System.IO.Path]::IsPathRooted($markerRel)) { $markerLog = Join-Path $script:RepoRoot $markerRel }

    $Out.restore_id = $null
    $Out.purpose = $purpose
    $Out.flow_id = $flowId
    $Out.readiness = $null      # verified / unavailable / skipped
    $Out.host = $null
    $Out.vm = $null
    $Out.checkpoint = $null
    $Out.checkpoint_created_at = $null
    $Out.restore_sec = $null
    $Out.readiness_sec = $null
    $Out.deploy = @()
    $Out.marker_log = $markerLog

    $c = Connect-RemoteTarget $cfg $targetName
    $Out.host = $c.Target.Host

    # --- 接続確認のみ(HyperVRead) ------------------------------------------------
    if ($InfoOnly) {
        $info = Invoke-Remote $c.Session 'Get-PmsGoldenImageInfo'
        Assert-RemoteSuccess $info
        $Out.vm = $info.VMName
        $Out.checkpoint = $info.CheckpointName
        $Out.checkpoint_created_at = $info.CheckpointCreatedAt
        $Out.info = [ordered]@{
            state = $info.State; heartbeat = $info.Heartbeat
            checkpoint_count = $info.CheckpointCount; checkpoint_type = $info.CheckpointType
            readiness_test_present = (Test-Path -LiteralPath (Join-Path $script:RepoRoot $readyReq))
            version = [string]$c.Info.Version
        }
        $Out.success = $true
        $Out.message = 'info'
        return
    }

    # --- 復元(HyperVChange) -------------------------------------------------------
    $restoreId = 'RST-{0}-{1}' -f $script:Started.ToString('yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 4))
    $Out.restore_id = $restoreId
    try {
        Write-Log "restore start: target=$targetName ($($c.Target.Host)) id=$restoreId purpose=$purpose"
        $r = Invoke-Remote $c.Session "Restore-PmsGoldenImage -RestoreId '$restoreId' -Purpose '$purpose'"
        $Out.vm = $r.VMName
        $Out.checkpoint = $r.CheckpointName
        $Out.checkpoint_created_at = $r.CheckpointCreatedAt
        $Out.restore_sec = $r.DurationSec
        Assert-RemoteSuccess $r
        Write-Log "restore done on $targetName ($($r.DurationSec)s)"

        # --- 復元した接続先への配置(5.3。失敗は警告) ---------------------------------
        foreach ($p in @($cfg.targets.PSObject.Properties)) {
            if ([string](Get-Prop $p.Value 'restoredBy' '') -ne $targetName) { continue }
            $dt = Get-RemoteTarget $cfg $p.Name
            $d = $null
            Write-Log "waiting for WinRM on $($p.Name) ($($dt.Host), up to ${winrmTimeout}s)"
            if (Wait-TargetWinRM $dt $winrmTimeout) {
                $d = Invoke-Deploy $cfg $p.Name
            } else {
                $d = [ordered]@{ target = $p.Name; status = 'failed'; error_code = 'WINRM_TIMEOUT'
                                 message = "WINRM_TIMEOUT: $($dt.Host) did not respond within ${winrmTimeout}s" }
            }
            $Out.deploy += [pscustomobject][ordered]@{
                target = $d.target; status = $d.status; version = $d['version']; error_code = $d.error_code; message = $d.message
            }
            if ($d.status -eq 'failed') {
                Write-Log "WARN: deploy to $($p.Name) failed; the restore continues. Remote commands on $($p.Name) are unavailable until it is deployed: $($d.message)"
            }
        }

        # --- 起動完了の確認(判定 = Web UI へのログイン成功) ------------------------------
        if ($SkipReadiness) {
            $Out.readiness = 'skipped'
            $Out.success = $true
            $Out.message = 'restored (readiness is checked by the readiness project of the test run)'
        } elseif ($readyCmd.Count -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $readyReq))) {
            # ログイン fixture がまだなく、起動確認テストもない。起動完了は人間が確かめる
            $Out.readiness = 'unavailable'
            $Out.success = $true
            $Out.message = "restored. Login check is not available yet ($readyReq not found). A human must confirm that the Web UI login succeeds before starting work."
            $script:SuccessExitCode = 4
            Write-Log 'readiness test not found: a human must confirm the Web UI login'
        } else {
            $rStart = Get-Date
            Write-Log "checking readiness (Web UI login, up to ${readyTimeout}s): $($readyCmd -join ' ')"
            $exe = [string]$readyCmd[0]
            $rest = @()
            if ($readyCmd.Count -gt 1) { $rest = @($readyCmd[1..($readyCmd.Count - 1)]) }
            $savedRestore = $env:PMS_RESTORE
            $env:PMS_READY_TIMEOUT_SEC = [string]$readyTimeout
            Remove-Item Env:PMS_RESTORE -ErrorAction SilentlyContinue   # 起動確認の実行で復元が入れ子にならないように
            $readyCode = $null
            Push-Location -LiteralPath $script:RepoRoot
            $eap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'   # 子プロセスの標準エラーで止めない(Windows PowerShell 5.1)
            try {
                & $exe @rest 2>&1 | ForEach-Object { [Console]::Error.WriteLine([string]$_) }
                $readyCode = $LASTEXITCODE
            } catch {
                throw "READINESS_COMMAND_UNAVAILABLE: cannot run readiness command '$exe': $($_.Exception.Message)"
            } finally {
                $ErrorActionPreference = $eap
                Pop-Location
                if ($null -ne $savedRestore) { $env:PMS_RESTORE = $savedRestore }
            }
            $Out.readiness_sec = [math]::Round(((Get-Date) - $rStart).TotalSeconds, 1)
            if ($readyCode -ne 0) {
                throw "READINESS_FAILED: Web UI login did not succeed (readiness exit $readyCode). See the readiness test output and its screenshot."
            }
            $Out.readiness = 'verified'
            $Out.success = $true
            $Out.message = 'restored and Web UI login succeeded'
            Write-Log "ready ($($Out.readiness_sec)s)"
        }
    } catch {
        Set-ResultError $_.Exception.Message
    } finally {
        # 復元を試みたら、成否によらず記録する(lint env_restored が突き合わせる)
        $done = Get-Date
        $marker = [ordered]@{}
        foreach ($k in $Out.Keys) { $marker[$k] = $Out[$k] }
        $marker.started_at = $script:Started.ToString('o')
        $marker.completed_at = $done.ToString('o')
        $marker.duration_sec = [math]::Round(($done - $script:Started).TotalSeconds, 1)
        Write-RestoreMarker $marker $markerLog
    }
}
