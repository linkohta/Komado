# Komado

YouTube 視聴専用の Android アプリ（サイドロード前提）。
Brave の考え方（フィルターリストによる広告ブロック + バックグラウンド再生）を Android WebView 上で再現しています。

## 機能

| 機能 | 実装 |
| --- | --- |
| YouTube 専用 | メインフレームは `*.youtube.com` / `youtu.be` と Google ログイン画面のみ。それ以外のリンクは外部ブラウザで開く（`UrlPolicy.kt`） |
| ピクチャーインピクチャー | ホームに戻ると自動で PiP（Android 12+ は自動遷移、11 以下は `onUserLeaveHint`）。PiP 中は動画だけを表示し、10秒戻る / 再生・一時停止 / 10秒進む ボタン付き |
| 広告ブロック | EasyList + EasyPrivacy（4日ごとに自動更新）のネットワーク・要素非表示ルール（`AdBlocker.kt`）と、プレイヤー応答から広告データを取り除くスクリプト（`assets/inject.js`） |
| バックグラウンド再生 | 画面オフ・他アプリ使用中も再生継続。通知 / ロック画面 / Bluetooth から操作可能（`PlaybackService.kt`） |
| Google ログイン | WebView 特有の UA と `X-Requested-With` ヘッダーを取り除いてログイン画面を通す |
| SponsorBlock | スポンサー・自己宣伝・高評価のお願い区間を自動スキップ。動画 ID のハッシュ先頭 4 文字だけを送信 |
| リンク共有 | YouTube アプリ等の「共有」→ Komado で開ける |
| ライブチャットの弾幕 | ライブ配信・アーカイブのコメントをニコニコ動画風に動画上へ流す（全画面・PiP 中も）。プレイヤー下のバーで ON/OFF と投稿（配信中のみ）ができる（`assets/livechat.js`） |

## ビルド

Android Studio でこのフォルダを開いて実行するか、次のコマンドで APK を作成します。

```bash
./gradlew assembleRelease
```

`app/build/outputs/apk/release/app-release.apk` を端末にインストールしてください（debug 鍵で署名済み）。

## 構成

```
app/src/main/
├── java/io/github/linkohta/komado/
│   ├── MainActivity.kt         WebView の設定・JS ブリッジ・ライフサイクル
│   ├── ScriptInjector.kt       inject.js / livechat.js の注入とページ API の呼び出し
│   ├── FullscreenController.kt HTML5 全画面の表示・解除
│   ├── PipController.kt        PiP パラメータの組み立て
│   ├── BackgroundWebView.kt    非表示時も「表示中」として振る舞う WebView
│   ├── YouTubeWebViewClient.kt ドメイン制限・広告リクエストの遮断
│   ├── AdBlocker.kt            フィルターリストの取得・キャッシュ・照合
│   ├── FilterParser.kt         Adblock Plus 形式の解析
│   ├── FilterRules.kt          解析済みルールと保護リスト
│   ├── PlaybackService.kt      フォアグラウンドサービス・MediaSession・通知
│   ├── PlaybackHub.kt          Activity と通知 / PiP 間の状態共有
│   ├── PlaybackState.kt        再生状態とコマンドの型
│   ├── ControlReceiver.kt      通知・PiP ボタンの受信
│   ├── SponsorBlockClient.kt   SponsorBlock API
│   ├── LicensesActivity.kt     ライセンスとクレジット画面
│   ├── UrlPolicy.kt            表示を許可する URL
│   ├── EdgeToEdge.kt           システムバー周りの共通処理
│   └── Http.kt                 HttpURLConnection の定型
└── assets/
    ├── inject.js               YouTube ページに注入するスクリプト
    ├── livechat.js             ライブチャットの取得・弾幕表示・投稿
    ├── filters.txt             同梱フィルター
    └── licenses.html           アプリ内のライセンス表示
```

## 注意・制限

- YouTube の利用規約上グレーな機能（広告ブロック・バックグラウンド再生）を含むため、Google Play では公開できません。
- YouTube 側の仕様変更で広告ブロックや PiP 中の再生継続が効かなくなることがあります。主に `assets/inject.js` を修正します。
- ライブチャットは YouTube の内部 API（`/youtubei/v1/next`・`live_chat/get_live_chat`・`live_chat/get_live_chat_replay`・`live_chat/send_message`）を WebView 内から呼んで実現しているため、仕様変更で動かなくなることがあります。`assets/livechat.js` を修正します。投稿にはログインが必要です。
  - 例: YouTube はウィンドウ面積が画面に比べて小さいと PiP とみなし、Premium 以外では一時停止します。`window.outerWidth/outerHeight` を偽装して回避しています。
- Google が WebView からのログインを検出した場合はログインできません（その場合は未ログインで利用）。
- 再生を止めて通知を閉じるまでは、バックグラウンドでもページが動き続けます（電池消費のため、使い終わったら通知の ✕ で閉じてください）。

## ライセンス

Komado は [Apache License 2.0](LICENSE) で公開しています。第三者のソフトウェア・素材の表記は [NOTICE](NOTICE) を参照してください。
アプリ内では、ランチャーアイコンを長押しして「ライセンス」を選ぶと同じ内容を確認できます。

## クレジット

| 対象 | 提供元 | ライセンス |
| --- | --- | --- |
| AndroidX / Kotlin / kotlinx.coroutines ほか依存ライブラリ | The Android Open Source Project, JetBrains ほか | Apache License 2.0 |
| 通知・PiP・ショートカットのアイコン | [Material Icons](https://github.com/google/material-design-icons) by Google | Apache License 2.0 |
| アプリアイコン | 本プロジェクトのオリジナル | Apache License 2.0 |
| EasyList / EasyPrivacy（実行時にダウンロード、同梱なし） | [The EasyList authors](https://easylist.to/) | GPL v3 / CC BY-SA 3.0 |
| SponsorBlock のスキップ区間データ | [SponsorBlock](https://sponsor.ajay.app/)（Ajay Ramachandran and contributors） | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |

広告ブロックの考え方は [Brave](https://brave.com/) と [uBlock Origin](https://github.com/gorhill/uBlock) を参考にしています（ソースコードは使用していません）。

## 商標

YouTube および Google は Google LLC の商標です。Brave は Brave Software, Inc. の商標です。
本プロジェクトは Google LLC、YouTube、Brave Software, Inc. とは関係がなく、これらの企業による承認・推奨を受けたものではありません。
