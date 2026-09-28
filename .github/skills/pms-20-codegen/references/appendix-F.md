# 付録F: Playwright コード規約

作業20が参照する。他作業には渡さない。

## 構造とID突合

- **1シナリオ = 1 `test()`、各ステップ = `test.step()`**
- 全テストにシナリオIDを tag として付与する。これがIDとコードの突合キーである
- **全テストに生成元の注釈 `generated-by`(生成したフローIDと手順版)を付ける。** 回帰実行の失敗を切り分ける人(将来はAI)が、生成したフローと手順版へ遡れるようにするため(00 ■手順改善シグナル)。再探索フローや作業20の再実行で作り直したテストは、注釈を更新する

```typescript
test('印刷ジョブの投入と実行結果の確認 [SC-PRT-01]',
  {
    tag: ['@SC-PRT-01', '@PRT', '@external', '@serial-DEV'],
    annotation: { type: 'generated-by', description: 'F-002 / proc-v001' },
  },
  async ({ page, userLogin }) => {
    await test.step('S1: 印刷ジョブの投入 [SC-PRT-01-S1]', async () => { ... });
  });
```

- **1つのシナリオIDは、コード全体でちょうど1つの test にのみ付与する。** 1つの test に複数のシナリオIDを相乗りさせることも禁止
- ステップIDは `test.step()` のタイトルに `[SC-PRT-01-S1]` の形式で含める
- テストタイトルはシナリオ名を使い、末尾に `[シナリオID]` を付ける

> Playwright の tag・annotation 機能(test の詳細オブジェクト)は v1.42 以降。バージョンが古い場合はタイトル内 `[SC-...]` を grep する運用に切り替え、一意性検証は同様に行う。生成元はテスト本体の先頭に `// generated-by: F-002 / proc-v001` のコメントで残す。

## 前提状態(requires)の実装

- `requires` の各状態は、**作業10フェーズAで整備されたセットアップで充足する。作業20でセットアップを新規に発明しない**
- テスト本文の中でログイン操作等を毎回行わない(その操作自体が検証対象であるステップを除く)
- セットアップが未整備の状態を要するシナリオは、コード化せず「コード化不能・要差し戻し」として報告する
- `setup-log` で `verified: false` のセットアップは、実行確認で最初に単体実行し established check が通ることを確認してからテスト生成に使う
- **セットアップから他のテスト項目を呼んではならない**
- ログイン系状態は storageState を用いた setup project で実装してよい

## アサーション

- `assertion_hint` に基づき、web-first assertion で実装する。値を取り出してからの同期比較よりロケータベースの expect を優先する(自動リトライを効かせるため)
- **`verification` が `両方` のステップでは、画面アサーションとDBアサーションの両方を実装する。片方を省略しない**
- **`verification` が `DB` 単独のステップでは、コメントで理由を残す**

```typescript
// DB-ONLY: 内部処理の完了状態は画面に露出しないため
await expect.poll(() => queryJobStatus(jobId)).toBe('Completed');
```

- 値の比較強度は**非決定値カタログに従う**(実装方針は `vocab.strength` の `impl`)。カタログの強度を無視して完全一致を書いてはならないし、安定させたいという理由で強度を勝手に下げてもならない
- 期待結果の業務的意味を検証する。UI文言への厳密一致は `[厳密一致]` 指定のステップのみ

## 非同期待機

- **固定待機は禁止。** 00のポーリング契約に従い `tests/helpers/waitFor.ts` の `waitUntil()` を使う
- タイムアウト値は**作業10の `wait.measured_seconds` をもとに設定する**(実測値の3倍程度)。根拠をコメントで残す

```typescript
// 実測 42秒 (SC-PRT-01-S3)。余裕を見て 180秒
await waitUntil(() => jobIsCompleted(jobId), { timeout: 180_000 });
```

- 作業10の記録にない待機を追加する必要が生じた場合、逸脱としてコメントと報告書の両方に記録する
- 待機条件・タイムアウト値は、作業10の記録と `kb/async/`(T06)の双方を確認する。**両者が食い違う場合は作業10の実測を優先し、KBを訂正する**

## DB不変条件

00の2段構え設計に従って実装する。

```typescript
// シナリオ末尾: 自シナリオのデータにスコープした検査
test.afterEach(async ({}, testInfo) => {
  await waitForBillingQuiescence(ctx.jobIds);          // 非同期書き込みの完了を待つ
  await assertInvariantsScoped(ctx, ['INV-001', 'INV-002', 'INV-003', 'INV-004', 'INV-005']);
});

// globalTeardown: スイート終端でDB全体を1回検査
export default async function globalTeardown() {
  await assertInvariantsGlobal(['INV-001', 'INV-002', 'INV-003', 'INV-004', 'INV-005']);
}
```

- **グローバルなDBスキャンを `afterEach` に書いてはならない**
- 実装は `tests/helpers/invariants.ts` に集約し、シナリオごとに書き分けない
- 不変条件の違反は、シナリオ本体のアサーションとは**区別可能な形で失敗させる**(失敗メッセージに `INVARIANT` を含める等)

## 環境情報

- **接続先・アカウント・パスワードなどの環境情報をコードに直接書かない。** `tests/helpers/env.ts` の `envValue('<キー>')` で読む(00 ■検証環境の情報。lint `env_value_leak` / `env_value_hardcoded`)。探索記録の `<env:キー>` は `envValue('<キー>')` に置き換える
- `envValue` は `tools/env/env.mjs get` を呼ぶだけにする(環境の選び方・各自の設定による上書きを1か所で決めるため)。使う環境は環境変数 `PMS_ENV` で切り替える(未指定なら設定の既定)。値がないときは例外で失敗させる(黙って空文字で進めない)
- `playwright.config.ts` の `baseURL` も `envValue('pms.url')` から取る

```typescript
// tests/helpers/env.ts — 検証環境の情報を読む(00 ■検証環境の情報)。値は config/environments*.json にあり、コードには書かない
import { execFileSync } from 'node:child_process';

const cache = new Map<string, string>();
export function envValue(key: string): string {
  if (!cache.has(key)) {
    // 値がなければ env.mjs が終了コード1で終わり、execFileSync が例外を投げる(テストは失敗する)
    const out = execFileSync(process.execPath, ['tools/env/env.mjs', 'get', key, '--reveal'], { encoding: 'utf8' });
    cache.set(key, out.replace(/\r?\n$/, ''));
  }
  return cache.get(key)!;
}
```

## 外部操作

- `tests/external/` のラッパ経由で呼ぶ。KB T05 の操作IDと1対1に対応させる
- 実行体に渡す機器のホスト・IP・アカウントは、KB T05 の「使う環境情報のキー」を `envValue` で読んで渡す(ラッパに値を書かない)
- **ラッパは skill 同梱の実行体を、KB T05 に記録された呼び出し方で呼ぶだけにする。** テスト実行時に skill の説明文を読んだり、AIに判断させたりしない。実行体の成否(終了コード等)はラッパの中で確認し、失敗時はテストを失敗させる
- **KB T05 に未登録の操作をコードに書かない**(作業10への差し戻し候補として報告する)
- **禁止操作リストの `禁止` / `要許可` に該当する操作をコードに書かない。** `条件付き許可` の操作は制約値を満たすことをコード上で確認できる形にし、制約の根拠を該当行IDとともにコメントに残す
- **外部操作を含むテストには `@external` タグを付ける**(含まないテストと分離し、実行時間を分けて計測するため)
- **直列化は操作対象ごとに決める。** 禁止操作リストの「同時実行の可否」が不可の操作対象を使うテストには `@serial-<対象略号>`(操作IDの対象略号。例 `@serial-DEV`)を付け、そのタグの Playwright project を `workers: 1` にする。同時実行できる操作対象(例: テスト用OU内のAD操作)まで直列化しない。操作対象の共有に起因する直列化は構成であり、後述の `serial` 最終手段ルールの対象外

## ロケータとページオブジェクト

- ロケータは原則ページオブジェクト経由で参照する。不足があれば追加してよいが、**追加分は作業10の探索記録(`actions[].locator`)に根拠があるものに限る**
- 2つ以上のテストが同じ操作列を使う場合、シナリオ部品経由で呼ぶ。テスト内で操作列を複製しない
- FRAGILE(CSS暫定)ロケータをそのまま使う場合、`// FRAGILE:` コメントを引き継ぐ

## 並列実行・再実行耐性とデータ分離

- **ゴールデンイメージ復元は回帰テストセットの実行開始前に1回のみ。** 環境がクリーンであることに依存したアサーション(全体件数等)を書いてはならない
- **テストが前提とするデータ・設定は、すべてテストコード(fixture・シナリオ部品・テスト本体)が作る。** ゴールデンイメージにないもの(探索時に作られて環境に残っていたデータ、手作業で作ったデータ)に依存しない。依存していると、復元のあとの回帰実行で失敗する
- 復元は `tests/global-setup.ts` が環境変数 `PMS_RESTORE=1` のときだけ行う。**globalSetup を書き換えて復元を既定にしない。テスト本体・fixture・`afterAll` から復元を呼ばない**
- 起動確認テスト(`tests/readiness/`)は setup project `readiness` とし、**全 project の `dependencies` に `readiness` を入れる**。ほかの project の対象から `tests/readiness/` を外す
- 各テストは**復元なしの再実行に耐えること**。作成データは一意化し、アサーションは自テストのデータにスコープする
- シナリオ間の並列実行を前提に書く
- 共有データ(設定・ポリシー等、一意化で分離できないもの)を変更するシナリオには専用のテストデータを割り当てる。割り当てられない場合はコード化せず報告書に記載する
- `test.describe.configure({ mode: 'serial' })` は最終手段とし、使う場合は理由を注記する
