#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Hyper-V ホストに「ゴールデンイメージ復元専用」の JEA エンドポイントを導入する。

.DESCRIPTION
  1. 対象VMと同名チェックポイント(ちょうど1つ)の存在を確認
  2. モジュール PmsGoldenRestore を %ProgramFiles%\WindowsPowerShell\Modules に配置
  3. 設定 %ProgramData%\PmsGoldenRestore\config.psd1 を作成(既存は -Force 時のみ上書き)
  4. 接続を許すローカルグループ(既定: PmsRestoreOperators)を作成し、指定ユーザーを追加
  5. JEA エンドポイント PmsGoldenRestore を登録
     - 実行アカウントは仮想アカウント。権限は "Hyper-V Administrators" のみ(ローカル管理者にしない)
     - 操作の記録(トランスクリプト)を %ProgramData%\PmsGoldenRestore\Transcripts に残す
  6. (任意) WinRM HTTPS リスナーを自己署名証明書で作成し、証明書を .cer でエクスポート

  AI 実行環境とホストが同一PCの間は -EnableHttpsListener は不要(localhost への HTTP で動く)。
  ホストを分離するときに -EnableHttpsListener を付けて再実行する。

.EXAMPLE
  .\Install-PmsRestoreEndpoint.ps1 -VMName 'PMS-TEST-01' -CheckpointName 'golden' -OperatorUser 'yu'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$CheckpointName,
    [string]$OperatorGroup = 'PmsRestoreOperators',
    [string[]]$OperatorUser = @(),
    [string]$EndpointName = 'PmsGoldenRestore',
    [switch]$EnableHttpsListener,
    [string]$CertDnsName = $env:COMPUTERNAME,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }

$srcModule = Join-Path $PSScriptRoot 'PmsGoldenRestore'
if (-not (Test-Path -LiteralPath (Join-Path $srcModule 'PmsGoldenRestore.psm1'))) {
    throw "Module source not found: $srcModule"
}

# --- 1. 対象の確認 ---------------------------------------------------------
Step "対象VMとチェックポイントを確認"
$vm = Get-VM -Name $VMName
$snaps = @(Get-VMSnapshot -VM $vm -Name $CheckpointName -ErrorAction SilentlyContinue)
if ($snaps.Count -ne 1) {
    throw "VM '$VMName' に '$CheckpointName' という名前のチェックポイントがちょうど1つ必要です(現在 $($snaps.Count) 件)。"
}
Write-Host "    VM=$VMName  checkpoint=$CheckpointName  type=$($snaps[0].SnapshotType)  created=$($snaps[0].CreationTime)"
if ([string]$snaps[0].SnapshotType -notmatch 'Production|Standard') {
    Write-Warning "チェックポイント種別が想定外です: $($snaps[0].SnapshotType)"
}

# --- 2. モジュール配置 -----------------------------------------------------
Step "モジュールを配置"
$dstModule = Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules\PmsGoldenRestore'
if (Test-Path -LiteralPath $dstModule) { Remove-Item -LiteralPath $dstModule -Recurse -Force }
Copy-Item -LiteralPath $srcModule -Destination $dstModule -Recurse -Force
Write-Host "    $dstModule"

# --- 3. 設定ファイルと状態フォルダ -----------------------------------------
Step "設定ファイルを作成"
$baseDir = Join-Path $env:ProgramData 'PmsGoldenRestore'
$stateDir = Join-Path $baseDir 'state'
$transcriptDir = Join-Path $baseDir 'Transcripts'
foreach ($d in @($baseDir, $stateDir, $transcriptDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$cfgPath = Join-Path $baseDir 'config.psd1'
if ((Test-Path -LiteralPath $cfgPath) -and -not $Force) {
    Write-Host "    既存の設定を維持: $cfgPath  (上書きするには -Force)"
} else {
    $cfgText = @"
@{
    VMName           = '$($VMName -replace "'", "''")'
    CheckpointName   = '$($CheckpointName -replace "'", "''")'
    StopTimeoutSec   = 120
    BootTimeoutSec   = 900
    PollIntervalSec  = 5
    RequireHeartbeat = `$true
}
"@
    Set-Content -LiteralPath $cfgPath -Value $cfgText -Encoding UTF8
    Write-Host "    $cfgPath"
}

# Hyper-V Administrators(ビルトイン SID S-1-5-32-578。表示名は OS 言語に依存するため SID で解決)
$hvAdminSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-578')
$hvAdminName = $hvAdminSid.Translate([System.Security.Principal.NTAccount]).Value   # 例: BUILTIN\Hyper-V Administrators
$hvAdminShort = $hvAdminName.Split('\')[-1]

# state フォルダだけ Hyper-V Administrators に変更権限(設定ファイルは読み取りのみのまま)
$acl = Get-Acl -LiteralPath $stateDir
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $hvAdminSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $stateDir -AclObject $acl

# --- 4. 接続許可グループ ---------------------------------------------------
Step "接続許可グループ $OperatorGroup を準備"
if (-not (Get-LocalGroup -Name $OperatorGroup -ErrorAction SilentlyContinue)) {
    New-LocalGroup -Name $OperatorGroup -Description 'May connect to the PMS golden-image restore JEA endpoint' | Out-Null
    Write-Host "    作成しました"
}
foreach ($u in $OperatorUser) {
    $already = @(Get-LocalGroupMember -Group $OperatorGroup -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*\$u" -or $_.Name -eq $u })
    if ($already.Count -eq 0) {
        Add-LocalGroupMember -Group $OperatorGroup -Member $u
        Write-Host "    追加: $u"
    }
}

# --- 5. JEA エンドポイント登録 ---------------------------------------------
Step "WinRM を有効化"
Enable-PSRemoting -Force -SkipNetworkProfileCheck | Out-Null

Step "JEA エンドポイント $EndpointName を登録"
$psscPath = Join-Path $baseDir "$EndpointName.pssc"
New-PSSessionConfigurationFile -Path $psscPath `
    -SessionType RestrictedRemoteServer `
    -RunAsVirtualAccount `
    -RunAsVirtualAccountGroups $hvAdminShort `
    -TranscriptDirectory $transcriptDir `
    -RoleDefinitions @{ "$env:COMPUTERNAME\$OperatorGroup" = @{ RoleCapabilities = 'PmsGoldenRestore' } }

if (-not (Test-PSSessionConfigurationFile -Path $psscPath)) {
    throw "セッション構成ファイルが不正です: $psscPath"
}
if (Get-PSSessionConfiguration -Name $EndpointName -ErrorAction SilentlyContinue) {
    Unregister-PSSessionConfiguration -Name $EndpointName -Force
}
Register-PSSessionConfiguration -Name $EndpointName -Path $psscPath -Force | Out-Null
Write-Host "    登録しました(WinRM サービスが再起動されます)"

# --- 6. HTTPS リスナー(ホスト分離時) --------------------------------------
if ($EnableHttpsListener) {
    Step "WinRM HTTPS リスナーを作成"
    $cert = New-SelfSignedCertificate -DnsName $CertDnsName -CertStoreLocation 'Cert:\LocalMachine\My' `
        -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(5)
    $existing = @(Get-ChildItem WSMan:\localhost\Listener | Where-Object {
        ($_.Keys -contains 'Transport=HTTPS') })
    foreach ($l in $existing) { Remove-Item -LiteralPath $l.PSPath -Recurse -Force }
    New-Item -Path WSMan:\localhost\Listener -Transport HTTPS -Address * `
        -CertificateThumbPrint $cert.Thumbprint -HostName $CertDnsName -Force | Out-Null
    if (-not (Get-NetFirewallRule -Name 'PmsRestore-WinRM-HTTPS' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'PmsRestore-WinRM-HTTPS' -DisplayName 'WinRM HTTPS (PMS restore)' `
            -Direction Inbound -Protocol TCP -LocalPort 5986 -Action Allow | Out-Null
    }
    $cerPath = Join-Path $baseDir "winrm-$CertDnsName.cer"
    Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
    Write-Host "    証明書: $cerPath"
    Write-Host "    → AI 実行環境の [ローカルコンピューター\信頼されたルート証明機関] にインポートしてください"
}

Step "完了"
Write-Host @"
    確認(このホスト上で、$OperatorGroup のメンバーとして):
      Invoke-Command -ComputerName localhost -ConfigurationName $EndpointName -ScriptBlock { Get-PmsGoldenImageInfo }
    接続したユーザーが Hyper-V に触れられるのは Restore-PmsGoldenImage と Get-PmsGoldenImageInfo だけです
    (JEA 既定の Get-Command / Exit-PSSession などの最小限のコマンドは別に見えます)。
"@
