package io.github.linkohta.komado

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

/** ライセンスとクレジット（ランチャーアイコン長押しのショートカットから開く） */
class LicensesActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableTransparentEdgeToEdge()
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
        val container = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.background))
            addView(webView)
        }
        setContentView(container)
        container.padForSystemBars()

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
