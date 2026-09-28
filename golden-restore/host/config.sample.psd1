@{
    # 復元対象(ここで固定する。クライアントからは変更できない)
    VMName           = 'PMS-TEST-01'
    CheckpointName   = 'golden'

    # 待機の上限と確認間隔(秒)
    StopTimeoutSec   = 120
    BootTimeoutSec   = 900
    PollIntervalSec  = 5

    # ゲストの統合サービス(ハートビート)を無効化している場合は $false
    RequireHeartbeat = $true
}
