<#
  pms-remote CLI — 基本のサブコマンド: info / check-target / deploy / cred-set
  deploy と check-target だけが配置用(管理者)の資格情報を使う(docs/003 C-4)。
#>

# --- info ----------------------------------------------------------------------

function Invoke-InfoCommand($cfg, [string]$targetName) {
    # 版・登録済みのロール・モジュールと設定がリポジトリと同じかを返す(何も変更しない)
    $c = Connect-RemoteTarget $cfg $targetName -NoVersionCheck
    $info = $c.Info
    $localVersion = Get-LocalModuleVersion
    $orig = Get-TargetConfigOriginal $targetName
    $origHash = $null
    if ($orig) { $origHash = (Get-FileHash -LiteralPath $orig -Algorithm SHA256).Hash }
    $remoteRoles = @($info.Roles | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $Out.host = $c.Target.Host
    $Out.version = [string]$info.Version
    $Out.expected_version = $c.ExpectedVersion
    $Out.repository_version = $localVersion
    $Out.roles = $remoteRoles
    $Out.roles_match = (($remoteRoles -join ',') -eq ($c.Target.Roles -join ','))
    $Out.module_matches = ([string]$info.ModuleHash -eq (Get-DirHash (Get-LocalModulePath)))
    $Out.config_matches = ([string]$info.ConfigHash -eq [string]$origHash)
    $Out.installed_at = $info.InstalledAt
    $Out.server_time_offset_sec = $c.ServerTimeOffsetSec
    if (-not (Test-VersionCompatible ([string]$info.Version) $c.ExpectedVersion)) {
        throw "VERSION_MISMATCH: $targetName has PmsRemote $($info.Version), expected $($c.ExpectedVersion). Run: pms-remote.ps1 deploy -Target $targetName"
    }
    $Out.success = $true
    $Out.message = 'ok'
}

# --- check-target ----------------------------------------------------------------

function Invoke-CheckTargetCommand($cfg, [string]$targetName) {
    # 接続先の一度きりの前提(C-5)を確かめる。何も変更しない
    $t = Get-RemoteTarget $cfg $targetName
    $checks = New-Object System.Collections.ArrayList
    function Add-Check([string]$name, $ok, [string]$detail, [bool]$required = $true) {
        [void]$checks.Add([pscustomobject][ordered]@{ name = $name; ok = $ok; required = $required; detail = $detail })
    }

    # 1. WinRM が応答する
    $wsman = @{ ComputerName = $t.Host; ErrorAction = 'Stop' }
    if ($t.Transport -eq 'https') { $wsman.UseSSL = $true }
    if ($t.Port -gt 0) { $wsman.Port = $t.Port }
    try { $null = Test-WSMan @wsman; Add-Check 'winrm_reachable' $true "$($t.Host) ($($t.Transport))" }
    catch { Add-Check 'winrm_reachable' $false $_.Exception.Message }

    # 2. 呼び出し元の TrustedHosts(HTTP で別のマシンに接続するとき)
    if ($t.Transport -eq 'http' -and -not (Test-LocalHostName $t.Host)) {
        try {
            $th = [string](Get-Item -Path WSMan:\localhost\Client\TrustedHosts -ErrorAction Stop).Value
            $entries = @($th.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            $hit = @($entries | Where-Object { $t.Host -like $_ }).Count -gt 0
            Add-Check 'client_trusted_hosts' $hit "TrustedHosts='$th'"
        } catch {
            Add-Check 'client_trusted_hosts' $null "cannot read TrustedHosts (run as administrator to check): $($_.Exception.Message)"
        }
    }

    # 3〜6. 配置用の管理者セッション
    $admin = $null
    try {
        $admin = Open-RemoteSession $t -Admin
        Add-Check 'admin_session' $true "deployCredential='$($t.DeployCredential)'"
    } catch {
        Add-Check 'admin_session' $false $_.Exception.Message
    }
    if ($admin) {
        $r = Invoke-Command -Session $admin -ErrorAction Stop -ScriptBlock {
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
            $elevated = (New-Object System.Security.Principal.WindowsPrincipal($me)).IsInRole(
                [System.Security.Principal.WindowsBuiltInRole]::Administrator)
            $policy = $null
            try { $policy = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name LocalAccountTokenFilterPolicy -ErrorAction Stop).LocalAccountTokenFilterPolicy } catch { }
            $local = $me.Name.Split('\')[0] -eq $env:COMPUTERNAME
            $expires = $null
            if ($local) {
                try { $expires = (Get-LocalUser -Name $me.Name.Split('\')[-1] -ErrorAction Stop).PasswordExpires } catch { }
            }
            $endpoint = $null
            try { $endpoint = [bool](Get-PSSessionConfiguration -Name PmsRemote -ErrorAction Stop) } catch { $endpoint = $false }
            $install = $null
            $p = Join-Path $env:ProgramData 'PmsRemote\state\install.json'
            if (Test-Path -LiteralPath $p) { $install = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json }
            [pscustomobject]@{
                User = $me.Name; Elevated = $elevated; Policy = $policy; Local = $local
                PasswordExpires = $(if ($expires) { $expires.ToString('o') } else { $null })
                Endpoint = $endpoint
                Version = $(if ($install) { [string]$install.version } else { $null })
            }
        }
        Add-Check 'admin_elevated' ([bool]$r.Elevated) "user=$($r.User) LocalAccountTokenFilterPolicy=$($r.Policy)"
        if ($r.Local) {
            Add-Check 'password_never_expires' ($null -eq $r.PasswordExpires) "PasswordExpires=$($r.PasswordExpires)"
        }
        Add-Check 'endpoint_registered' ([bool]$r.Endpoint) 'created by deploy' $false
        Add-Check 'installed_version' ($null -ne $r.Version) "version=$($r.Version)" $false
        Close-RemoteSession $admin
    }

    $Out.host = $t.Host
    $Out.checks = @($checks)
    $failed = @($checks | Where-Object { $_.required -and $_.ok -ne $true })
    if ($failed.Count -gt 0) {
        throw "TARGET_NOT_READY: $($targetName): $(@($failed | ForEach-Object { $_.name }) -join ', ')"
    }
    $Out.success = $true
    $Out.message = 'ready'
}

# --- deploy ----------------------------------------------------------------------

function Get-OperatorUser($t) {
    # JEA の接続許可グループに入れるユーザー = 通常用の資格情報のユーザー
    if ($t.Credential) {
        $u = [string](Get-StoredCredential $t.Credential).UserName
        if ($u -match '^(.+?)\\(.+)$') {
            $prefix = $Matches[1]
            if ($prefix -eq '.' -or $prefix -ieq $t.Host -or $prefix -ieq $t.Host.Split('.')[0]) { $u = $Matches[2] }
        }
        return @($u)
    }
    if (Test-LocalHostName $t.Host) { return @("$env:USERDOMAIN\$env:USERNAME") }
    return @()
}

function Invoke-Deploy($cfg, [string]$targetName, [switch]$Force) {
    # 共通インストーラを接続先へ送り込んで実行する(D-5)。失敗しても例外にせず、結果を返す
    $res = [ordered]@{
        target = $targetName; status = $null; version = $null; actions = @(); warnings = @()
        restart_scheduled = $false; error_code = $null; message = $null
    }
    $admin = $null
    $remoteDir = $null
    try {
        $t = Get-RemoteTarget $cfg $targetName
        if ($t.Roles.Count -eq 0) { throw "CONFIG_INVALID: targets.$targetName.roles is empty" }
        $modPath = Get-LocalModulePath
        $installer = Join-Path (Join-Path $script:RepoRoot 'remote') 'Install-PmsRemote.ps1'
        $orig = Get-TargetConfigOriginal $targetName
        $localVersion = Get-LocalModuleVersion
        $localHash = Get-DirHash $modPath
        $origHash = $null
        if ($orig) { $origHash = (Get-FileHash -LiteralPath $orig -Algorithm SHA256).Hash }
        $res.version = $localVersion

        # 版・モジュール・設定・ロールが同じなら何もしない
        if (-not $Force) {
            try {
                $s = Open-RemoteSession $t
                $info = Invoke-Remote $s 'Get-PmsRemoteInfo'
                Close-RemoteSession $s
                $remoteRoles = @($info.Roles | ForEach-Object { [string]$_ } | Sort-Object -Unique)
                if ([string]$info.Version -eq $localVersion -and [string]$info.ModuleHash -eq $localHash -and
                    [string]$info.ConfigHash -eq [string]$origHash -and ($remoteRoles -join ',') -eq ($t.Roles -join ',')) {
                    $res.status = 'skipped'
                    $res.message = "already deployed ($localVersion)"
                    Write-Log "deploy ${targetName}: already deployed ($localVersion)"
                    return $res
                }
            } catch {
                Write-Log "deploy ${targetName}: endpoint not usable yet ($($_.Exception.Message))"
            }
        }

        Write-Log "deploy ${targetName}: installing PmsRemote $localVersion (roles: $($t.Roles -join ','))"
        $admin = Open-RemoteSession $t -Admin
        $remoteDir = Invoke-Command -Session $admin -ErrorAction Stop -ScriptBlock {
            $d = Join-Path $env:TEMP ('PmsRemoteDeploy-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path (Join-Path $d 'module') -Force | Out-Null
            $d
        }
        Copy-Item -LiteralPath $modPath -Destination "$remoteDir\module" -ToSession $admin -Recurse -ErrorAction Stop
        Copy-Item -LiteralPath $installer -Destination "$remoteDir\Install-PmsRemote.ps1" -ToSession $admin -ErrorAction Stop
        $installArgs = @{
            Role         = [string[]]$t.Roles
            ModuleSource = "$remoteDir\module\PmsRemote"
            OperatorUser = [string[]](Get-OperatorUser $t)
            Force        = [bool]$Force
            EnableHttps  = ($t.Transport -eq 'https')
            CertDnsName  = $t.Host
        }
        if ($orig) {
            Copy-Item -LiteralPath $orig -Destination "$remoteDir\config.psd1" -ToSession $admin -ErrorAction Stop
            $installArgs.ConfigFile = "$remoteDir\config.psd1"
        }
        $lines = New-Object System.Collections.ArrayList
        Invoke-Command -Session $admin -ErrorAction Stop -ArgumentList $remoteDir, $installArgs -ScriptBlock {
            param($dir, $a)
            & (Join-Path $dir 'Install-PmsRemote.ps1') @a
        } 6>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.InformationRecord]) { Write-Log "  [$targetName] $($_.MessageData)" }
            else { [void]$lines.Add([string]$_) }
        }
        try {
            Invoke-Command -Session $admin -ArgumentList $remoteDir -ScriptBlock {
                param($d) Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
            }
        } catch { }
        Close-RemoteSession $admin
        $admin = $null

        $json = @($lines | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
        if (-not $json) { throw "DEPLOY_FAILED: no result from the installer on $targetName" }
        $ir = $json | ConvertFrom-Json
        $res.actions = @($ir.actions)
        $res.warnings = @($ir.warnings)
        $res.restart_scheduled = [bool]$ir.restart_scheduled
        if (-not $ir.success) {
            $m = [string]$ir.message
            if ($m -notmatch '^[A-Z_]{3,40}:') { $m = "DEPLOY_FAILED: $m" }
            throw $m
        }

        # 配置の確認(WinRM の再起動を待ってから、JEA で版とモジュールを確かめる)
        if ($res.restart_scheduled) {
            Write-Log "deploy ${targetName}: waiting for WinRM to restart"
            Start-Sleep -Seconds 15
        }
        $deadline = (Get-Date).AddSeconds(180)
        $verified = $false
        $last = $null
        while (-not $verified -and (Get-Date) -lt $deadline) {
            try {
                $s = Open-RemoteSession $t
                $info = Invoke-Remote $s 'Get-PmsRemoteInfo'
                Close-RemoteSession $s
                if ([string]$info.Version -eq $localVersion -and [string]$info.ModuleHash -eq $localHash) { $verified = $true; break }
                $last = "version=$($info.Version)"
            } catch {
                $last = $_.Exception.Message
            }
            Start-Sleep -Seconds 5
        }
        if (-not $verified) { throw "DEPLOY_VERIFY_FAILED: the endpoint on $targetName did not report $localVersion ($last)" }
        $res.status = 'deployed'
        $res.message = $ir.message
        Write-Log "deploy ${targetName}: done ($($ir.message))"
    } catch {
        $m = $_.Exception.Message
        if ($m -notmatch '^[A-Z_]{3,40}:') { $m = "DEPLOY_FAILED: $m" }
        $res.status = 'failed'
        $res.error_code = ($m -split ':')[0]
        $res.message = $m
        Write-Log "deploy ${targetName}: FAILED: $m"
    } finally {
        if ($admin) {
            if ($remoteDir) {
                try {
                    Invoke-Command -Session $admin -ArgumentList $remoteDir -ScriptBlock {
                        param($d) Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
                    }
                } catch { }
            }
            Close-RemoteSession $admin
        }
    }
    return $res
}

function Invoke-DeployCommand($cfg, [string]$targetName, [switch]$Force) {
    $r = Invoke-Deploy $cfg $targetName -Force:$Force
    foreach ($k in $r.Keys) { if ($k -ne 'target') { $Out[$k] = $r[$k] } }
    if ($r.status -eq 'failed') { throw [string]$r.message }
    $Out.success = $true
    $Out.message = [string]$r.message
}

# --- cred-set --------------------------------------------------------------------

function Invoke-CredSetCommand([string]$ref) {
    # 資格情報を参照名で保存する(C-3。DPAPI により保存したユーザーと PC でしか復号できない)。対話で入力する
    if (-not $ref) { throw 'INVALID_ARGUMENT: usage: pms-remote.ps1 cred-set <reference name>' }
    $path = Get-CredentialPath $ref
    $c = Get-Credential -Message "PmsRemote: credential '$ref'"
    if (-not $c) { throw 'INVALID_ARGUMENT: no credential was entered' }
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $c | Export-Clixml -LiteralPath $path
    $Out.credential = $ref
    $Out.path = $path
    $Out.user = $c.UserName
    $Out.success = $true
    $Out.message = 'saved'
}
