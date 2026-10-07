package io.github.linkohta.komado

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** ライセンスとクレジット（ランチャーアイコン長押しのショートカットから開く） */
class LicensesActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        val webView = WebView(this).apply {
            setBackgroundColor(getColor(R.color.background))
            settings.javaScriptEnabled = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.toString().startsWith(ASSET_ROOT)) return false
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    } catch (_: ActivityNotFoundException) {
                    }
                    return true
                }
            }
            loadUrl("${ASSET_ROOT}licenses.html")
        }
        // WebView 自体の padding は中身をずらさないので、外側の枠に余白を付ける
        val container = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.background))
            addView(webView)
        }
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    companion object {
        private const val ASSET_ROOT = "file:///android_asset/"
    }
}
