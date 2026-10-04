#Requires -Version 5.1
<#
.SYNOPSIS
  作業の status.yaml に記録された環境復元(env_restore)を機械的に検査する lint。
  AI に「復元したか」を確認させないための仕組み(トークンを使わない)。

.DESCRIPTION
  検査項目:
    ENV001  status.yaml に env_restore.restore_id がある
    ENV002  その restore_id が復元記録(env-restore-log.jsonl)に success=true で存在する
    ENV003  復元記録の purpose が期待値(-Purpose)と一致する
    ENV004  同じ restore_id を別の status.yaml が使っていない(-WorkRoot 指定時。復元の使い回しを検出)
    ENV005  起動確認の記録が復元記録と矛盾しない
            - 復元記録の readiness が verified → status.yaml の readiness は auto
            - 復元記録の readiness が unavailable(起動確認テストがなかった)→ status.yaml の readiness は human
              (人間がログインを確かめたことの記録。確かめずに作業を始めていないか)

  status.yaml 側の想定書式(作業の status.yaml の最上位に置く):
    env_restore:
      restore_id: RST-20260926-114600-a1b2
      purpose: work10
      readiness: auto            # auto = 起動確認テストで確認 / human = 人間がログインを確認

  出力: 違反ごとに "NG <コード>: <内容>" を1行、違反なしなら "OK ..." を1行。
  終了コード: 0=違反なし / 1=違反あり / 2=引数・ファイルの誤り

.EXAMPLE
  .\Test-EnvRestoreMarker.ps1 -StatusFile work\F-003\10\status.yaml -Purpose work10 -WorkRoot work
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StatusFile,
    [ValidateSet('', 'regression', 'work10', 'work20', 'manual')]
    [string]$Purpose = '',
    [string]$MarkerLog = '',
    [string]$WorkRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-EnvRestoreField([string]$path, [string]$field) {
    # YAML パーサに依存しない最小限の読み取り: env_restore: ブロック内の指定キーを拾う
    $inBlock = $false
    foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
        if ($line -match '^env_restore:\s*$') { $inBlock = $true; continue }
        if ($inBlock) {
            if ($line -match '^\S') { break }   # 次の最上位キーでブロック終了
            if ($line -match ('^\s+' + $field + ':\s*["'']?([A-Za-z0-9_\-]+)["'']?\s*(#.*)?$')) { return $Matches[1] }
        }
    }
    return $null
}
function Get-RestoreIdFromStatus([string]$path) { return (Get-EnvRestoreField $path 'restore_id') }

if (-not (Test-Path -LiteralPath $StatusFile)) {
    Write-Output "NG ENV000: status file not found: $StatusFile"
    exit 2
}

if (-not $MarkerLog) {
    # リモートコマンドのクライアント設定 config/remote-targets.json を上位へ探索し、restore.markerLog を得る
    $dir = Split-Path -Parent (Resolve-Path -LiteralPath $StatusFile).Path
    $cfgFile = $null
    while ($dir) {
        $c = Join-Path (Join-Path $dir 'config') 'remote-targets.json'
        if (Test-Path -LiteralPath $c) { $cfgFile = $c; break }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    if ($env:PMS_REMOTE_CONFIG) { $cfgFile = $env:PMS_REMOTE_CONFIG }
    $rel = 'work/_common/env-restore-log.jsonl'
    $root = $null
    if ($cfgFile) {
        $cfg = Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $r = $cfg.PSObject.Properties['restore']
        if ($r -and $r.Value) {
            $p = $r.Value.PSObject.Properties['markerLog']
            if ($p -and $p.Value) { $rel = [string]$p.Value }
        }
        $root = Split-Path -Parent (Split-Path -Parent $cfgFile)
    }
    if ([System.IO.Path]::IsPathRooted($rel)) { $MarkerLog = $rel }
    elseif ($root) { $MarkerLog = Join-Path $root $rel }
    else { $MarkerLog = $rel }
}

$violations = New-Object System.Collections.Generic.List[string]

$restoreId = Get-RestoreIdFromStatus $StatusFile
if (-not $restoreId) {
    $violations.Add("NG ENV001: env_restore.restore_id is missing in $StatusFile (restore-golden-image skill was not run, or its result was not recorded)")
} else {
    $entry = $null
    if (Test-Path -LiteralPath $MarkerLog) {
        foreach ($l in Get-Content -LiteralPath $MarkerLog -Encoding UTF8) {
            if (-not $l.Trim()) { continue }
            try { $o = $l | ConvertFrom-Json } catch { continue }
            if ($o.restore_id -eq $restoreId) { $entry = $o }
        }
    }
    if ($null -eq $entry) {
        $violations.Add("NG ENV002: restore_id $restoreId not found in $MarkerLog")
    } elseif (-not $entry.success) {
        $violations.Add("NG ENV002: restore $restoreId failed ($($entry.error_code): $($entry.message))")
    } elseif ($Purpose -and $entry.purpose -ne $Purpose) {
        $violations.Add("NG ENV003: restore $restoreId purpose is '$($entry.purpose)', expected '$Purpose'")
    }

    if ($null -ne $entry -and $entry.success) {
        $recorded = [string](Get-EnvRestoreField $StatusFile 'readiness')
        $markerReadiness = $null
        if ($entry.PSObject.Properties['readiness']) { $markerReadiness = [string]$entry.readiness }
        if ($markerReadiness -eq 'verified' -and $recorded -ne 'auto') {
            $violations.Add("NG ENV005: restore $restoreId was verified by the readiness test; env_restore.readiness must be 'auto' (found '$recorded')")
        } elseif ($markerReadiness -eq 'unavailable' -and $recorded -ne 'human') {
            $violations.Add("NG ENV005: restore $restoreId had no readiness test; a human must confirm the Web UI login and env_restore.readiness must be 'human' (found '$recorded')")
        }
    }

    if ($WorkRoot) {
        $self = (Resolve-Path -LiteralPath $StatusFile).Path
        $others = Get-ChildItem -LiteralPath $WorkRoot -Recurse -Filter 'status.yaml' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -ne $self }
        foreach ($f in $others) {
            if ((Get-RestoreIdFromStatus $f.FullName) -eq $restoreId) {
                $violations.Add("NG ENV004: restore_id $restoreId is also used by $($f.FullName) (restore was reused, not re-run)")
            }
        }
    }
}

if ($violations.Count -gt 0) {
    $violations | ForEach-Object { Write-Output $_ }
    exit 1
}
Write-Output "OK env_restore $restoreId ($StatusFile)"
exit 0
