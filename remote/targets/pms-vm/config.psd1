# リモート側の設定の原本: PMS サーバーVM(接続先名 pms-vm。docs/003 F-3・F-4)
# PMS VM は復元のたびにこの設定ごと配置し直される(docs/003 5.3)。
# AI・クライアントからは変えられない。値を変えたら、人間がレビューする。
@{
    # ログ収集(ロール ServerRead。SK-LOG)。クライアントが渡せるのは時間範囲だけ
    LogCollect = @{
        # 製品のログ収集ツールのパス(このマシン上)
        ExePath          = 'C:\PMS\tools\LogCollector.exe'
        # 引数。{From} {To} は時間範囲(TimeZone・TimeFormat で直した値)、{OutDir} は出力先
        # (WorkRoot\<収集ID>\bundle)に置き換わる。{Mask} の位置にマスクの指定が入る(なければ末尾)
        Arguments        = @('-from', '{From}', '-to', '{To}', '-out', '{OutDir}', '{Mask}')
        # マスクの指定。空にするとログ収集は必ず失敗する(マスクせずに集めない)
        MaskArguments    = @('-mask')
        # 出力先の親フォルダ。収集IDごとにフォルダを作り、成功したら消す(失敗時は調査用に残す。復元で消える)
        WorkRoot         = 'C:\PmsRemote\work\logs'
        # ツールに渡す時刻。GuestLocal(このマシンの現地時刻に直す)/ Utc / AsGiven(渡された時差のまま)
        TimeZone         = 'GuestLocal'
        TimeFormat       = 'yyyy-MM-ddTHH:mm:sszzz'
        # ツールの正常終了とみなす終了コード。ツールの仕様が分かったらここを直す
        SuccessExitCodes = @(0)
        # 上限
        TimeoutSec       = 300
        MaxWindowMinutes = 180
        MaxArtifactMB    = 200
        # 成功後も作業フォルダを残すか
        KeepWorkOutput   = $false
    }
}
