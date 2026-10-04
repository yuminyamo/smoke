<#
  pms-remote CLI — logs-collect / logs-ids(ログ収集。SK-LOG。docs/skill整備要求.md)
  logs-collect: pms-vm(既定。logCollect.target)の ServerRead で Invoke-PmsLogCollect を時間範囲だけ渡して呼び、
                成果物(zip)を受け取って -OutDir に展開し、ログIDと件数の一覧を返す(ログの本文は返さない)
                -InfoOnly はツールを実行せず、設定・マスクの指定・ツールの有無・管理者権限を確かめる
  logs-ids    : すでに集めた -OutDir から、ログIDと件数の一覧だけを作り直す(接続しない)
  結果は標準出力の最後の1行に JSON で出し、logs-collect は -OutDir\_collect.json にも残す。
#>

$script:ResultFileName = '_collect.json'

function New-Regex([string]$pattern, [string]$group, [string]$key) {
    if (-not $pattern) { return $null }
    try { $re = New-Object System.Text.RegularExpressions.Regex($pattern) }
    catch { throw "CONFIG_INVALID: logCollect.$key is not a valid regex: $($_.Exception.Message)" }
    if ($group -and ($re.GetGroupNames() -notcontains $group)) {
        throw "CONFIG_INVALID: logCollect.$key must have a named group (?<$group>...)"
    }
    return $re
}

function Get-BundleSummary([string]$dir, $lc) {
    # ログの書式からログIDを機械的に抜き出して数える(LOG-5)。本文は返さない
    $idRe = New-Regex ([string](Get-Prop $lc 'logIdPattern' '')) 'id' 'logIdPattern'
    if (-not $idRe) { throw 'CONFIG_INVALID: logCollect.logIdPattern is required' }
    $levelRe = New-Regex ([string](Get-Prop $lc 'levelPattern' '')) 'level' 'levelPattern'
    $entryRe = New-Regex ([string](Get-Prop $lc 'entryPattern' '')) '' 'entryPattern'
    $include = @(Get-Prop $lc 'scanInclude' @('*'))
    $maxIds = [int](Get-Prop $lc 'maxLogIds' 200)
    $maxFiles = [int](Get-Prop $lc 'maxFiles' 200)
    try { $enc = [System.Text.Encoding]::GetEncoding([string](Get-Prop $lc 'encoding' 'utf-8')) }
    catch { throw "CONFIG_INVALID: logCollect.encoding: $($_.Exception.Message)" }

    $root = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\', '/')
    $resultFile = Join-Path $root $script:ResultFileName
    $all = @(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.FullName -ne $resultFile } | Sort-Object FullName)

    $counts = @{}
    $noId = 0
    $scanned = 0
    foreach ($f in $all) {
        $hit = $false
        foreach ($pat in $include) { if ($f.Name -like [string]$pat) { $hit = $true; break } }
        if (-not $hit) { continue }
        $scanned++
        foreach ($line in [System.IO.File]::ReadLines($f.FullName, $enc)) {
            $m = $idRe.Match($line)
            if ($m.Success) {
                $level = ''
                if ($levelRe) {
                    $lm = $levelRe.Match($line)
                    if ($lm.Success) { $level = $lm.Groups['level'].Value }
                }
                $key = $m.Groups['id'].Value + "`t" + $level
                if ($counts.ContainsKey($key)) { $counts[$key]++ } else { $counts[$key] = 1 }
            } elseif ($entryRe -and $entryRe.IsMatch($line)) {
                $noId++
            }
        }
    }

    $ids = @($counts.GetEnumerator() | ForEach-Object {
        $parts = ([string]$_.Key).Split("`t")
        $lv = $null
        if ($parts[1] -ne '') { $lv = $parts[1] }
        [pscustomobject][ordered]@{ id = $parts[0]; count = [int]$_.Value; level = $lv }
    } | Sort-Object @{ Expression = { $_.count }; Descending = $true }, @{ Expression = { $_.id } })
    if ($noId -gt 0) {
        # ログIDを持たない行(entryPattern に合う行)は件数だけ返す
        $ids += [pscustomobject][ordered]@{ id = $null; count = $noId; level = $null }
    }
    $kinds = $ids.Count
    $truncated = $false
    if ($kinds -gt $maxIds) { $ids = @($ids[0..($maxIds - 1)]); $truncated = $true }

    $files = @($all | ForEach-Object {
        [pscustomobject][ordered]@{ name = $_.FullName.Substring($root.Length + 1).Replace('\', '/'); size = $_.Length }
    })
    $filesTotal = $files.Count
    $filesTruncated = $false
    if ($filesTotal -gt $maxFiles) { $files = @($files[0..($maxFiles - 1)]); $filesTruncated = $true }

    return [ordered]@{
        log_ids = $ids; log_id_kinds = $kinds; truncated = $truncated
        files = $files; files_total = $filesTotal; files_truncated = $filesTruncated; scanned_files = $scanned
    }
}

function Set-Summary($summary) {
    foreach ($k in $summary.Keys) { $Out[$k] = $summary[$k] }
}

function Get-LogCollectSettings($cfg) {
    $lc = Get-Prop $cfg 'logCollect' $null
    if ($null -eq $lc) { throw "CONFIG_INVALID: 'logCollect' section is missing in $($script:ConfigFile)" }
    return $lc
}

function Resolve-OutDir([string]$outDir) {
    if (-not $outDir) { throw 'INVALID_ARGUMENT: -OutDir is required' }
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($outDir)
}

function Invoke-LogsIdsCommand($cfg, [string]$outDir) {
    $lc = Get-LogCollectSettings $cfg
    $dir = Resolve-OutDir $outDir
    $Out.bundle = $dir
    $prevFile = Join-Path $dir $script:ResultFileName
    if (-not (Test-Path -LiteralPath $prevFile -PathType Leaf)) {
        throw "NOT_A_BUNDLE: $prevFile not found (not a directory made by logs-collect)"
    }
    $prev = Get-Content -LiteralPath $prevFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $Out.target = Get-Prop $prev 'target' $null
    $Out.collect_id = Get-Prop $prev 'collect_id' $null
    $Out.window = Get-Prop $prev 'window' $null
    $Out.masked = [bool](Get-Prop $prev 'masked' $false)
    $Out.server_time_offset_sec = Get-Prop $prev 'server_time_offset_sec' $null
    if (-not $Out.masked) { throw "NOT_A_BUNDLE: $prevFile does not record a masked collection" }
    Set-Summary (Get-BundleSummary $dir $lc)
    $Out.success = $true
    $Out.message = 'log ids recounted from the existing bundle'
}

function Invoke-LogsCollectCommand($cfg, [string]$from, [string]$to, [string]$outDir, [switch]$InfoOnly, [string]$targetOverride) {
    $lc = Get-LogCollectSettings $cfg
    $targetName = [string](Get-Prop $lc 'target' 'pms-vm')
    if ($targetOverride) { $targetName = $targetOverride }
    $Out.target = $targetName

    # --- 接続確認のみ(ツールは実行しない) -------------------------------------------
    if ($InfoOnly) {
        $null = New-Regex ([string](Get-Prop $lc 'logIdPattern' '')) 'id' 'logIdPattern'
        $c = Connect-RemoteTarget $cfg $targetName
        $info = Invoke-Remote $c.Session 'Get-PmsLogCollectInfo'
        $Out.info = [ordered]@{
            host = $info.HostName; config_ok = $info.ConfigOk; masked = $info.Masked; tool_present = $info.ToolPresent
            elevated = $info.Elevated; server_timezone = $info.ServerTimeZone; version = [string]$c.Info.Version
        }
        $Out.masked = [bool]$info.Masked
        $Out.server_time_offset_sec = $c.ServerTimeOffsetSec
        Assert-RemoteSuccess $info
        $Out.success = $true
        $Out.message = 'ready'
        return
    }

    # --- 引数 ------------------------------------------------------------------------
    if ($from -notmatch $script:IsoOffsetPattern -or $to -notmatch $script:IsoOffsetPattern) {
        throw 'INVALID_ARGUMENT: -From and -To must be ISO 8601 with an offset (e.g. 2026-10-03T13:49:50+09:00)'
    }
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    if ([DateTimeOffset]::Parse($to, $inv) -le [DateTimeOffset]::Parse($from, $inv)) {
        throw 'INVALID_ARGUMENT: -To must be later than -From'
    }
    $dir = Resolve-OutDir $outDir
    $Out.bundle = $dir
    if (Test-Path -LiteralPath $dir) {
        if (@(Get-ChildItem -LiteralPath $dir -Force).Count -gt 0) {
            throw "OUTPUT_DIR_NOT_EMPTY: $dir (use a new directory for each collection)"
        }
    } else {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $Out.collect_id = $null
    $Out.window = [ordered]@{ from = $from; to = $to; tool_from = $null; tool_to = $null; server_timezone = $null }
    $Out.masked = $false

    $tmpZip = $null
    $artifactId = $null
    $c = $null
    try {
        # --- 収集(渡すのは時間範囲だけ。ツール・出力先・マスクはリモート側の設定で固定) ---------
        $c = Connect-RemoteTarget $cfg $targetName
        $Out.server_time_offset_sec = $c.ServerTimeOffsetSec
        Write-Log "collect start: target=$targetName ($($c.Target.Host)) window=$from .. $to"
        $r = Invoke-Remote $c.Session "Invoke-PmsLogCollect -From '$from' -To '$to'"
        $Out.collect_id = $r.CollectId
        $Out.window.tool_from = $r.ToolFrom
        $Out.window.tool_to = $r.ToolTo
        $Out.window.server_timezone = $r.ServerTimeZone
        Assert-RemoteSuccess $r
        $artifactId = [string]$r.ArtifactId
        if (-not $r.Masked) { throw 'MASK_NOT_CONFIGURED: the remote side did not apply masking' }
        $Out.masked = $true
        Write-Log "collected on $targetName ($($r.DurationSec)s, $($r.ArtifactBytes) bytes). receiving"

        # --- 受け取り・展開 -------------------------------------------------------------
        $tmpZip = Join-Path ([System.IO.Path]::GetTempPath()) "$artifactId.zip"
        Receive-RemoteArtifact $c.Session $artifactId ([int]$r.ChunkCount) ([long]$r.ArtifactBytes) $tmpZip
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($tmpZip, $dir)

        # --- ログIDと件数の一覧 ---------------------------------------------------------
        Set-Summary (Get-BundleSummary $dir $lc)
        $Out.success = $true
        $Out.message = 'collected'
    } finally {
        if ($c -and $artifactId) {
            try { $null = Invoke-Remote $c.Session "Remove-PmsRemoteArtifact -Id '$artifactId'" }
            catch { Write-Log "WARN: cannot remove the artifact on $targetName (removed later by retention): $($_.Exception.Message)" }
        }
        if ($tmpZip -and (Test-Path -LiteralPath $tmpZip)) { Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue }
        if (-not $Out.success -and (Test-Path -LiteralPath $dir)) {
            # 集めかけの一式を残さない(同じディレクトリで再実行できるように。開始時は空だった)
            Get-ChildItem -LiteralPath $dir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Save-CollectResult([string]$json) {
    # logs-collect が成功したら、結果を -OutDir\_collect.json にも残す(logs-ids が使う)
    if ($Out.success -and $Out.command -eq 'logs-collect' -and $Out.Contains('bundle') -and $Out.bundle -and -not $Out.Contains('info')) {
        [System.IO.File]::WriteAllText((Join-Path $Out.bundle $script:ResultFileName), $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    }
}
