package io.github.linkohta.komado

import android.graphics.Color
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** 透明なシステムバーで全画面に描画する（両 Activity 共通。super.onCreate の前に呼ぶ） */
fun ComponentActivity.enableTransparentEdgeToEdge() {
    enableEdgeToEdge(
        statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
}

/**
 * システムバー・ノッチ（と必要なら IME）の分だけ padding を付けて中身を避ける。
 * WebView 自体の padding は中身をずらさないので、外側の枠に付ける前提。
 */
fun View.padForSystemBars(includeIme: Boolean = false) {
    ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val bottom = if (includeIme) maxOf(bars.bottom, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom) else bars.bottom
        view.setPadding(bars.left, bars.top, bars.right, bottom)
        WindowInsetsCompat.CONSUMED
    }
}
