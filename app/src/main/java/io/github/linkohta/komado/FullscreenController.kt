package io.github.linkohta.komado

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible

/**
 * HTML5 の全画面（WebChromeClient.onShowCustomView）を受け持つ。
 * 全画面ビューを [container] に載せ、システムバーを隠し、横長の動画なら横向きに固定する。
 */
class FullscreenController(private val activity: Activity, private val container: FrameLayout) {

    private var customView: View? = null
    private var callback: WebChromeClient.CustomViewCallback? = null

    val isActive: Boolean get() = customView != null

    fun show(view: View, newCallback: WebChromeClient.CustomViewCallback, isLandscapeVideo: Boolean) {
        if (customView != null) {
            newCallback.onCustomViewHidden()
            return
        }
        customView = view
        callback = newCallback
        container.addView(
            view,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        container.isVisible = true
        systemBars().hide(WindowInsetsCompat.Type.systemBars())
        if (isLandscapeVideo) activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    /** ユーザー操作（戻るボタン）で全画面を抜ける。ページ側にも通知する */
    fun exit() {
        callback?.onCustomViewHidden()
        hide()
    }

    /** ページ側が全画面を終了したとき（onHideCustomView） */
    fun hide() {
        if (customView == null) return
        container.removeAllViews()
        container.isVisible = false
        customView = null
        callback = null
        systemBars().show(WindowInsetsCompat.Type.systemBars())
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    private fun systemBars() = WindowInsetsControllerCompat(activity.window, activity.window.decorView).apply {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
}
