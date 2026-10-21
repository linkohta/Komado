package io.github.linkohta.komado

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * WebView で YouTube を表示する唯一の画面。
 * 全画面・PiP・スクリプト注入はそれぞれ [FullscreenController] / [PipController] / [ScriptInjector] に任せ、
 * ここでは WebView の設定、ページからのメッセージの振り分け、Activity のライフサイクルを扱う。
 */
class MainActivity : ComponentActivity() {

    private lateinit var content: FrameLayout
    private lateinit var webView: BackgroundWebView
    private lateinit var adBlocker: AdBlocker
    private lateinit var scripts: ScriptInjector
    private lateinit var fullscreen: FullscreenController
    private val pip = PipController(this)
    private val sponsorBlock = SponsorBlockClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableTransparentEdgeToEdge()
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)

        adBlocker = AdBlocker(this).apply { loadBundled() }
        buildLayout()
        setupWebView()
        scripts = ScriptInjector(webView, adBlocker).apply { install() }

        PlaybackHub.controller = ::runCommand
        onBackPressedDispatcher.addCallback(this, backCallback)
        addOnPictureInPictureModeChangedListener { info -> onPipModeChanged(info.isInPictureInPictureMode) }

        webView.loadUrl(urlFromIntent(intent) ?: UrlPolicy.HOME_URL)

        // ダウンロード済みフィルターの読み込みと定期更新
        lifecycleScope.launch {
            if (adBlocker.loadCached()) scripts.install()
            if (adBlocker.refreshIfStale()) scripts.install()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        urlFromIntent(intent)?.let(webView::loadUrl)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        super.onPause()
        // webView.onPause() は呼ばない（呼ぶとバックグラウンド再生が止まる）
        CookieManager.getInstance().flush()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Android 12 以降は setAutoEnterEnabled で自動的に PiP に入る
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && pip.shouldEnter()) pip.enterNow()
    }

    override fun onDestroy() {
        if (isFinishing) {
            PlaybackHub.controller = null
            PlaybackHub.reset()
            PlaybackService.stop(this)
        }
        scripts.release()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- layout

    private fun buildLayout() {
        val root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.background)) }
        content = FrameLayout(this)
        webView = BackgroundWebView(this).apply { setBackgroundColor(getColor(R.color.background)) }
        val fullscreenContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            isVisible = false
        }
        content.addView(webView, matchParent())
        root.addView(content, matchParent())
        root.addView(fullscreenContainer, matchParent())
        setContentView(root)
        content.padForSystemBars(includeIme = true)
        fullscreen = FullscreenController(this, fullscreenContainer)
    }

    // ---------------------------------------------------------------- WebView

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = chromeLikeUserAgent(userAgentString)
        }
        // Google ログインが「安全でないブラウザ」として弾かれないよう、WebView 特有の印を消す
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(webView.settings, emptySet())
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.webViewClient = YouTubeWebViewClient(
            adBlocker = adBlocker,
            onPageStarted = { if (scripts.needsPageStartFallback) scripts.injectIntoCurrentPage() },
            onRendererGone = { recreate() },
        )
        webView.webChromeClient = chromeClient

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KomadoBridge", UrlPolicy.YOUTUBE_ORIGIN_RULES) {
                    _, message, _, isMainFrame, _ ->
                if (isMainFrame) message.data?.let(::onBridgeMessage)
            }
        } else {
            Toast.makeText(this, R.string.webview_outdated, Toast.LENGTH_LONG).show()
        }
    }

    private val chromeClient = object : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            val state = PlaybackHub.state
            fullscreen.show(view, callback, isLandscapeVideo = state.videoWidth >= state.videoHeight)
        }

        override fun onHideCustomView() = fullscreen.hide()

        // 読み込み中に出る灰色の再生アイコンを消す
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    // ---------------------------------------------------------------- JS bridge

    private fun onBridgeMessage(raw: String) {
        val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
        when (message.optString("type")) {
            "state" -> onPlaybackState(PlaybackState.fromJson(message))
            "segments" -> requestSegments(message.optString("videoId"))
            "skipped" -> Toast.makeText(
                this,
                getString(R.string.sponsor_skipped, SponsorBlockClient.label(message.optString("category"))),
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    private fun onPlaybackState(state: PlaybackState) {
        PlaybackHub.update(state)
        if (state.playing && !PlaybackHub.serviceRunning) PlaybackService.start(this)
        pip.update(state)
    }

    private fun requestSegments(videoId: String) {
        if (!UrlPolicy.isValidVideoId(videoId)) return
        lifecycleScope.launch {
            val segments = sponsorBlock.fetchSegments(videoId)
            scripts.call("setSegments(${JSONObject.quote(videoId)}, $segments)")
        }
    }

    private fun runCommand(command: PlayerCommand) {
        val call = when (command) {
            PlayerCommand.Play -> "control('play')"
            PlayerCommand.Pause, PlayerCommand.Stop -> "control('pause')"
            PlayerCommand.Toggle -> "control('toggle')"
            PlayerCommand.Next -> "control('next')"
            PlayerCommand.Previous -> "control('prev')"
            is PlayerCommand.SeekBy -> "control('seekBy', ${command.seconds})"
            is PlayerCommand.SeekTo -> "control('seekTo', ${command.seconds})"
        }
        scripts.call(call)
        if (command == PlayerCommand.Stop) {
            PlaybackService.stop(this)
            // バックグラウンドで停止されたら WebView も休ませる（次の onResume で再開）
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) webView.onPause()
        }
    }

    // ---------------------------------------------------------------- Picture-in-Picture

    private fun onPipModeChanged(inPip: Boolean) {
        scripts.call("setPip($inPip)")
        pip.invalidate()
        if (inPip) {
            if (!fullscreen.isActive) content.setPadding(0, 0, 0, 0)
        } else {
            ViewCompat.requestApplyInsets(content)
            // PiP ウィンドウが閉じられた（✕ / スワイプ）ときは再生を止める
            if (lifecycle.currentState == Lifecycle.State.CREATED) runCommand(PlayerCommand.Pause)
        }
    }

    // ---------------------------------------------------------------- misc

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            when {
                fullscreen.isActive -> fullscreen.exit()
                webView.canGoBack() -> webView.goBack()
                // 再生中ならアプリを閉じずにバックグラウンドへ（再生を続ける）
                PlaybackHub.state.playing -> moveTaskToBack(true)
                else -> finish()
            }
        }
    }

    private fun urlFromIntent(intent: Intent?): String? = when (intent?.action) {
        Intent.ACTION_VIEW -> intent.dataString?.let(UrlPolicy::extractYouTubeUrl)
        Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let(UrlPolicy::extractYouTubeUrl)
        else -> null
    }

    /** "; wv" と "Version/x.x" を取り除いて通常の Chrome と同じ UA にする */
    private fun chromeLikeUserAgent(userAgent: String) =
        userAgent.replace("; wv", "").replace(Regex("""\s*Version/[\d.]+"""), "")

    private fun matchParent() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
    )
}
