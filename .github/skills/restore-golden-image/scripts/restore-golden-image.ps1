#Requires -Version 5.1
<#
.SYNOPSIS
  PMS 検証環境をゴールデンイメージへ戻す(クライアント側 CLI)。
  外部操作 skill "restore-golden-image"(操作ID OP-VM-001)の同梱実行体。Playwright の globalSetup からも呼ばれる。

.DESCRIPTION
  1. 設定 config/golden-restore.json を読む(カレントから上位へ探索。環境変数 PMS_RESTORE_CONFIG で上書き可)
  2. Hyper-V ホストの JEA エンドポイントで Restore-PmsGoldenImage を実行(VM の停止 → チェックポイント適用 → 起動)
  3. 起動完了を確認する。判定は「Web UI にログインできること」で、その中身はテストコード側の
     起動確認テスト(tests/readiness/server-ready.setup.ts。ログイン fixture と同じシナリオ部品を使う)が持つ。
     この実行体は readiness.command を呼び、終了コードを見るだけで、ログインの操作は知らない
     - 起動確認テストがまだない(ログイン fixture 未整備)場合は、終了コード 4 を返す。人間がログインを確かめる
     - -SkipReadiness のときは呼ばない(回帰テストの一括実行では、起動確認テストが全 project の依存として走るため)
  4. 復元記録(マーカー)を JSON Lines で追記
  5. 結果を 1 行の JSON で標準出力に書く(進捗は標準エラー。非ASCIIは \uXXXX にエスケープ)

  終了コード:
    0 = 復元し、起動確認(ログイン)まで成功(-SkipReadiness 時は復元のみ成功)
    1 = 復元または起動確認の失敗
    2 = 設定・資格情報・実行環境の誤り
    3 = 別の復元が実行中
    4 = 復元は成功。起動確認テストがまだないため、起動完了は人間が確かめる

.PARAMETER Purpose        regression / work10 / work20 / manual
.PARAMETER FlowId         作業10・20 のときのフローID(例: F-003)。マーカーに残る
.PARAMETER SkipReadiness  起動確認を呼ばない(globalSetup 用)
.PARAMETER InfoOnly       復元せず、接続確認と対象の状態表示だけ行う
.PARAMETER SaveCredential 接続用の資格情報を保存する(初回のみ。DPAPI でこのユーザー・このPCに紐づく)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File restore-golden-image.ps1 -Purpose work10 -FlowId F-003
#>
[CmdletBinding()]
param(
    [ValidateSet('regression', 'work10', 'work20', 'manual')]
    [string]$Purpose = 'manual',
    [ValidatePattern('^$|^[A-Za-z0-9_\-]{1,32}$')]
    [string]$FlowId = '',
    [string]$ConfigPath = '',
    [switch]$SkipReadiness,
    [switch]$InfoOnly,
    [switch]$SaveCredential
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Log([string]$m) {
    [Console]::Error.WriteLine("[golden-restore] $((Get-Date).ToString('HH:mm:ss')) $m")
}

function Emit([hashtable]$obj, [int]$code) {
    $json = New-Object psobject -Property $obj | ConvertTo-Json -Compress -Depth 5
    # 呼び出し側のコードページに依存しないよう、非ASCIIは \uXXXX にする
    $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    [Console]::Out.WriteLine($json)
    exit $code
}

function Get-Prop($obj, [string]$name, $default) {
    if ($null -eq $obj) { return $default }
    $p = $obj.PSObject.Properties[$name]
    if ($null -eq $p -or $null -eq $p.Value -or ([string]$p.Value) -eq '') { return $default }
    return $p.Value
}

function Resolve-ConfigPath([string]$explicit) {
    if ($explicit) { return (Resolve-Path -LiteralPath $explicit).Path }
    if ($env:PMS_RESTORE_CONFIG) { return (Resolve-Path -LiteralPath $env:PMS_RESTORE_CONFIG).Path }
    $dir = (Get-Location).Path
    while ($dir) {
        $candidate = Join-Path (Join-Path $dir 'config') 'golden-restore.json'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

function Write-Marker([hashtable]$obj, [string]$path) {
    try {
        $mdir = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $mdir)) { New-Item -ItemType Directory -Path $mdir -Force | Out-Null }
        $line = New-Object psobject -Property $obj | ConvertTo-Json -Compress -Depth 5
        $enc = New-Object System.Text.UTF8Encoding($false)   # BOM なし UTF-8 で 1 行追記(JSON Lines)
        [System.IO.File]::AppendAllText($path, $line + "`n", $enc)
    } catch {
        Log "WARN: cannot write marker log: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
$started = Get-Date
$restoreId = 'RST-{0}-{1}' -f $started.ToString('yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 4))

$out = @{
    success               = $false
    restore_id            = $restoreId
    purpose               = $Purpose
    flow_id               = $FlowId
    readiness             = $null     # verified / unavailable / skipped
    error_code            = $null
    message               = $null
    host                  = $null
    vm                    = $null
    checkpoint            = $null
    checkpoint_created_at = $null
    started_at            = $started.ToString('o')
    completed_at          = $null
    restore_sec           = $null
    readiness_sec         = $null
    duration_sec          = $null
    marker_log            = $null
}

# --- 設定 ------------------------------------------------------------------
$cfgFile = Resolve-ConfigPath $ConfigPath
if (-not $cfgFile) {
    $out.error_code = 'CONFIG_NOT_FOUND'
    $out.message = 'config/golden-restore.json not found (search upward from current directory, or set PMS_RESTORE_CONFIG)'
    Emit $out 2
}
try {
    $cfg = Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    $out.error_code = 'CONFIG_INVALID'
    $out.message = "cannot parse ${cfgFile}: $($_.Exception.Message)"
    Emit $out 2
}
$repoRoot = Split-Path -Parent (Split-Path -Parent $cfgFile)

$hvHost   = [string](Get-Prop $cfg 'hyperVHost' 'localhost')
if ($env:PMS_RESTORE_HOST) { $hvHost = $env:PMS_RESTORE_HOST }
$endpoint = [string](Get-Prop $cfg 'configurationName' 'PmsGoldenRestore')
$useSsl   = [bool](Get-Prop $cfg 'useSsl' $false)
$port     = [int](Get-Prop $cfg 'port' 0)
$credFile = [Environment]::ExpandEnvironmentVariables([string](Get-Prop $cfg 'credentialFile' '%APPDATA%\PmsGoldenRestore\credential.xml'))
$markerRel = [string](Get-Prop $cfg 'markerLog' 'work/_common/env-restore-log.jsonl')
$markerLog = if ([System.IO.Path]::IsPathRooted($markerRel)) { $markerRel } else { Join-Path $repoRoot $markerRel }
$readinessCfg = Get-Prop $cfg 'readiness' $null
$readyCmd     = @(Get-Prop $readinessCfg 'command' @())
$readyReq     = [string](Get-Prop $readinessCfg 'requiredPath' 'tests/readiness/server-ready.setup.ts')
$readyTimeout = [int](Get-Prop $readinessCfg 'timeoutSec' 900)
$out.marker_log = $markerLog
$out.host = $hvHost

# --- 資格情報 --------------------------------------------------------------
if ($SaveCredential) {
    $dir = Split-Path -Parent $credFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $c = Get-Credential -Message "Hyper-V ホスト $hvHost の PmsRestoreOperators メンバーの資格情報"
    $c | Export-Clixml -LiteralPath $credFile
    Log "saved credential: $credFile"
    exit 0
}

$session = @{ ComputerName = $hvHost; ConfigurationName = $endpoint; ErrorAction = 'Stop' }
if ($useSsl) { $session.UseSSL = $true }
if ($port -gt 0) { $session.Port = $port }
if (Test-Path -LiteralPath $credFile) {
    try { $session.Credential = Import-Clixml -LiteralPath $credFile }
    catch {
        $out.error_code = 'CREDENTIAL_INVALID'
        $out.message = "cannot load credential file (saved by another user or PC?): $credFile"
        Emit $out 2
    }
}

# --- 接続確認のみ ----------------------------------------------------------
if ($InfoOnly) {
    try {
        $info = Invoke-Command @session -ScriptBlock ([scriptblock]::Create('Get-PmsGoldenImageInfo'))
        $out.success = $true
        $out.message = 'info'
        $out.vm = $info.VMName
        $out.checkpoint = $info.CheckpointName
        $out.checkpoint_created_at = $info.CheckpointCreatedAt
        $out.info = @{
            state = $info.State; heartbeat = $info.Heartbeat
            checkpoint_count = $info.CheckpointCount; checkpoint_type = $info.CheckpointType
            readiness_test_present = (Test-Path -LiteralPath (Join-Path $repoRoot $readyReq))
        }
        $out.completed_at = (Get-Date).ToString('o')
        Emit $out 0
    } catch {
        $out.error_code = 'CONNECT_FAILED'
        $out.message = $_.Exception.Message
        Emit $out 1
    }
}

# --- 復元 ------------------------------------------------------------------
$exitCode = 1
try {
    Log "restore start: host=$hvHost id=$restoreId purpose=$Purpose"
    # JEA(NoLanguage モード)では変数を含むスクリプトブロックが使えないため、検証済みの値をリテラルで埋め込む
    $sb = [scriptblock]::Create("Restore-PmsGoldenImage -RestoreId '$restoreId' -Purpose '$Purpose'")
    $r = Invoke-Command @session -ScriptBlock $sb
    $out.vm = $r.VMName
    $out.checkpoint = $r.CheckpointName
    $out.checkpoint_created_at = $r.CheckpointCreatedAt
    $out.restore_sec = $r.DurationSec
    if (-not $r.Success) {
        $out.error_code = $r.ErrorCode
        $out.message = $r.Message
        if ($r.ErrorCode -eq 'LOCKED') { $exitCode = 3 }
        throw 'host-side restore failed'
    }
    Log "restore done on host ($($r.DurationSec)s)"

    # --- 起動完了の確認(判定 = Web UI へのログイン成功) ----------------------
    if ($SkipReadiness) {
        $out.readiness = 'skipped'
        $out.success = $true
        $out.message = 'restored (readiness is checked by the readiness project of the test run)'
        $exitCode = 0
    } elseif ($readyCmd.Count -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $repoRoot $readyReq))) {
        # ログイン fixture がまだなく、起動確認テストもない。起動完了は人間が確かめる
        $out.readiness = 'unavailable'
        $out.success = $true
        $out.message = "restored. Login check is not available yet ($readyReq not found). A human must confirm that the Web UI login succeeds before starting work."
        $exitCode = 4
        Log 'readiness test not found: a human must confirm the Web UI login'
    } else {
        $rStart = Get-Date
        Log "checking readiness (Web UI login, up to ${readyTimeout}s): $($readyCmd -join ' ')"
        $exe = [string]$readyCmd[0]
        $rest = @()
        if ($readyCmd.Count -gt 1) { $rest = @($readyCmd[1..($readyCmd.Count - 1)]) }
        $savedRestore = $env:PMS_RESTORE
        $env:PMS_READY_TIMEOUT_SEC = [string]$readyTimeout
        Remove-Item Env:PMS_RESTORE -ErrorAction SilentlyContinue   # 起動確認の実行で復元が入れ子にならないように
        $readyCode = $null
        Push-Location -LiteralPath $repoRoot
        $eap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'   # 子プロセスの標準エラーで止めない(Windows PowerShell 5.1)
        try {
            & $exe @rest 2>&1 | ForEach-Object { [Console]::Error.WriteLine([string]$_) }
            $readyCode = $LASTEXITCODE
        } catch {
            $out.error_code = 'READINESS_COMMAND_UNAVAILABLE'
            $out.message = "cannot run readiness command '$exe': $($_.Exception.Message)"
            $exitCode = 2
        } finally {
            $ErrorActionPreference = $eap
            Pop-Location
            if ($null -ne $savedRestore) { $env:PMS_RESTORE = $savedRestore }
        }
        if ($out.error_code) { throw 'readiness command' }
        $out.readiness_sec = [math]::Round(((Get-Date) - $rStart).TotalSeconds, 1)
        if ($readyCode -ne 0) {
            $out.error_code = 'READINESS_FAILED'
            $out.message = "Web UI login did not succeed (readiness exit $readyCode). See the readiness test output and its screenshot."
            throw 'readiness failed'
        }
        $out.readiness = 'verified'
        $out.success = $true
        $out.message = 'restored and Web UI login succeeded'
        $exitCode = 0
        Log "ready ($($out.readiness_sec)s)"
    }
} catch {
    if (-not $out.error_code) {
        $out.error_code = 'CONNECT_FAILED'
        $out.message = $_.Exception.Message
    }
    Log "FAILED: $($out.error_code) $($out.message)"
} finally {
    $done = Get-Date
    $out.completed_at = $done.ToString('o')
    $out.duration_sec = [math]::Round(($done - $started).TotalSeconds, 1)
}

Write-Marker $out $markerLog
Emit $out $exitCode
