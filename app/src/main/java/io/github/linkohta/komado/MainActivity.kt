package io.github.linkohta.komado

import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.webkit.ScriptHandler
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private lateinit var content: FrameLayout
    private lateinit var webView: BackgroundWebView
    private lateinit var fullscreenContainer: FrameLayout
    private lateinit var adBlocker: AdBlocker
    private val sponsorBlock = SponsorBlockClient()
    private val injectJs by lazy { readAsset("inject.js") + "\n" + readAsset("livechat.js") }

    private var scriptHandler: ScriptHandler? = null
    private var hasDocumentStartScript = false
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var lastPipKey: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)

        adBlocker = AdBlocker(this).apply { loadBundled() }
        buildLayout()
        setupWebView()
        installScripts()

        PlaybackHub.controller = ::runCommand
        onBackPressedDispatcher.addCallback(this, backCallback)
        addOnPictureInPictureModeChangedListener { info -> onPipModeChanged(info.isInPictureInPictureMode) }

        webView.loadUrl(urlFromIntent(intent) ?: UrlPolicy.HOME_URL)

        // ダウンロード済みフィルターの読み込みと定期更新
        lifecycleScope.launch {
            if (adBlocker.loadCached()) installScripts()
            if (adBlocker.refreshIfStale()) installScripts()
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && shouldEnterPip()) {
            runCatching { enterPictureInPictureMode(buildPipParams()) }
        }
    }

    override fun onDestroy() {
        if (isFinishing) {
            PlaybackHub.controller = null
            PlaybackHub.reset()
            PlaybackService.stop(this)
        }
        scriptHandler?.remove()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- layout

    private fun buildLayout() {
        val root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.background)) }
        content = FrameLayout(this)
        webView = BackgroundWebView(this).apply { setBackgroundColor(getColor(R.color.background)) }
        fullscreenContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            isVisible = false
        }
        content.addView(webView, matchParent())
        root.addView(content, matchParent())
        root.addView(fullscreenContainer, matchParent())
        setContentView(root)

        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
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
            onPageStarted = { view ->
                // document-start スクリプト非対応の古い WebView 向けフォールバック
                if (!hasDocumentStartScript) view.evaluateJavascript(documentStartScript(), null)
            },
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

    /** inject.js と livechat.js を YouTube のページに document-start で注入する（フィルター更新時は差し替え） */
    private fun installScripts() {
        val selectors = JSONArray(adBlocker.cosmeticSelectors).toString()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            scriptHandler?.remove()
            scriptHandler = WebViewCompat.addDocumentStartJavaScript(
                webView, documentStartScript(), UrlPolicy.YOUTUBE_ORIGIN_RULES,
            )
            hasDocumentStartScript = true
        }
        // 表示中のページにも反映する
        evaluate("addSelectors($selectors)")
    }

    private fun documentStartScript() =
        "window.__KOMADO_CSS=${JSONArray(adBlocker.cosmeticSelectors)};\n$injectJs"

    private fun evaluate(call: String) {
        webView.evaluateJavascript("window.__komado&&window.__komado.$call", null)
    }

    private val chromeClient = object : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback
            fullscreenContainer.addView(view, matchParent())
            fullscreenContainer.isVisible = true
            systemBars().hide(WindowInsetsCompat.Type.systemBars())
            val state = PlaybackHub.state
            if (state.videoWidth >= state.videoHeight) {
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            }
        }

        override fun onHideCustomView() = hideCustomView()

        // 読み込み中に出る灰色の再生アイコンを消す
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    private fun exitFullscreen() {
        customViewCallback?.onCustomViewHidden()
        hideCustomView()
    }

    private fun hideCustomView() {
        if (customView == null) return
        fullscreenContainer.removeAllViews()
        fullscreenContainer.isVisible = false
        customView = null
        customViewCallback = null
        systemBars().show(WindowInsetsCompat.Type.systemBars())
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    private fun systemBars() = WindowInsetsControllerCompat(window, window.decorView).apply {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
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
        updatePipParams()
    }

    private fun requestSegments(videoId: String) {
        if (!UrlPolicy.isValidVideoId(videoId)) return
        lifecycleScope.launch {
            val segments = sponsorBlock.fetchSegments(videoId)
            evaluate("setSegments(${JSONObject.quote(videoId)}, $segments)")
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
        evaluate(call)
        if (command == PlayerCommand.Stop) {
            PlaybackService.stop(this)
            // バックグラウンドで停止されたら WebView も休ませる（次の onResume で再開）
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) webView.onPause()
        }
    }

    // ---------------------------------------------------------------- Picture-in-Picture

    private fun shouldEnterPip(): Boolean {
        val state = PlaybackHub.state
        return state.playing && state.videoId != null && !isInPictureInPictureMode
    }

    private fun updatePipParams() {
        val state = PlaybackHub.state
        val key = "${shouldEnterPip()}:${state.playing}:${state.videoWidth}x${state.videoHeight}"
        if (key == lastPipKey) return
        lastPipKey = key
        try {
            setPictureInPictureParams(buildPipParams())
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "invalid PiP params", e)
        }
    }

    private fun buildPipParams(): PictureInPictureParams {
        val state = PlaybackHub.state
        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(aspectRatio(state.videoWidth, state.videoHeight))
            .setActions(
                listOf(
                    remoteAction(R.drawable.ic_rewind, R.string.action_rewind, ControlReceiver.ACTION_REWIND),
                    if (state.playing) {
                        remoteAction(R.drawable.ic_pause, R.string.action_pause, ControlReceiver.ACTION_TOGGLE)
                    } else {
                        remoteAction(R.drawable.ic_play, R.string.action_play, ControlReceiver.ACTION_TOGGLE)
                    },
                    remoteAction(R.drawable.ic_forward, R.string.action_forward, ControlReceiver.ACTION_FORWARD),
                ),
            )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(state.playing && state.videoId != null)
            builder.setSeamlessResizeEnabled(false)
        }
        return builder.build()
    }

    private fun remoteAction(icon: Int, title: Int, action: String) = RemoteAction(
        Icon.createWithResource(this, icon),
        getString(title),
        getString(title),
        ControlReceiver.pendingIntent(this, action),
    )

    private fun onPipModeChanged(inPip: Boolean) {
        evaluate("setPip($inPip)")
        lastPipKey = null
        if (inPip) {
            if (customView == null) content.setPadding(0, 0, 0, 0)
        } else {
            ViewCompat.requestApplyInsets(content)
            // PiP ウィンドウが閉じられた（✕ / スワイプ）ときは再生を止める
            if (lifecycle.currentState == Lifecycle.State.CREATED) runCommand(PlayerCommand.Pause)
        }
    }

    private fun aspectRatio(width: Int, height: Int): Rational {
        if (width <= 0 || height <= 0) return Rational(16, 9)
        val ratio = width.toFloat() / height
        return when {
            ratio > MAX_ASPECT -> Rational(239, 100)
            ratio < 1 / MAX_ASPECT -> Rational(100, 239)
            else -> Rational(width, height)
        }
    }

    // ---------------------------------------------------------------- misc

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            when {
                customView != null -> exitFullscreen()
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

    private fun readAsset(name: String) = assets.open(name).bufferedReader().use { it.readText() }

    /** "; wv" と "Version/x.x" を取り除いて通常の Chrome と同じ UA にする */
    private fun chromeLikeUserAgent(userAgent: String) =
        userAgent.replace("; wv", "").replace(Regex("""\s*Version/[\d.]+"""), "")

    companion object {
        private const val TAG = "MainActivity"
        private const val MAX_ASPECT = 2.39f

        private fun matchParent() = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
    }
}
