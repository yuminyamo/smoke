@{
    RootModule        = 'PmsGoldenRestore.psm1'
    ModuleVersion     = '1.0.0'
    GUID              = '5b2f3c7e-8a41-4d0e-9c6a-2f1e7b9d4a10'
    Author            = 'PMS E2E Automation'
    Description       = 'Restore the PMS test VM to its golden checkpoint (exposed only through the JEA endpoint).'
    PowerShellVersion = '5.1'
    FunctionsToExport = @('Restore-PmsGoldenImage', 'Get-PmsGoldenImageInfo')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
