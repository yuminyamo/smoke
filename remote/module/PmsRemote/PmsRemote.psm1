<#
  PmsRemote — 回帰テスト用のリモートコマンドセット(全マシン共通の1パッケージ)
  JEA エンドポイント PmsRemote 経由でのみ呼ばれる想定。どの関数が見えるかは、そのマシンに登録したロール
  (RoleCapabilities\*.psrc)で決まる。整備方針: docs/003_リモートコマンド整備方針.html(第1部)

  ファイル:
    Common.ps1  全マシン・全ロール共通(設定・ロック・記録・成果物・版)
    HyperV.ps1  Hyper-V ホスト(HyperVRead / HyperVChange)
    Server.ps1  PMS サーバーVM(ServerRead / ServerChange)
    Client.ps1  印刷クライアントPC(ClientRead / ClientChange)

  窓口(JEA)の中で使えるコマンドの制約(Windows PowerShell 5.1。ふつうの PowerShell では動くので気付きにくい):
    - モジュールの自動読み込みが効かない。基本のスナップイン(Core・Management・Utility・Security)以外の
      コマンド(Hyper-V・LocalAccounts・ScheduledTasks・Archive など)は、使うロールの .psrc の ModulesToImport に足す
    - Utility のうちスクリプト関数で書かれたもの(Get-FileHash・Import-PowerShellDataFile・New-Guid・Format-Hex・
      New-TemporaryFile など)は使えない。ModulesToImport に足しても読み込まれない。.NET で書く(Common.ps1 の
      Get-PmsFileSha256・Get-PmsConfig を参照)
    - 確かめ方: 関数を足したら、その関数を窓口経由(CLI)で一度呼ぶ。ローカルで Import-Module して動くだけでは足りない
#>
Set-StrictMode -Version Latest

foreach ($file in @('Common.ps1', 'HyperV.ps1', 'Server.ps1', 'Client.ps1')) {
    . (Join-Path $PSScriptRoot $file)
}

Export-ModuleMember -Function @(
    # 共通(全ロール)
    'Get-PmsRemoteInfo', 'Read-PmsRemoteArtifact', 'Remove-PmsRemoteArtifact',
    # HyperVRead / HyperVChange
    'Get-PmsGoldenImageInfo', 'Restore-PmsGoldenImage',
    # ServerRead
    'Invoke-PmsLogCollect', 'Get-PmsLogCollectInfo',
    # インストーラ用(ロールでは見せない)
    'Initialize-PmsHyperV', 'Initialize-PmsServer', 'Get-PmsDirectoryHash'
)
