package io.github.linkohta.komado

/**
 * 解析済みフィルター。[FilterParser.parse] が作り、[AdBlocker] がリクエストごとに照合する。
 * ホストはサフィックス一致（`||host^` は host とそのサブドメインに効く）、パスは前方一致。
 */
class FilterRules(
    private val blockedHosts: Set<String>,
    private val blockedPaths: Map<String, List<String>>,
    private val allowedHosts: Set<String>,
    private val allowedPaths: Map<String, List<String>>,
    val cosmeticSelectors: List<String>,
) {
    fun matches(host: String, path: String): Boolean {
        if (isProtected(host, path)) return false
        val suffixes = hostSuffixes(host)
        if (suffixes.any { it in allowedHosts || allowedPaths[it].matchesPath(path) }) return false
        return suffixes.any { it in blockedHosts || blockedPaths[it].matchesPath(path) }
    }

    private fun List<String>?.matchesPath(path: String) = this?.any { path.startsWith(it) } == true

    /** 汎用リストの誤爆で再生・ログイン・視聴履歴が壊れないように守るリクエスト */
    private fun isProtected(host: String, path: String): Boolean {
        if (PROTECTED_DOMAINS.any { host == it || host.endsWith(".$it") }) return true
        if (host == "youtube.com" || host.endsWith(".youtube.com")) {
            if (path.startsWith("/youtubei/") && !path.contains("ad_break")) return true
            return PROTECTED_YOUTUBE_PATHS.any { path.startsWith(it) }
        }
        return false
    }

    private fun hostSuffixes(host: String): List<String> {
        val result = mutableListOf(host)
        var index = host.indexOf('.')
        while (index >= 0 && index < host.length - 1) {
            result += host.substring(index + 1)
            index = host.indexOf('.', index + 1)
        }
        return result
    }

    companion object {
        val EMPTY = FilterRules(emptySet(), emptyMap(), emptySet(), emptyMap(), emptyList())

        private val PROTECTED_DOMAINS = listOf(
            "googlevideo.com", "ytimg.com", "ggpht.com", "gstatic.com",
            "accounts.google.com", "accounts.youtube.com",
        )
        private val PROTECTED_YOUTUBE_PATHS = listOf(
            "/api/stats/watchtime", "/api/stats/playback", "/s/", "/sw.js", "/watch", "/embed/",
        )
    }
}
