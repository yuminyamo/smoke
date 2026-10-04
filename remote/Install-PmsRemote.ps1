#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  リモートコマンドセット PmsRemote を、このマシンに配置する共通インストーラ(全マシン共通。docs/003 5章)。

.DESCRIPTION
  処理の順序(D-2):
    1. モジュール配置       %ProgramFiles%\WindowsPowerShell\Modules\PmsRemote(中身が同じなら何もしない)
    2. 設定作成             %ProgramData%\PmsRemote\config.psd1 を -ConfigFile から作る(既存は -Force なしでは上書きしない)
                            続けて、ロールに固有の確認・準備(Initialize-Pms<機能>)を呼ぶ(D-4)
    3. グループ作成と ACL   PmsRemoteRead / PmsRemoteChange、state フォルダの権限
    4. HTTPS リスナー       -EnableHttps のときだけ(同じ名前の証明書があれば再利用する)
    5. エンドポイント登録   PmsRemote(構成が変わったときだけ登録し直し、WinRM を再起動する)

  冪等(D-3): 再実行で同じ状態になる。版と構成が同じなら何も変えない。
  2通りの実行(D-5): このマシンで管理者として直接実行する / CLI の deploy が管理者セッションで送り込んで実行する。
    リモートから実行されたときは、WinRM の再起動を 10 秒後のタスクにする(実行中のセッションが切れるため)。
  出力(D-6): 進捗は Write-Host(情報ストリーム)。最後に 1 行の JSON を出す(非ASCII は \uXXXX)。
  終了コード: 0 = 成功 / 1 = 失敗 / 2 = 引数・設定の誤り

.PARAMETER Role          登録するロール(例 ServerRead,ServerChange)
.PARAMETER ConfigFile    リモート側の設定の原本(remote/targets/<接続先名>/config.psd1)
.PARAMETER OperatorUser  接続許可グループに入れるユーザー(Read のロールがあれば PmsRemoteRead、Change があれば PmsRemoteChange)
.PARAMETER ModuleSource  モジュールの置き場所(既定: このスクリプトの隣の module\PmsRemote)
.PARAMETER EnableHttps   WinRM の HTTPS リスナーを作る(既定は HTTP 5985。docs/003 C-1)
.PARAMETER Force         既存の設定を -ConfigFile で上書きする

.EXAMPLE
  .\Install-PmsRemote.ps1 -Role HyperVRead,HyperVChange -ConfigFile .\targets\hyperv-host\config.psd1 -OperatorUser yu
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('HyperVRead', 'HyperVChange', 'ServerRead', 'ServerChange', 'ClientRead', 'ClientChange')]
    [string[]]$Role,
    [string]$ConfigFile = '',
    [string[]]$OperatorUser = @(),
    [string]$ModuleSource = '',
    [switch]$EnableHttps,
    [string]$CertDnsName = $env:COMPUTERNAME,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$EndpointName  = 'PmsRemote'
$ReadGroup     = 'PmsRemoteRead'
$ChangeGroup   = 'PmsRemoteChange'
$BaseDir       = Join-Path $env:ProgramData 'PmsRemote'
$StateDir      = Join-Path $BaseDir 'state'
$TranscriptDir = Join-Path $BaseDir 'Transcripts'
$CfgPath       = Join-Path $BaseDir 'config.psd1'
$InstallInfo   = Join-Path $StateDir 'install.json'
$ModuleDest    = Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules\PmsRemote'

$Role = @($Role | Sort-Object -Unique)
$out = [ordered]@{
    success           = $false
    error_code        = $null
    message           = $null
    host              = $env:COMPUTERNAME
    version           = $null
    roles             = $Role
    actions           = @()
    warnings          = @()
    restart_scheduled = $false
}

function Step([string]$m) { Write-Host "==> $m" }
function Act([string]$a) { $out.actions += $a; Write-Host "    $a" }
function Warn([string]$w) { $out.warnings += $w; Write-Host "    WARN: $w" }

function Get-DirHash([string]$Path) {
    # モジュール(Common.ps1 の Get-PmsDirectoryHash)・CLI と同じ計算
    $root = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\', '/')
    $lines = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($root.Length).Replace('\', '/').TrimStart('/').ToLowerInvariant()
        $rel + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    })
    [Array]::Sort($lines, [StringComparer]::Ordinal)
    return Get-StringHash ($lines -join "`n")
}

function Get-StringHash([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Test-GroupMember([string]$Group, [string]$User) {
    foreach ($m in @(Get-LocalGroupMember -Group $Group -ErrorAction SilentlyContinue)) {
        if ($m.Name -eq $User) { return $true }
        if ($User -notmatch '\\' -and $m.Name -like "*\$User") { return $true }
    }
    return $false
}

$exitCode = 1
try {
    if (-not $ModuleSource) { $ModuleSource = Join-Path $PSScriptRoot 'module\PmsRemote' }
    $manifestPath = Join-Path $ModuleSource 'PmsRemote.psd1'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "INVALID_ARGUMENT: module source not found: $ModuleSource" }
    $out.version = [string](Import-PowerShellDataFile -LiteralPath $manifestPath).ModuleVersion
    if ($ConfigFile -and -not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
        throw "INVALID_ARGUMENT: config file not found: $ConfigFile"
    }
    $features = @($Role | ForEach-Object { $_ -replace '(Read|Change)$', '' } | Sort-Object -Unique)
    $readRoles = @($Role | Where-Object { $_ -like '*Read' })
    $changeRoles = @($Role | Where-Object { $_ -like '*Change' })

    # --- 1. モジュール配置 ------------------------------------------------------
    Step 'モジュール配置'
    $srcHash = Get-DirHash $ModuleSource
    $dstHash = $null
    if (Test-Path -LiteralPath $ModuleDest) { $dstHash = Get-DirHash $ModuleDest }
    if ($srcHash -ne $dstHash) {
        if (Test-Path -LiteralPath $ModuleDest) { Remove-Item -LiteralPath $ModuleDest -Recurse -Force }
        Copy-Item -LiteralPath $ModuleSource -Destination $ModuleDest -Recurse -Force
        Act "module_installed $($out.version)"
    }

    # --- 2. 設定作成 ------------------------------------------------------------
    Step '設定作成'
    foreach ($d in @($BaseDir, $StateDir, (Join-Path $StateDir 'artifacts'), $TranscriptDir)) {
        if (-not (Test-Path -LiteralPath $d)) {
            New-Item -ItemType Directory -Path $d -Force | Out-Null
            Act "dir_created $d"
        }
    }
    if ($ConfigFile) {
        if (-not (Test-Path -LiteralPath $CfgPath)) {
            Copy-Item -LiteralPath $ConfigFile -Destination $CfgPath
            Act 'config_created'
        } elseif ((Get-FileHash -LiteralPath $ConfigFile).Hash -ne (Get-FileHash -LiteralPath $CfgPath).Hash) {
            if ($Force) {
                Copy-Item -LiteralPath $ConfigFile -Destination $CfgPath -Force
                Act 'config_overwritten'
            } else {
                Warn "the existing config differs from the original; kept it (use -Force to overwrite): $CfgPath"
            }
        }
    } elseif (-not (Test-Path -LiteralPath $CfgPath)) {
        Warn "no config: $CfgPath (functions that need settings will fail)"
    }
    # ロールに固有の確認・準備(D-4)
    Import-Module (Join-Path $ModuleDest 'PmsRemote.psd1') -Force
    foreach ($f in $features) {
        $fn = "Initialize-Pms$f"
        if (Get-Command -Name $fn -Module PmsRemote -ErrorAction SilentlyContinue) {
            foreach ($w in @(& $fn)) { if ($w) { Warn ([string]$w) } }
        }
    }

    # --- 3. グループ作成と ACL 付与 ---------------------------------------------
    Step 'グループ作成と ACL 付与'
    foreach ($g in @($ReadGroup, $ChangeGroup)) {
        if (-not (Get-LocalGroup -Name $g -ErrorAction SilentlyContinue)) {
            New-LocalGroup -Name $g -Description "May connect to the PmsRemote JEA endpoint ($g)" | Out-Null
            Act "group_created $g"
        }
    }
    $targetGroups = @()
    if ($readRoles.Count -gt 0) { $targetGroups += $ReadGroup }
    if ($changeRoles.Count -gt 0) { $targetGroups += $ChangeGroup }
    foreach ($u in $OperatorUser) {
        if (-not $u) { continue }
        foreach ($g in $targetGroups) {
            if (-not (Test-GroupMember $g $u)) {
                Add-LocalGroupMember -Group $g -Member $u
                Act "member_added $u -> $g"
            }
        }
    }
    # 実行アカウントの権限(S-7): Server・Client のロールがあればローカル管理者、Hyper-V だけなら Hyper-V Administrators
    $runAsAdmin = (@($features | Where-Object { $_ -ne 'HyperV' }).Count -gt 0)
    $runAsGroups = @()
    if (-not $runAsAdmin) {
        # Hyper-V Administrators(ビルトイン SID S-1-5-32-578。表示名は OS 言語に依存するため SID で解決)
        $hvSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-578')
        $runAsGroups = @($hvSid.Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1])
        $acl = Get-Acl -LiteralPath $StateDir
        $has = $false
        foreach ($rule in @($acl.Access)) {
            try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { continue }
            $modify = [System.Security.AccessControl.FileSystemRights]::Modify
            if ($sid -eq $hvSid.Value -and $rule.AccessControlType -eq 'Allow' -and (($rule.FileSystemRights -band $modify) -eq $modify)) { $has = $true }
        }
        if (-not $has) {
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $hvSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
            Set-Acl -LiteralPath $StateDir -AclObject $acl
            Act 'acl_state_hyperv_admins'
        }
    }

    # --- 4. WinRM と HTTPS リスナー ---------------------------------------------
    Step 'WinRM'
    $httpListener = @(Get-ChildItem WSMan:\localhost\Listener -ErrorAction SilentlyContinue | Where-Object { $_.Keys -contains 'Transport=HTTP' })
    if ((Get-Service -Name WinRM).Status -ne 'Running' -or $httpListener.Count -eq 0) {
        Enable-PSRemoting -Force -SkipNetworkProfileCheck | Out-Null
        Act 'winrm_enabled'
    }
    if ($EnableHttps) {
        $cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object {
            $_.Subject -eq "CN=$CertDnsName" -and $_.FriendlyName -eq 'PmsRemote WinRM' -and $_.NotAfter -gt (Get-Date).AddDays(30)
        } | Sort-Object NotAfter -Descending | Select-Object -First 1
        if (-not $cert) {
            $cert = New-SelfSignedCertificate -DnsName $CertDnsName -CertStoreLocation 'Cert:\LocalMachine\My' `
                -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(5) -FriendlyName 'PmsRemote WinRM'
            Act "cert_created $($cert.Thumbprint)"
        }
        $httpsListeners = @(Get-ChildItem WSMan:\localhost\Listener | Where-Object { $_.Keys -contains 'Transport=HTTPS' })
        $current = $null
        foreach ($l in $httpsListeners) {
            $current = (Get-ChildItem -LiteralPath $l.PSPath | Where-Object { $_.Name -eq 'CertificateThumbprint' }).Value
        }
        if ($httpsListeners.Count -ne 1 -or $current -ne $cert.Thumbprint) {
            foreach ($l in $httpsListeners) { Remove-Item -LiteralPath $l.PSPath -Recurse -Force }
            New-Item -Path WSMan:\localhost\Listener -Transport HTTPS -Address * `
                -CertificateThumbPrint $cert.Thumbprint -HostName $CertDnsName -Force | Out-Null
            Act 'https_listener_created'
        }
        if (-not (Get-NetFirewallRule -Name 'PmsRemote-WinRM-HTTPS' -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -Name 'PmsRemote-WinRM-HTTPS' -DisplayName 'WinRM HTTPS (PmsRemote)' `
                -Direction Inbound -Protocol TCP -LocalPort 5986 -Action Allow | Out-Null
            Act 'firewall_rule_created'
        }
        $cerPath = Join-Path $BaseDir "winrm-$CertDnsName.cer"
        $exported = $null
        if (Test-Path -LiteralPath $cerPath) {
            $exported = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cerPath)).Thumbprint
        }
        if ($exported -ne $cert.Thumbprint) {
            Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
            Act "cert_exported $cerPath"
        }
    }

    # --- 5. エンドポイント登録 ---------------------------------------------------
    Step "エンドポイント $EndpointName"
    $roleDefs = @{}
    if ($readRoles.Count -gt 0) { $roleDefs["$env:COMPUTERNAME\$ReadGroup"] = @{ RoleCapabilities = $readRoles } }
    if ($changeRoles.Count -gt 0) { $roleDefs["$env:COMPUTERNAME\$ChangeGroup"] = @{ RoleCapabilities = $changeRoles } }
    $descriptor = (New-Object psobject -Property ([ordered]@{
        roles = $Role; run_as_admin = $runAsAdmin; run_as_groups = $runAsGroups; transcripts = $TranscriptDir
    }) | ConvertTo-Json -Compress)
    $descHash = Get-StringHash $descriptor
    $prev = $null
    if (Test-Path -LiteralPath $InstallInfo) {
        try { $prev = Get-Content -LiteralPath $InstallInfo -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    $prevDesc = $null
    if ($prev -and $prev.PSObject.Properties['descriptor_hash']) { $prevDesc = [string]$prev.descriptor_hash }
    $exists = Get-PSSessionConfiguration -Name $EndpointName -ErrorAction SilentlyContinue
    $restart = $false
    if (-not $exists -or $prevDesc -ne $descHash) {
        $pssc = Join-Path $BaseDir "$EndpointName.pssc"
        $p = @{
            Path                = $pssc
            SessionType         = 'RestrictedRemoteServer'
            RunAsVirtualAccount = $true
            TranscriptDirectory = $TranscriptDir
            RoleDefinitions     = $roleDefs
        }
        if ($runAsGroups.Count -gt 0) { $p.RunAsVirtualAccountGroups = $runAsGroups }
        New-PSSessionConfigurationFile @p
        if (-not (Test-PSSessionConfigurationFile -Path $pssc)) { throw "CONFIG_INVALID: invalid session configuration file: $pssc" }
        if ($exists) { Unregister-PSSessionConfiguration -Name $EndpointName -NoServiceRestart -Force }
        Register-PSSessionConfiguration -Name $EndpointName -Path $pssc -NoServiceRestart -Force | Out-Null
        Act 'endpoint_registered'
        $restart = $true
    }

    # 配置の記録(Get-PmsRemoteInfo が読む)
    if ($out.actions.Count -gt 0 -or -not $prev) {
        $info = New-Object psobject -Property ([ordered]@{
            version = $out.version; roles = $Role; module_hash = $srcHash; descriptor_hash = $descHash
            installed_at = (Get-Date).ToString('o')
        })
        [System.IO.File]::WriteAllText($InstallInfo, ($info | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    }

    # WinRM の再起動(登録を有効にするため)
    if ($restart) {
        if (Get-Variable -Name PSSenderInfo -ErrorAction SilentlyContinue) {
            # リモートから実行されている。今すぐ再起動するとこのセッションが切れるので、10 秒後のタスクにする
            $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -Command "Restart-Service -Name WinRM -Force"'
            $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)
            Register-ScheduledTask -TaskName 'PmsRemote-RestartWinRM' -Action $action -Trigger $trigger `
                -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
            $out.restart_scheduled = $true
            Act 'winrm_restart_scheduled'
        } else {
            Restart-Service -Name WinRM -Force
            Act 'winrm_restarted'
        }
    }

    $out.success = $true
    if ($out.actions.Count -eq 0) { $out.message = 'no changes' } else { $out.message = 'installed' }
    $exitCode = 0
} catch {
    $msg = $_.Exception.Message
    $out.message = $msg
    if ($msg -match '^([A-Z_]{3,40}):') { $out.error_code = $Matches[1] } else { $out.error_code = 'INSTALL_FAILED' }
    if (@('INVALID_ARGUMENT', 'CONFIG_INVALID', 'CONFIG_NOT_FOUND') -contains $out.error_code) { $exitCode = 2 }
    Write-Host "    FAILED: $msg"
}

$json = New-Object psobject -Property $out | ConvertTo-Json -Compress -Depth 5
Write-Output ([regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
exit $exitCode
