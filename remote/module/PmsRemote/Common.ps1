<#
  PmsRemote — 共通(全マシン・全ロール)
  設定・ロック・操作の記録・成果物(artifact)・版の情報。
  整備方針: docs/003_リモートコマンド整備方針.html(第1部)

  リモート側の配置:
    %ProgramData%\PmsRemote\config.psd1       設定(配置で作る。原本はリポジトリの remote/targets/<接続先名>/config.psd1)
    %ProgramData%\PmsRemote\state\            ロック・操作の記録・成果物・install.json
    %ProgramData%\PmsRemote\Transcripts\      JEA の操作記録
#>

$script:BaseDir        = Join-Path $env:ProgramData 'PmsRemote'
$script:ConfigPath     = Join-Path $script:BaseDir 'config.psd1'
$script:StateDir       = Join-Path $script:BaseDir 'state'
$script:ArtifactDir    = Join-Path $script:StateDir 'artifacts'
$script:OpLogPath      = Join-Path $script:StateDir 'operations.log'
$script:InstallInfo    = Join-Path $script:StateDir 'install.json'
$script:ChunkBytes     = 4MB
$script:ArtifactRetentionHours = 24

# --- 設定 -------------------------------------------------------------------

function Get-PmsConfig {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
        throw "CONFIG_NOT_FOUND: $($script:ConfigPath)"
    }
    return Import-PowerShellDataFile -LiteralPath $script:ConfigPath
}

function Get-PmsConfigSection {
    # 機能ごとのセクションを取り出し、必須キーを確かめ、既定値を補う(F-3)
    param(
        [Parameter(Mandatory)][string]$Name,
        [string[]]$Required = @(),
        [hashtable]$Defaults = @{}
    )
    $cfg = Get-PmsConfig
    if (-not $cfg.ContainsKey($Name) -or -not ($cfg[$Name] -is [hashtable])) {
        throw "CONFIG_INVALID: section '$Name' is required in $($script:ConfigPath)"
    }
    $sec = $cfg[$Name]
    foreach ($k in $Required) {
        if (-not $sec.ContainsKey($k) -or [string]::IsNullOrWhiteSpace([string]$sec[$k])) {
            throw "CONFIG_INVALID: '$Name.$k' is required in $($script:ConfigPath)"
        }
    }
    foreach ($k in $Defaults.Keys) {
        if (-not $sec.ContainsKey($k)) { $sec[$k] = $Defaults[$k] }
    }
    return $sec
}

# --- 記録・エラー・待機・ロック -----------------------------------------------

function Initialize-PmsStateDir {
    foreach ($d in @($script:StateDir, $script:ArtifactDir)) {
        if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
}

function Write-PmsOpLog {
    # 操作の記録(S-9)。書けなくても操作自体は失敗させない
    param([string]$Line)
    try {
        Initialize-PmsStateDir
        Add-Content -LiteralPath $script:OpLogPath -Value "$((Get-Date).ToString('o'))`t$Line" -Encoding UTF8
    } catch { }
}

function Get-PmsErrorCode {
    # "区分: 内容" の区分を取り出す(F-6)
    param([string]$Message)
    if ($Message -match '^([A-Z_]{3,40}):') { return $Matches[1] }
    return 'REMOTE_ERROR'
}

function Wait-PmsCondition {
    param([scriptblock]$Condition, [int]$TimeoutSec, [int]$IntervalSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        if (& $Condition) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Seconds $IntervalSec
    }
}

function Enter-PmsLock {
    # そのマシンのロックを取る(S-8)。戻り値の FileStream を Dispose すると解放される
    param([Parameter(Mandatory)][string]$Name, [string]$What = 'operation')
    Initialize-PmsStateDir
    try {
        return [System.IO.File]::Open((Join-Path $script:StateDir "$Name.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        throw "LOCKED: another $What is in progress on this machine"
    }
}

# --- 成果物(F-7) -------------------------------------------------------------

function New-PmsArtifactId {
    param([string]$Prefix = 'ART')
    return '{0}-{1}-{2}' -f $Prefix, (Get-Date).ToString('yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 6))
}

function Remove-PmsExpiredArtifacts {
    if (-not (Test-Path -LiteralPath $script:ArtifactDir)) { return }
    $limit = (Get-Date).AddHours(-$script:ArtifactRetentionHours)
    Get-ChildItem -LiteralPath $script:ArtifactDir -Filter '*.zip' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $limit } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

function Save-PmsArtifact {
    # フォルダを zip にして成果物として置く。戻り値: Id・Bytes・ChunkCount
    param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$SourceDir)
    Initialize-PmsStateDir
    Remove-PmsExpiredArtifacts
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = Join-Path $script:ArtifactDir "$Id.zip"
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($SourceDir, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    $bytes = (Get-Item -LiteralPath $zip).Length
    return [pscustomobject]@{
        Id         = $Id
        Bytes      = $bytes
        ChunkCount = [int][math]::Max(1, [math]::Ceiling($bytes / $script:ChunkBytes))
    }
}

function Read-PmsRemoteArtifact {
    <#
      .SYNOPSIS 成果物(zip)を分割して base64 で返す(1回 4MB。F-7)。
      .PARAMETER Id     成果物ID(成果物を作った関数が返したもの)
      .PARAMETER Index  0 から始まる分割の番号
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^[A-Za-z0-9_\-]{1,64}$')]
        [string]$Id,
        [ValidateRange(0, 100000)]
        [int]$Index = 0
    )
    $path = Join-Path $script:ArtifactDir "$Id.zip"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject]@{ Success = $false; ErrorCode = 'ARTIFACT_NOT_FOUND'; Message = "ARTIFACT_NOT_FOUND: $Id" }
    }
    $fs = [System.IO.File]::OpenRead($path)
    try {
        $total = $fs.Length
        $count = [int][math]::Max(1, [math]::Ceiling($total / $script:ChunkBytes))
        if ($Index -ge $count) {
            return [pscustomobject]@{ Success = $false; ErrorCode = 'INVALID_ARGUMENT'; Message = "INVALID_ARGUMENT: Index $Index is out of range (chunks: $count)" }
        }
        $offset = [long]$Index * $script:ChunkBytes
        $len = [int][math]::Min([long]$script:ChunkBytes, $total - $offset)
        $buf = New-Object byte[] $len
        $fs.Position = $offset
        $read = 0
        while ($read -lt $len) {
            $n = $fs.Read($buf, $read, $len - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        return [pscustomobject]@{
            Success    = $true
            ErrorCode  = $null
            Message    = 'ok'
            Id         = $Id
            Index      = $Index
            ChunkCount = $count
            TotalBytes = $total
            Data       = [Convert]::ToBase64String($buf, 0, $read)
        }
    } finally {
        $fs.Dispose()
    }
}

function Remove-PmsRemoteArtifact {
    <# .SYNOPSIS 受け取り終えた成果物を消す(受け取られずに残ったものは保持時間を過ぎると次の作成時に消える)。 #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^[A-Za-z0-9_\-]{1,64}$')]
        [string]$Id
    )
    $path = Join-Path $script:ArtifactDir "$Id.zip"
    $existed = Test-Path -LiteralPath $path -PathType Leaf
    if ($existed) { Remove-Item -LiteralPath $path -Force }
    return [pscustomobject]@{ Success = $true; ErrorCode = $null; Message = 'ok'; Id = $Id; Removed = $existed }
}

# --- 版の情報(5.4) ------------------------------------------------------------

function Get-PmsDirectoryHash {
    # フォルダの中身のハッシュ。CLI 本体(tools/remote/lib/Client.ps1)と同じ計算をする
    param([Parameter(Mandatory)][string]$Path)
    $root = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\', '/')
    $lines = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($root.Length).Replace('\', '/').TrimStart('/').ToLowerInvariant()
        $rel + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    })
    [Array]::Sort($lines, [StringComparer]::Ordinal)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))
        return ([BitConverter]::ToString($digest)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Get-PmsRemoteInfo {
    <#
      .SYNOPSIS 版・登録済みのロール・モジュールと設定のハッシュ・マシンの時刻を返す(全ロール共通。何も変更しない)。
        CLI はすべての呼び出しの最初にこれで版を確かめる。
    #>
    [CmdletBinding()]
    param()
    $install = $null
    if (Test-Path -LiteralPath $script:InstallInfo) {
        try { $install = Get-Content -LiteralPath $script:InstallInfo -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    $configHash = $null
    if (Test-Path -LiteralPath $script:ConfigPath) {
        $configHash = (Get-FileHash -LiteralPath $script:ConfigPath -Algorithm SHA256).Hash
    }
    $roles = @()
    $installedAt = $null
    if ($install) {
        $roles = @($install.roles)
        $installedAt = $install.installed_at
    }
    return [pscustomobject]@{
        Success     = $true
        ErrorCode   = $null
        Message     = 'ok'
        Version     = [string]$MyInvocation.MyCommand.Module.Version
        Roles       = $roles
        ModuleHash  = Get-PmsDirectoryHash -Path $PSScriptRoot
        ConfigHash  = $configHash
        HostName    = $env:COMPUTERNAME
        InstalledAt = $installedAt
        ServerTime  = [DateTimeOffset]::Now.ToString('o')
    }
}
