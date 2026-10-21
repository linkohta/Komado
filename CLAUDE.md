# Komado

YouTube 視聴専用の Android アプリ（サイドロード前提、Google Play 非公開）。
Android WebView で m.youtube.com を表示し、Brave の考え方（フィルターリストによる広告ブロック + バックグラウンド再生）を再現する。
機能一覧・注意点・ライセンスは [README.md](README.md) を正とし、ここでは「コードを触るときに知っておくこと」だけを書く。

## 技術スタック

- Kotlin / Android (minSdk 26, targetSdk 36, JDK 17)、Gradle Kotlin DSL、単一モジュール `:app`
- UI は XML レイアウトなし。`MainActivity` が `FrameLayout` + `WebView` をコードで組む
- ページ側のロジックは `app/src/main/assets/*.js`（ES5 相当。document-start で注入されるため、古い WebView でも動く構文に留める）
- 外部ライブラリは AndroidX と kotlinx.coroutines のみ。HTTP は `HttpURLConnection`、JSON は `org.json`

## 構成と責務

```
app/src/main/java/io/github/linkohta/komado/   （パッケージは 1 階層のまま。サブパッケージに分けるほどの規模ではない）
  MainActivity.kt          WebView の設定、JS ブリッジの振り分け、ライフサイクル。画面は 1 つだけ
  ScriptInjector.kt        inject.js + livechat.js の document-start 注入と window.__komado の呼び出し
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
  inject.js                広告除去・バックグラウンド再生・PiP 表示・状態通知・SponsorBlock
  livechat.js              ライブチャットの取得・弾幕描画・投稿バー（inject.js の後ろに連結）
  filters.txt              同梱フィルター（最小限。EasyList 等は実行時にダウンロード）
app/src/test/                FilterParser のユニットテスト（RealFilterListTest は環境変数があるときだけ走る）
```

### データの流れ

1. `ScriptInjector` が `window.__KOMADO_CSS=[...]` + inject.js + livechat.js を YouTube オリジンに document-start で注入する
2. inject.js が `<video>` の状態を `KomadoBridge.postMessage({type:'state',...})` で送る → `MainActivity.onBridgeMessage` → `PlaybackHub.update`
3. `PlaybackService` と `PipController` は `PlaybackHub` の状態を見て通知・PiP を更新する
4. 通知 / PiP / MediaSession の操作は `PlayerCommand` として `PlaybackHub.send` → `MainActivity.runCommand` → `window.__komado.control(...)`
5. livechat.js は inject.js の `window.__komado`（`onJson` / `video` / `videoId`）に依存する。連結順を変えない

## ビルドと検証

```bash
./gradlew :app:compileDebugKotlin :app:testDebugUnitTest --offline   # 変更後は必ず通す
./gradlew assembleRelease                                            # APK（debug 鍵で署名）
node --check app/src/main/assets/inject.js app/src/main/assets/livechat.js   # JS の構文だけ確認
```

- `gradle.properties` の `android.*` フラグは AGP 9 向けの互換設定。意味が分からないものは触らない
- 端末での動作（PiP、バックグラウンド再生、ライブチャット）はユニットテストで担保できない。該当箇所を触ったら README の機能表に沿って実機確認する

## リファクタリング方針

このプロジェクトは個人用の小さなアプリで、壊れやすいのは「YouTube 側の仕様変更」と「Android のバックグラウンド制限」。
リファクタリングは **振る舞いを変えずに、仕様変更時に直す場所を見つけやすくする** ことを目的とし、次の順で優先する。

1. **責務ごとに 1 ファイル**。`MainActivity` は WebView の設定とメッセージの振り分けだけを持ち、全画面・PiP・注入のような独立した関心事はコントローラクラスに出す。1 ファイルに複数のトップレベルクラスを置かない（`FilterRules` / `FilterParser` を分けたのはこのため）
2. **重複は共通化するが、抽象化は最小限**。両 Activity で同じインセット処理、2 つのクライアントで同じ `HttpURLConnection` 定型、2 つの JS で同じ `JSON.parse` フック、といった「同じコードが 2 か所」になった時点で共通化する。1 か所しか使わないものに汎用レイヤーを作らない
3. **パッケージは 1 階層を維持**。15 ファイル程度ではサブパッケージの利点より、Manifest の `.MainActivity` 参照やテストの移動コストのほうが大きい。30 ファイルを超えるようなら `adblock` / `playback` / `web` に分けることを検討する
4. **JS はページ側の API 面を小さく保つ**。アプリから呼ぶのは `window.__komado.{control,setPip,addSelectors,setSegments}` だけ。livechat.js が inject.js に求めるのは `onJson` / `video` / `videoId` だけ。これ以外の相互参照を増やさない
5. **YouTube 依存の値は定数にして上に集める**。InnerTube のクライアントバージョン、セレクタ、継続トークンのフィールド番号などは各ファイル先頭の定数か専用セクションに置き、ロジックに埋め込まない
6. **ライブラリを足さない**。OkHttp / Moshi / Compose などを入れると APK サイズと更新追従の手間が増える。標準 API で十分な範囲に留める
7. **コメントは「なぜ」を書く**。YouTube や Android の挙動への回避策には、何を回避しているかを必ず残す（例: `webView.onPause()` を呼ばない理由）

### やらないこと

- 動作仕様の変更（挙動を変える修正はリファクタリングと別コミットにする）
- Kotlin 側での YouTube 応答の解釈（ページ側 JS に閉じる。Kotlin は URL と再生状態しか知らない）
- WebView 以外の再生手段（ExoPlayer 等）への置き換え

## コミット

- メッセージは日本語。1 行目に変更の要約、本文に理由。振る舞いの変更とリファクタリングは分ける
- `master` に直接コミットせず、ブランチを切って PR を作る
