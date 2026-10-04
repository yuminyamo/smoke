<#
  PmsRemote — PMS サーバーVM(ロール ServerRead / ServerChange)
  ServerRead : ログ収集(SK-LOG)。製品のログ収集ツールをこのマシンで実行し、結果を成果物(zip)にする
  ServerChange: (将来)時刻合わせ・セットアップ操作

  ログ収集の設定(config.psd1)。クライアントが渡せるのは時間範囲だけで、ほかはここで固定する(F-3):
    LogCollect = @{
        ExePath          = 'C:\PMS\tools\LogCollector.exe'                                  # 必須
        Arguments        = @('-from', '{From}', '-to', '{To}', '-out', '{OutDir}', '{Mask}')  # 必須
        MaskArguments    = @('-mask')        # 必須。空ならログ収集は必ず失敗する(マスクせずに集めない)
        WorkRoot         = 'C:\PmsRemote\work\logs'   # 必須。収集IDごとにフォルダを作る(成功したら消す。失敗時は調査用に残す)
        TimeZone         = 'GuestLocal'      # ツールに渡す時刻: GuestLocal(このマシンの現地時刻)/ Utc / AsGiven(渡された時差のまま)
        TimeFormat       = 'yyyy-MM-ddTHH:mm:sszzz'
        SuccessExitCodes = @(0)              # ツールの正常終了とみなす終了コード(F-9)
        TimeoutSec       = 300
        MaxWindowMinutes = 180
        MaxArtifactMB    = 200
        KeepWorkOutput   = $false            # 成功後も作業フォルダを残すか
    }
  Arguments の {From} {To} は時間範囲、{OutDir} は出力先(WorkRoot\<収集ID>\bundle)に置き換わる。
  {Mask} の位置に MaskArguments が入る(なければ末尾)。
#>

$script:LogCollectDefaults = @{
    TimeZone         = 'GuestLocal'
    TimeFormat       = 'yyyy-MM-ddTHH:mm:sszzz'
    SuccessExitCodes = @(0)
    TimeoutSec       = 300
    MaxWindowMinutes = 180
    MaxArtifactMB    = 200
    KeepWorkOutput   = $false
}

function Get-PmsLogCollectConfig {
    $lc = Get-PmsConfigSection -Name 'LogCollect' -Required @('ExePath', 'WorkRoot') -Defaults $script:LogCollectDefaults
    if (-not $lc.ContainsKey('Arguments')) {
        throw "CONFIG_INVALID: 'LogCollect.Arguments' is required"
    }
    # マスクの指定がなければ集めない(LOG-2)
    if (-not $lc.ContainsKey('MaskArguments') -or @($lc.MaskArguments | Where-Object { "$_" -ne '' }).Count -eq 0) {
        throw "MASK_NOT_CONFIGURED: 'LogCollect.MaskArguments' is empty. Logs are never collected without masking"
    }
    if (@('GuestLocal', 'Utc', 'AsGiven') -notcontains [string]$lc.TimeZone) {
        throw "CONFIG_INVALID: 'LogCollect.TimeZone' must be GuestLocal, Utc or AsGiven"
    }
    return $lc
}

function Test-PmsElevated {
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object System.Security.Principal.WindowsPrincipal($me)).IsInRole(
        [System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Initialize-PmsServer {
    # インストーラが呼ぶ(D-4)。ログ収集の設定を確かめる。ツールがない・設定がないのは警告にとどめる
    $warnings = @()
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
        return @('no config: log collection is not available on this machine')
    }
    $cfg = Get-PmsConfig
    if (-not $cfg.ContainsKey('LogCollect')) {
        return @("no 'LogCollect' section: log collection is not available on this machine")
    }
    $lc = Get-PmsLogCollectConfig
    if (-not (Test-Path -LiteralPath ([string]$lc.ExePath) -PathType Leaf)) {
        $warnings += "log collection tool not found: $($lc.ExePath)"
    }
    return $warnings
}

function Get-PmsLogCollectInfo {
    <#
      .SYNOPSIS 接続確認用。ログ収集の設定・マスクの指定・ツールの有無・管理者権限を確かめる。
        何も変更しない(ツールも実行しない)。ロール ServerRead。
    #>
    [CmdletBinding()]
    param()
    $r = [ordered]@{
        Success        = $false
        ErrorCode      = $null
        Message        = $null
        HostName       = $env:COMPUTERNAME
        ConfigOk       = $false
        Masked         = $false
        ToolPresent    = $null
        Elevated       = $null
        ServerTimeZone = [System.TimeZoneInfo]::Local.Id
    }
    try {
        $lc = Get-PmsLogCollectConfig
        $r.ConfigOk = $true
        $r.Masked = $true
        $r.Elevated = Test-PmsElevated
        $r.ToolPresent = Test-Path -LiteralPath ([string]$lc.ExePath) -PathType Leaf
        if (-not $r.Elevated) { throw 'NOT_ELEVATED: the JEA run-as account is not an administrator on this machine' }
        if (-not $r.ToolPresent) { throw "TOOL_NOT_FOUND: $($lc.ExePath)" }
        $r.Success = $true
        $r.Message = 'ready'
    } catch {
        $r.Message = $_.Exception.Message
        $r.ErrorCode = Get-PmsErrorCode $r.Message
    }
    return [pscustomobject]$r
}

function ConvertTo-PmsToolTime {
    # 時差付きの時刻を、ツールに渡す時差・書式に直す
    param([string]$Value, [string]$TimeZone, [string]$Format)
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $t = [DateTimeOffset]::Parse($Value, $inv)
    if ($TimeZone -eq 'Utc') { $t = $t.ToUniversalTime() }
    elseif ($TimeZone -eq 'GuestLocal') { $t = $t.ToLocalTime() }
    return $t.ToString($Format, $inv)
}

function ConvertTo-PmsCommandLine {
    # 引数の配列を、Windows のコマンドラインの規則で1つの文字列にする
    param([string[]]$Arguments)
    return (@($Arguments | ForEach-Object {
        if ($_ -ne '' -and $_ -notmatch '[\s"]') { $_ }
        else { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
    }) -join ' ')
}

function Invoke-PmsLogCollect {
    <#
      .SYNOPSIS 製品のログ収集ツールを、設定で固定した引数・出力先・マスクの指定で実行し、結果を成果物(zip)にする。ロール ServerRead。
      .DESCRIPTION
        受け取りは Read-PmsRemoteArtifact、後始末は Remove-PmsRemoteArtifact(共通の関数)。
        ツールの標準出力・標準エラーは成果物に入れず、作業フォルダに残す(F-9)。
      .PARAMETER From  ISO 8601(時差付き)。例 2026-10-03T13:50:00+09:00
      .PARAMETER To    同上
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$')]
        [string]$From,
        [Parameter(Mandatory)]
        [ValidatePattern('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$')]
        [string]$To
    )

    $started = Get-Date
    $id = New-PmsArtifactId -Prefix 'LOG'
    $workDir = $null
    $result = [ordered]@{
        Success        = $false
        ErrorCode      = $null
        Message        = $null
        CollectId      = $id
        ArtifactId     = $null
        ArtifactBytes  = $null
        ChunkCount     = $null
        Files          = @()
        From           = $From
        To             = $To
        ToolFrom       = $null      # ツールに渡した時刻(このマシンの時刻として解釈される)
        ToolTo         = $null
        ServerTimeZone = [System.TimeZoneInfo]::Local.Id
        ToolExitCode   = $null
        Masked         = $false
        HostName       = $env:COMPUTERNAME
        StartedAt      = $started.ToString('o')
        CompletedAt    = $null
        DurationSec    = $null
    }

    try {
        $lc = Get-PmsLogCollectConfig
        $inv = [System.Globalization.CultureInfo]::InvariantCulture
        $fromT = [DateTimeOffset]::Parse($From, $inv)
        $toT = [DateTimeOffset]::Parse($To, $inv)
        if ($toT -le $fromT) { throw 'INVALID_ARGUMENT: To must be later than From' }
        if (($toT - $fromT).TotalMinutes -gt [double]$lc.MaxWindowMinutes) {
            throw "INVALID_ARGUMENT: the window exceeds LogCollect.MaxWindowMinutes ($($lc.MaxWindowMinutes))"
        }
        if (-not (Test-PmsElevated)) { throw 'NOT_ELEVATED: the JEA run-as account is not an administrator on this machine' }
        $exe = [string]$lc.ExePath
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "TOOL_NOT_FOUND: $exe" }

        Write-PmsOpLog "LOGCOLLECT-BEGIN`t$id`t$From`t$To"
        $result.ToolFrom = ConvertTo-PmsToolTime $From ([string]$lc.TimeZone) ([string]$lc.TimeFormat)
        $result.ToolTo = ConvertTo-PmsToolTime $To ([string]$lc.TimeZone) ([string]$lc.TimeFormat)

        # 出力先は固定のフォルダの下に収集IDごとに作る
        $workDir = Join-Path ([string]$lc.WorkRoot) $id
        $outDir = Join-Path $workDir 'bundle'
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null

        # 引数の組み立て。{From} {To} {OutDir} を置き換え、{Mask} の位置(なければ末尾)にマスクの指定を入れる
        $map = @{ '{From}' = $result.ToolFrom; '{To}' = $result.ToolTo; '{OutDir}' = $outDir }
        $argv = New-Object System.Collections.Generic.List[string]
        $maskPlaced = $false
        foreach ($a in @($lc.Arguments)) {
            if ([string]$a -eq '{Mask}') {
                foreach ($m in @($lc.MaskArguments)) { $argv.Add([string]$m) }
                $maskPlaced = $true
                continue
            }
            $s = [string]$a
            foreach ($k in $map.Keys) { $s = $s.Replace($k, $map[$k]) }
            $argv.Add($s)
        }
        if (-not $maskPlaced) { foreach ($m in @($lc.MaskArguments)) { $argv.Add([string]$m) } }

        $stdout = Join-Path $workDir 'tool-stdout.txt'
        $stderr = Join-Path $workDir 'tool-stderr.txt'
        $p = Start-Process -FilePath $exe -ArgumentList (ConvertTo-PmsCommandLine $argv.ToArray()) `
            -WorkingDirectory (Split-Path -Parent $exe) -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $null = $p.Handle   # 終了後に ExitCode を読めるようにする(Start-Process -PassThru の既知の問題)
        if (-not $p.WaitForExit([int]$lc.TimeoutSec * 1000)) {
            try { $p.Kill() } catch { }
            throw "TOOL_TIMEOUT: the log collection tool did not finish within $($lc.TimeoutSec)s"
        }
        $result.ToolExitCode = $p.ExitCode
        $okCodes = @($lc.SuccessExitCodes | ForEach-Object { [int]$_ })
        if ($okCodes -notcontains $p.ExitCode) {
            throw "TOOL_FAILED: exit code $($p.ExitCode) (success: $($okCodes -join ',')). See $stdout and $stderr on $env:COMPUTERNAME"
        }
        $result.Masked = $true   # MaskArguments が空なら Get-PmsLogCollectConfig で止まる

        $result.Files = @(Get-ChildItem -LiteralPath $outDir -Recurse -File | ForEach-Object {
            [pscustomobject]@{ Name = $_.FullName.Substring($outDir.Length).TrimStart('\', '/'); Size = $_.Length }
        })
        $art = Save-PmsArtifact -Id $id -SourceDir $outDir
        if ($art.Bytes -gt ([long]$lc.MaxArtifactMB * 1MB)) {
            Remove-PmsRemoteArtifact -Id $id | Out-Null
            throw "ARTIFACT_TOO_LARGE: $($art.Bytes) bytes exceeds LogCollect.MaxArtifactMB ($($lc.MaxArtifactMB)). Narrow the time window"
        }
        $result.ArtifactId = $art.Id
        $result.ArtifactBytes = $art.Bytes
        $result.ChunkCount = $art.ChunkCount
        $result.Success = $true
        $result.Message = 'collected'
        if (-not $lc.KeepWorkOutput) {
            Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch {
        $result.Message = $_.Exception.Message
        $result.ErrorCode = Get-PmsErrorCode $result.Message
    } finally {
        $done = Get-Date
        $result.CompletedAt = $done.ToString('o')
        $result.DurationSec = [math]::Round(($done - $started).TotalSeconds, 1)
        $status = 'FAIL'
        if ($result.Success) { $status = 'OK' }
        Write-PmsOpLog "LOGCOLLECT-END`t$id`t$status`t$($result.ErrorCode)`t$($result.DurationSec)s`t$($result.ArtifactBytes)`t$($result.Message)"
    }
    return [pscustomobject]$result
}
