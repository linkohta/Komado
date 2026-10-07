package io.github.linkohta.komado

import android.net.Uri

/** アプリ内（メインフレーム）で表示してよい URL を決める */
object UrlPolicy {

    const val HOME_URL = "https://m.youtube.com/"

    /** document-start スクリプトと JS ブリッジを有効にするオリジン */
    val YOUTUBE_ORIGIN_RULES = setOf("https://youtube.com", "https://*.youtube.com")

    private val youtubeDomains = listOf("youtube.com", "youtu.be", "youtube-nocookie.com")

    // YouTube へのログインで経由するページ
    private val loginHosts = setOf(
        "accounts.google.com",
        "accounts.youtube.com",
        "consent.google.com",
        "consent.youtube.com",
    )
    private val googleHost = Regex("""^(www\.)?google\.[a-z.]+$""")
    private val googleAccountsHost = Regex("""^accounts\.google\.[a-z.]+$""")
    private val googleLoginPaths = listOf("/accounts", "/signin", "/sorry", "/ServiceLogin")

    private val videoId = Regex("""^[\w-]{11}$""")
    private val urlInText = Regex("""https?://\S+""")

    fun isAllowed(uri: Uri): Boolean {
        if (uri.scheme != "https" && uri.scheme != "http") return false
        val host = uri.host?.lowercase() ?: return false
        if (isYouTubeHost(host)) return true
        if (host in loginHosts || googleAccountsHost.matches(host)) return true
        val path = uri.path.orEmpty()
        return googleHost.matches(host) && googleLoginPaths.any { path.startsWith(it) }
    }

    fun isYouTubeHost(host: String): Boolean =
        youtubeDomains.any { host == it || host.endsWith(".$it") }

    fun isValidVideoId(id: String) = videoId.matches(id)

    /** VIEW / SEND インテントで受け取った文字列から、アプリで開く URL を取り出す */
    fun extractYouTubeUrl(text: String): String? =
        urlInText.findAll(text).map { it.value }.firstNotNullOfOrNull(::toPlayableUrl)

    private fun toPlayableUrl(raw: String): String? {
        val uri = Uri.parse(raw)
        val host = uri.host?.lowercase() ?: return null
        if (!isYouTubeHost(host)) return null
        if (host == "youtu.be") {
            val id = uri.pathSegments.firstOrNull()?.takeIf(::isValidVideoId) ?: return null
            val builder = Uri.parse("https://m.youtube.com/watch").buildUpon().appendQueryParameter("v", id)
            uri.getQueryParameter("t")?.let { builder.appendQueryParameter("t", it) }
            return builder.build().toString()
        }
        return uri.buildUpon().scheme("https").build().toString()
    }
}
