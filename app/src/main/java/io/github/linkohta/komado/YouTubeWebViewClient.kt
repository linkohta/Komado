package io.github.linkohta.komado

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import java.io.ByteArrayInputStream

/**
 * - メインフレームは YouTube（とログイン画面）だけ表示し、それ以外は外部ブラウザへ
 * - サブリソースは広告ブロッカーに通す
 */
class YouTubeWebViewClient(
    private val adBlocker: AdBlocker,
    private val onPageStarted: (WebView) -> Unit,
    private val onRendererGone: () -> Unit,
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame) return false
        val uri = request.url
        return when {
            UrlPolicy.isAllowed(uri) -> false
            uri.scheme == "http" || uri.scheme == "https" -> {
                openExternally(view, uri)
                true
            }
            // intent:// や vnd.youtube: など（YouTube アプリへの誘導）は無視する
            else -> true
        }
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (request.isForMainFrame || !adBlocker.shouldBlock(request.url)) return null
        return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        onPageStarted(view)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onRendererGone()
        return true
    }

    private fun openExternally(view: WebView, uri: Uri) {
        val context = view.context
        try {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, uri)
                    .addCategory(Intent.CATEGORY_BROWSABLE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            Toast.makeText(context, R.string.open_external, Toast.LENGTH_SHORT).show()
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(context, R.string.no_external_app, Toast.LENGTH_SHORT).show()
        }
    }
}
