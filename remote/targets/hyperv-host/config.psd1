# リモート側の設定の原本: Hyper-V ホスト(接続先名 hyperv-host。docs/003 F-3・F-4)
# CLI の deploy が %ProgramData%\PmsRemote\config.psd1 として配置する(既存は -Force なしでは上書きしない)。
# AI・クライアントからは変えられない。値を変えたら、人間がレビューしてから deploy -Force する。
@{
    # ゴールデンイメージの復元(ロール HyperVRead / HyperVChange)
    Restore = @{
        VMName           = 'PMS-TEST-01'   # 復元する VM(この値で固定。呼び出し側は指定できない)
        CheckpointName   = 'golden'        # 戻す先のチェックポイント(同名がちょうど1つあること)
        StopTimeoutSec   = 120             # 電源断(TurnOff)後に Off になるまでの上限
        BootTimeoutSec   = 900             # 起動後、ハートビートが OK になるまでの上限
        PollIntervalSec  = 5               # 状態確認の間隔
        RequireHeartbeat = $true           # ゲストの統合サービス(ハートビート)を無効にしている場合は $false
    }
}
