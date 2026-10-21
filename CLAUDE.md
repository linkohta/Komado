# Komado

YouTube 視聴専用の Android アプリ（サイドロード前提、Google Play 非公開）。
Android WebView で m.youtube.com を表示し、Brave の考え方（フィルターリストによる広告ブロック + バックグラウンド再生）を再現する。
機能一覧・注意点・ライセンスは [README.md](README.md) を正とし、ここでは「コードを触るときに知っておくこと」だけを書く。

## 技術スタック

- Kotlin / Android (minSdk 26, targetSdk 36, JDK 17)、Gradle Kotlin DSL、単一モジュール `:app`
- UI は XML レイアウトなし。`MainActivity` が `FrameLayout` + `WebView` をコードで組む
- ページ側のロジックは `web/`（TypeScript）。ビルド時に esbuild で `komado.js` 1 本（IIFE、target chrome87）にまとめ、生成アセットとして APK に入れる。ビルドには Node.js が必要
- 外部ライブラリは AndroidX と kotlinx.coroutines のみ。HTTP は `HttpURLConnection`、JSON は `org.json`

## 構成と責務

```
app/src/main/java/io/github/linkohta/komado/   （パッケージは 1 階層のまま。サブパッケージに分けるほどの規模ではない）
  MainActivity.kt          WebView の設定、JS ブリッジの振り分け、ライフサイクル。画面は 1 つだけ
  ScriptInjector.kt        komado.js の document-start 注入と window.__komado の呼び出し
  FullscreenController.kt  HTML5 全画面（onShowCustomView）の表示・解除・向き固定
  PipController.kt         PiP パラメータ（アスペクト比・ボタン・自動遷移）の組み立てと間引き
  BackgroundWebView.kt     非表示でも「表示中」として振る舞う WebView
  YouTubeWebViewClient.kt  メインフレームのドメイン制限、サブリソースの広告遮断
  UrlPolicy.kt             アプリ内で表示してよい URL、共有リンクの正規化
  AdBlocker.kt             フィルターリストの取得・キャッシュ・照合の入口
  FilterParser.kt          Adblock Plus 形式 → FilterRules（純粋関数。ユニットテストあり）
  FilterRules.kt           解析済みルールと照合、再生を壊さないための保護リスト
  SponsorBlockClient.kt    SponsorBlock API（k-匿名性ハッシュ）
  PlaybackState.kt         ページから届く再生状態と、ページへ送るコマンドの型
  PlaybackHub.kt           Activity ↔ Service ↔ Receiver をつなぐプロセス内のハブ（メインスレッド専用）
  PlaybackService.kt       フォアグラウンドサービス・MediaSession・通知・WakeLock
  ControlReceiver.kt       通知・PiP ボタンの BroadcastReceiver
  LicensesActivity.kt      ライセンス表示
  EdgeToEdge.kt            透明システムバーとインセット padding の共通ヘルパー
  Http.kt                  HttpURLConnection の接続・切断の定型
app/src/main/assets/
  filters.txt              同梱フィルター（最小限。EasyList 等は実行時にダウンロード）
app/src/test/                FilterParser のユニットテスト（RealFilterListTest は環境変数があるときだけ走る）
web/                         ページに注入するスクリプト（TypeScript）。app/build.gradle.kts の bundle*WebScripts が
                             npm run build を呼び、app/build/generated/assets/ に komado.js を出す（リポジトリには入れない）
  src/main.ts              入口。二重注入と iframe を止め、各機能の install*() を呼ぶ
  src/global.d.ts          window に生えるもの（アプリが付ける __KOMADO_CSS・公開 API・ytcfg など）の型
  src/bridge.ts            アプリへのメッセージ（KomadoBridge）。型は Kotlin 側の読み取りと揃える
  src/page.ts              現在の <video> と動画 ID
  src/json-hook.ts         JSON.parse / Response.json / ytInitialPlayerResponse の横取り（リスナー登録式）
  src/adblock.ts           広告データの除去（json-prune 相当）と広告スキップ
  src/background.ts        非表示の偽装・自動ミュート解除
  src/styles.ts            要素非表示フィルターと PiP 中の CSS
  src/playback.ts          再生状態の通知（report）とアプリからの操作（control）
  src/sponsorblock.ts      SponsorBlock の区間スキップ
  src/livechat/index.ts    ライブチャットの制御（動画の切り替え検知・セッションの開始／再試行・投稿）
  src/livechat/live.ts     配信中: get_live_chat のポーリング
  src/livechat/replay.ts   アーカイブ: 再生位置に合わせた get_live_chat_replay の先読み
  src/livechat/danmaku.ts  弾幕の描画
  src/livechat/bar.ts      入力バー
  src/livechat/session.ts  セッション（動画 1 本ぶんのチャット）の状態
  src/livechat/innertube.ts  InnerTube API の呼び出しと認証ヘッダー
  src/livechat/continuation.ts  継続トークンの書き換え（protobuf）
  src/livechat/renderers.ts  応答 → コメントの変換（純粋関数）
  src/livechat/types.ts    InnerTube 応答の型（読むフィールドだけ。すべて省略可能）
  test/*.test.mjs          純粋関数のユニットテスト（node --test。DOM に触れるものは対象外）
```

### データの流れ

1. `ScriptInjector` が `window.__KOMADO_CSS=[...]` + komado.js を YouTube オリジンに document-start で注入する
2. playback.ts が `<video>` の状態を `KomadoBridge.postMessage({type:'state',...})` で送る → `MainActivity.onBridgeMessage` → `PlaybackHub.update`
3. `PlaybackService` と `PipController` は `PlaybackHub` の状態を見て通知・PiP を更新する
4. 通知 / PiP / MediaSession の操作は `PlayerCommand` として `PlaybackHub.send` → `MainActivity.runCommand` → `window.__komado.control(...)`
5. ライブチャットは json-hook.ts の `onJson` でプレイヤー応答を見てライブかどうかを判定する。広告除去のリスナーが先に登録されるので、後続のリスナーには広告抜きの値が渡る

## ビルドと検証

```bash
./gradlew :app:compileDebugKotlin :app:testDebugUnitTest --offline   # 変更後は必ず通す
./gradlew assembleRelease                                            # APK（debug 鍵で署名）
cd web && npm test                                                   # TypeScript の純粋関数のテスト
cd web && npm run check                                              # 型検査だけ（Gradle のビルドでも毎回走る）
```

- `gradle.properties` の `android.*` フラグは AGP 9 向けの互換設定。意味が分からないものは触らない
- 端末での動作（PiP、バックグラウンド再生、ライブチャット）はユニットテストで担保できない。該当箇所を触ったら README の機能表に沿って実機確認する

## リファクタリング方針

このプロジェクトは個人用の小さなアプリで、壊れやすいのは「YouTube 側の仕様変更」と「Android のバックグラウンド制限」。
リファクタリングは **振る舞いを変えずに、仕様変更時に直す場所を見つけやすくする** ことを目的とし、次の順で優先する。

1. **責務ごとに 1 ファイル**。`MainActivity` は WebView の設定とメッセージの振り分けだけを持ち、全画面・PiP・注入のような独立した関心事はコントローラクラスに出す。1 ファイルに複数のトップレベルクラスを置かない（`FilterRules` / `FilterParser` を分けたのはこのため）
2. **重複は共通化するが、抽象化は最小限**。両 Activity で同じインセット処理、2 つのクライアントで同じ `HttpURLConnection` 定型、2 つの機能で同じ `JSON.parse` フック、といった「同じコードが 2 か所」になった時点で共通化する。1 か所しか使わないものに汎用レイヤーを作らない
3. **パッケージは 1 階層を維持**。15 ファイル程度ではサブパッケージの利点より、Manifest の `.MainActivity` 参照やテストの移動コストのほうが大きい。30 ファイルを超えるようなら `adblock` / `playback` / `web` に分けることを検討する
4. **ページ側の API 面を小さく保つ**。アプリから呼ぶのは `window.__komado.{control,setPip,addSelectors,setSegments}` だけ（型は global.d.ts の KomadoApi）。モジュール間の共有は import で行い、window に新しいグローバルを生やさない（`__komadoLive` は DevTools 用のデバッグ口）
5. **YouTube 依存の値は定数にして上に集める**。InnerTube のクライアントバージョン、セレクタ、継続トークンのフィールド番号などは各ファイル先頭の定数か専用セクションに置き、ロジックに埋め込まない
6. **ライブラリを足さない**。OkHttp / Moshi / Compose などを入れると APK サイズと更新追従の手間が増える。標準 API で十分な範囲に留める
7. **TypeScript のモジュールはトップレベルで副作用を起こさない**。フック・イベント登録・タイマーは `install*()` の中で行い、main.ts の二重注入ガードの後に呼ぶ。Node のテストからそのまま import できる状態を保つ
8. **YouTube の応答は信用しない型で受ける**。types.ts のフィールドはすべて省略可能にし、`find()` で探したものは呼び出し側で型を付ける。`any` は使わない。tsconfig は strict と erasableSyntaxOnly（enum・namespace・引数プロパティを使わない）
9. **コメントは「なぜ」を書く**。YouTube や Android の挙動への回避策には、何を回避しているかを必ず残す（例: `webView.onPause()` を呼ばない理由）

### やらないこと

- 動作仕様の変更（挙動を変える修正はリファクタリングと別コミットにする）
- Kotlin 側での YouTube 応答の解釈（ページ側スクリプトに閉じる。Kotlin は URL と再生状態しか知らない）
- 生成物（komado.js）のコミット。生成は必ずビルド時に行う
- WebView 以外の再生手段（ExoPlayer 等）への置き換え

## コミット

- メッセージは日本語。1 行目に変更の要約、本文に理由。振る舞いの変更とリファクタリングは分ける
- `master` に直接コミットせず、ブランチを切って PR を作る
