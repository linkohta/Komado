package io.github.linkohta.komado

import android.content.Context
import android.view.View
import android.webkit.WebView

/**
 * 画面オフやバックグラウンドでも「表示中」として振る舞う WebView。
 *
 * 通常の WebView はウィンドウが非表示になるとページを hidden 扱いにし、
 * Chromium が音声付き動画を自動で一時停止してしまう（Chrome for Android と同じ挙動）。
 * Brave は Chromium 本体のパッチで回避しているが、WebView ではここで可視状態を固定する。
 */
class BackgroundWebView(context: Context) : WebView(context) {

    /** false にすると通常の WebView と同じく非表示時に停止する */
    var keepAlive = true

    override fun onWindowVisibilityChanged(visibility: Int) {
        // Activity が停止するとウィンドウは GONE になるので、それも含めて VISIBLE に置き換える
        super.onWindowVisibilityChanged(if (keepAlive) View.VISIBLE else visibility)
    }
}
