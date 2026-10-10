@{
    RootModule        = 'PmsRemote.psm1'
    # 版(docs/003 5.4): パッチ = 関数の中身の修正 / マイナー = 関数・ロール・設定キーの追加 / メジャー = 互換を壊す変更
    # 上げたら config/remote-targets.json の expectedVersion も合わせる
    ModuleVersion     = '1.0.1'
    GUID              = '3f6b2a91-7c4e-4d8a-9b1f-5e2c7a0d4b63'
    Author            = 'PMS E2E Automation'
    Description       = 'Remote command set for PMS regression testing (exposed only through the JEA endpoint PmsRemote).'
    PowerShellVersion = '5.1'
    FunctionsToExport = @(
        'Get-PmsRemoteInfo', 'Read-PmsRemoteArtifact', 'Remove-PmsRemoteArtifact',
        'Get-PmsGoldenImageInfo', 'Restore-PmsGoldenImage',
        'Invoke-PmsLogCollect', 'Get-PmsLogCollectInfo',
        'Initialize-PmsHyperV', 'Initialize-PmsServer', 'Get-PmsDirectoryHash'
    )
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
