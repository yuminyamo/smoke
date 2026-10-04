<#
  pms-remote CLI — 共通部分(設定・接続先・資格情報・接続・版の確認・成果物の受け取り・出力)
  整備方針: docs/003_リモートコマンド整備方針.html(第1部 4章・5.4・6章)
#>

$script:IsoOffsetPattern = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$'
$script:IdPattern = '^[A-Za-z0-9_\-]{1,64}$'
$script:Sessions = New-Object System.Collections.ArrayList
$script:SuccessExitCode = 0
$script:ConfigFile = $null
$script:RepoRoot = $null

# 区分 → 終了コード(6.2)。表にない区分は 1(実行の失敗)
$script:ExitCodeByError = @{
    LOCKED                        = 3
    CONFIG_NOT_FOUND              = 2
    CONFIG_INVALID                = 2
    TARGET_NOT_FOUND              = 2
    CREDENTIAL_NOT_FOUND          = 2
    CREDENTIAL_INVALID            = 2
    INVALID_ARGUMENT              = 2
    UNKNOWN_COMMAND               = 2
    VERSION_MISMATCH              = 2
    ENDPOINT_NOT_FOUND            = 2
    ROLE_NOT_AVAILABLE            = 2
    NOT_ELEVATED                  = 2
    TOOL_NOT_FOUND                = 2
    OUTPUT_DIR_NOT_EMPTY          = 2
    NOT_A_BUNDLE                  = 2
    READINESS_COMMAND_UNAVAILABLE = 2
    TARGET_NOT_READY              = 2
}

function Write-Log([string]$m) {
    [Console]::Error.WriteLine("[pms-remote] $((Get-Date).ToString('HH:mm:ss')) $m")
}

function ConvertTo-AsciiJson($obj) {
    $json = New-Object psobject -Property $obj | ConvertTo-Json -Compress -Depth 8
    # 呼び出し側のコードページに依存しないよう、非ASCIIは \uXXXX にする
    return [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

function Get-Prop($obj, [string]$name, $default) {
    if ($null -eq $obj) { return $default }
    $p = $obj.PSObject.Properties[$name]
    if ($null -eq $p -or $null -eq $p.Value -or ([string]$p.Value) -eq '') { return $default }
    return $p.Value
}

# --- 結果 -------------------------------------------------------------------

function New-Result([string]$command, [string]$target) {
    $script:Started = Get-Date
    $t = $null
    if ($target) { $t = $target }
    return [ordered]@{
        success    = $false
        command    = $command
        target     = $t
        error_code = $null
        message    = $null
    }
}

function Set-ResultError([string]$message) {
    if ($message -match '^([A-Z_]{3,40}):') { $code = $Matches[1] } else { $code = 'UNEXPECTED_ERROR' }
    $script:Out.success = $false
    $script:Out.error_code = $code
    $script:Out.message = $message
    Write-Log "FAILED: $message"
}

function Complete-Result {
    # 時刻のキーを最後に並べ、終了コードを返す
    $done = Get-Date
    $script:Out.started_at = $script:Started.ToString('o')
    $script:Out.completed_at = $done.ToString('o')
    $script:Out.duration_sec = [math]::Round(($done - $script:Started).TotalSeconds, 1)
    if ($script:Out.success) { return $script:SuccessExitCode }
    $code = [string]$script:Out.error_code
    if ($code -and $script:ExitCodeByError.ContainsKey($code)) { return $script:ExitCodeByError[$code] }
    return 1
}

# --- 設定と接続先 -------------------------------------------------------------

function Resolve-RemoteConfigPath([string]$explicit) {
    if ($explicit) { return (Resolve-Path -LiteralPath $explicit).Path }
    if ($env:PMS_REMOTE_CONFIG) { return (Resolve-Path -LiteralPath $env:PMS_REMOTE_CONFIG).Path }
    $dir = (Get-Location).Path
    while ($dir) {
        $candidate = Join-Path (Join-Path $dir 'config') 'remote-targets.json'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

function Read-RemoteConfig([string]$explicit) {
    $path = Resolve-RemoteConfigPath $explicit
    if (-not $path) {
        throw 'CONFIG_NOT_FOUND: config/remote-targets.json not found (search upward from the current directory, or set PMS_REMOTE_CONFIG)'
    }
    try { $cfg = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "CONFIG_INVALID: cannot parse ${path}: $($_.Exception.Message)" }
    if ($null -eq (Get-Prop $cfg 'targets' $null)) { throw "CONFIG_INVALID: 'targets' is missing in $path" }
    $script:ConfigFile = $path
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $path)
    return $cfg
}

function Get-RemoteTarget($cfg, [string]$name) {
    if (-not $name) { throw 'INVALID_ARGUMENT: -Target is required' }
    $p = $cfg.targets.PSObject.Properties[$name]
    if ($null -eq $p) { throw "TARGET_NOT_FOUND: '$name' is not in targets of $($script:ConfigFile)" }
    $v = $p.Value
    $transport = ([string](Get-Prop $v 'transport' 'http')).ToLowerInvariant()
    if (@('http', 'https') -notcontains $transport) { throw "CONFIG_INVALID: targets.$name.transport must be http or https" }
    return [pscustomobject]@{
        Name             = $name
        Host             = [string](Get-Prop $v 'host' 'localhost')
        Endpoint         = [string](Get-Prop $v 'endpoint' 'PmsRemote')
        Transport        = $transport
        Port             = [int](Get-Prop $v 'port' 0)
        Credential       = [string](Get-Prop $v 'credential' '')
        DeployCredential = [string](Get-Prop $v 'deployCredential' '')
        Roles            = @(Get-Prop $v 'roles' @() | ForEach-Object { [string]$_ } | Sort-Object -Unique)
        RestoredBy       = [string](Get-Prop $v 'restoredBy' '')
    }
}

function Test-LocalHostName([string]$h) {
    return @('localhost', '127.0.0.1', '::1', '.', $env:COMPUTERNAME) -contains $h
}

# --- 資格情報(C-3) ------------------------------------------------------------

function Get-CredentialPath([string]$ref) {
    if ($ref -notmatch $script:IdPattern) { throw "INVALID_ARGUMENT: credential reference must match $($script:IdPattern): '$ref'" }
    $base = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'PmsRemote'
    return Join-Path (Join-Path $base 'cred') "$ref.xml"
}

function Get-StoredCredential([string]$ref) {
    # 参照名がなければ $null(ログオン中のユーザーで接続する)
    if (-not $ref) { return $null }
    $path = Get-CredentialPath $ref
    if (-not (Test-Path -LiteralPath $path)) {
        throw "CREDENTIAL_NOT_FOUND: credential '$ref' is not saved. Run: pms-remote.ps1 cred-set $ref"
    }
    try { return Import-Clixml -LiteralPath $path }
    catch { throw "CREDENTIAL_INVALID: cannot load credential '$ref' (saved by another user or PC?): $path" }
}

# --- 接続 ----------------------------------------------------------------------

function Get-SessionParams($target, [switch]$Admin) {
    $p = @{ ComputerName = $target.Host; ErrorAction = 'Stop' }
    if ($Admin) {
        # 配置用(管理者)。JEA を通らない既定のエンドポイント。deploy と check-target だけが使う(C-4)
        $p.ConfigurationName = 'Microsoft.PowerShell'
        $cred = Get-StoredCredential $target.DeployCredential
    } else {
        $p.ConfigurationName = $target.Endpoint
        $cred = Get-StoredCredential $target.Credential
    }
    if ($cred) { $p.Credential = $cred }
    if ($target.Transport -eq 'https') { $p.UseSSL = $true }
    if ($target.Port -gt 0) { $p.Port = $target.Port }
    return $p
}

function Open-RemoteSession($target, [switch]$Admin) {
    $p = Get-SessionParams $target -Admin:$Admin
    try {
        $s = New-PSSession @p
    } catch {
        $m = $_.Exception.Message
        if (-not $Admin -and $m -match [regex]::Escape($target.Endpoint) -and $m -match 'configuration|構成') {
            throw "ENDPOINT_NOT_FOUND: the JEA endpoint '$($target.Endpoint)' is not on $($target.Host). Run: pms-remote.ps1 deploy -Target $($target.Name)"
        }
        throw "CONNECT_FAILED: $($target.Name) ($($target.Host)): $m"
    }
    [void]$script:Sessions.Add($s)
    return $s
}

function Close-RemoteSession($session) {
    if ($null -eq $session) { return }
    Remove-PSSession -Session $session -ErrorAction SilentlyContinue
    [void]$script:Sessions.Remove($session)
}

function Close-RemoteSessions {
    foreach ($s in @($script:Sessions)) { Remove-PSSession -Session $s -ErrorAction SilentlyContinue }
    $script:Sessions.Clear()
}

function Invoke-Remote($session, [string]$command) {
    # JEA(NoLanguage モード)では変数を含むスクリプトブロックが使えないため、
    # 検証済みの値をリテラルで埋め込んだ文字列を渡す(F-1 の引数だけなので引用符は入らない)
    $fn = $command.Split(' ')[0]
    try {
        return Invoke-Command -Session $session -ScriptBlock ([scriptblock]::Create($command)) -ErrorAction Stop
    } catch {
        $m = $_.Exception.Message
        if (($_.FullyQualifiedErrorId -like '*CommandNotFound*' -or $m -match 'not recognized|認識され') -and $m -match [regex]::Escape($fn)) {
            throw "ROLE_NOT_AVAILABLE: '$fn' is not available on this endpoint (role not registered, or the module is older). Check targets.<name>.roles and run deploy"
        }
        if ($m -match '^[A-Z_]{3,40}:') { throw $m }
        throw "CONNECT_FAILED: $m"
    }
}

function Assert-RemoteSuccess($r) {
    # 関数が Success=$false で返したら、その区分のまま失敗にする(F-5)
    if ($null -eq $r) { throw 'REMOTE_ERROR: no result from the remote function' }
    if (-not $r.Success) {
        $m = [string]$r.Message
        if ($m -notmatch '^[A-Z_]{3,40}:') { $m = "$($r.ErrorCode): $m" }
        throw $m
    }
}

# --- 版(5.4) -------------------------------------------------------------------

function Test-VersionCompatible([string]$actual, [string]$expected) {
    try { $a = [version]$actual; $e = [version]$expected } catch { return $false }
    return ($a.Major -eq $e.Major -and $a -ge $e)
}

function Connect-RemoteTarget($cfg, [string]$name, [switch]$NoVersionCheck) {
    # 接続し、Get-PmsRemoteInfo で版を確かめる。サーバーの時計 − 呼び出し元の時計(参考値)も測る
    $t = Get-RemoteTarget $cfg $name
    $s = Open-RemoteSession $t
    $c0 = [DateTimeOffset]::Now
    $info = Invoke-Remote $s 'Get-PmsRemoteInfo'
    $c1 = [DateTimeOffset]::Now
    $offset = $null
    try {
        $mid = $c0.AddTicks([long](($c1 - $c0).Ticks / 2))
        $offset = [math]::Round(([DateTimeOffset]::Parse([string]$info.ServerTime, [System.Globalization.CultureInfo]::InvariantCulture) - $mid).TotalSeconds, 1)
    } catch { }
    $expected = [string](Get-Prop $cfg 'expectedVersion' '1.0')
    if (-not $NoVersionCheck -and -not (Test-VersionCompatible ([string]$info.Version) $expected)) {
        throw "VERSION_MISMATCH: $name has PmsRemote $($info.Version), expected $expected (same major, at least). Run: pms-remote.ps1 deploy -Target $name"
    }
    return [pscustomobject]@{ Target = $t; Session = $s; Info = $info; ServerTimeOffsetSec = $offset; ExpectedVersion = $expected }
}

# --- ローカルのモジュール(配置の比較用) -----------------------------------------

function Get-LocalModulePath { return Join-Path (Join-Path (Join-Path $script:RepoRoot 'remote') 'module') 'PmsRemote' }

function Get-LocalModuleVersion {
    return [string](Import-PowerShellDataFile -LiteralPath (Join-Path (Get-LocalModulePath) 'PmsRemote.psd1')).ModuleVersion
}

function Get-DirHash([string]$Path) {
    # リモート側の Get-PmsDirectoryHash(remote/module/PmsRemote/Common.ps1)と同じ計算
    $root = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\', '/')
    $lines = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($root.Length).Replace('\', '/').TrimStart('/').ToLowerInvariant()
        $rel + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    })
    [Array]::Sort($lines, [StringComparer]::Ordinal)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))))).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Get-TargetConfigOriginal([string]$name) {
    # リモート側の設定の原本(F-4)。なければ $null
    $p = Join-Path (Join-Path (Join-Path $script:RepoRoot 'remote') 'targets') (Join-Path $name 'config.psd1')
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
}

# --- 成果物の受け取り(F-7) -------------------------------------------------------

function Receive-RemoteArtifact($session, [string]$id, [int]$chunkCount, [long]$bytes, [string]$destZip) {
    $fs = [System.IO.File]::Create($destZip)
    try {
        for ($i = 0; $i -lt $chunkCount; $i++) {
            $chunk = Invoke-Remote $session "Read-PmsRemoteArtifact -Id '$id' -Index $i"
            if (-not $chunk.Success) { throw "TRANSFER_FAILED: chunk $i of ${chunkCount}: $($chunk.Message)" }
            $buf = [Convert]::FromBase64String([string]$chunk.Data)
            $fs.Write($buf, 0, $buf.Length)
        }
    } finally {
        $fs.Dispose()
    }
    $got = (Get-Item -LiteralPath $destZip).Length
    if ($got -ne $bytes) { throw "TRANSFER_FAILED: size mismatch (remote $bytes, received $got)" }
}
