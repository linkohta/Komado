package io.github.linkohta.komado

import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray

/**
 * komado.js を YouTube のページに document-start で注入し、ページ内の `window.__komado` API を呼び出す窓口。
 *
 * komado.js は web/（TypeScript）からビルド時に生成されるアセット（app/build.gradle.kts の bundle*WebScripts）。
 * 注入するスクリプトの先頭には `window.__KOMADO_CSS`（要素非表示セレクタの配列）を付ける。
 */
class ScriptInjector(private val webView: WebView, private val adBlocker: AdBlocker) {

    private val bundledJs by lazy {
        webView.context.assets.open(SCRIPT_ASSET).bufferedReader().use { it.readText() }
    }

    private var scriptHandler: ScriptHandler? = null

    /** document-start スクリプトに対応していない古い WebView では onPageStarted で代わりに流し込む */
    val needsPageStartFallback: Boolean
        get() = !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    /** スクリプトを登録する。フィルター更新時に呼び直すと差し替わり、表示中のページにも反映される */
    fun install() {
        if (!needsPageStartFallback) {
            scriptHandler?.remove()
            scriptHandler = WebViewCompat.addDocumentStartJavaScript(
                webView, documentStartScript(), UrlPolicy.YOUTUBE_ORIGIN_RULES,
            )
        }
        call("addSelectors(${selectorsJson()})")
    }

    /** フォールバック用: 読み込み開始したページにスクリプトを流し込む */
    fun injectIntoCurrentPage() {
        webView.evaluateJavascript(documentStartScript(), null)
    }

    /** `window.__komado.<call>` を実行する（スクリプト未注入のページでは何もしない） */
    fun call(call: String) {
        webView.evaluateJavascript("window.__komado&&window.__komado.$call", null)
    }

    fun release() {
        scriptHandler?.remove()
        scriptHandler = null
    }

    private fun documentStartScript() = "window.__KOMADO_CSS=${selectorsJson()};\n$bundledJs"

    private fun selectorsJson() = JSONArray(adBlocker.cosmeticSelectors).toString()

    companion object {
        private const val SCRIPT_ASSET = "komado.js"
    }
}
