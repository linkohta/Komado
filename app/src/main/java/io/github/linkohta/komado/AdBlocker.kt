package io.github.linkohta.komado

import android.content.Context
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Brave / uBlock Origin と同じ Adblock Plus 形式のフィルターリストを使う広告ブロッカー。
 *
 * 対応しているのは YouTube の視聴に必要な範囲のサブセット:
 *  - `||host^` / `||host/path` 形式のネットワークルール（`@@` の例外も含む）
 *  - youtube.com 向けの要素非表示ルール（`youtube.com##selector`）
 * スクリプトレット（`##+js`）は inject.js で YouTube 専用に実装している。
 */
class AdBlocker(context: Context) {

    private val appContext = context.applicationContext
    private val cacheDir = File(appContext.filesDir, "filters")

    @Volatile
    private var rules = FilterRules.EMPTY

    val cosmeticSelectors: List<String> get() = rules.cosmeticSelectors

    /** 同梱のフィルターだけを読む（起動直後に同期で使う。小さいので速い） */
    fun loadBundled() {
        rules = FilterParser.parse(listOf(readBundled()))
    }

    /** 同梱 + ダウンロード済みのリストを読み込む。キャッシュがあれば true */
    suspend fun loadCached(): Boolean = withContext(Dispatchers.IO) {
        val cached = LISTS.mapNotNull { File(cacheDir, it.fileName).takeIf(File::exists)?.readText() }
        if (cached.isEmpty()) return@withContext false
        rules = FilterParser.parse(listOf(readBundled()) + cached)
        true
    }

    /** リストが古ければダウンロードし直す。更新したら true */
    suspend fun refreshIfStale(): Boolean = withContext(Dispatchers.IO) {
        val now = System.currentTimeMillis()
        val stale = LISTS.filter {
            val file = File(cacheDir, it.fileName)
            !file.exists() || now - file.lastModified() > UPDATE_INTERVAL_MS
        }
        if (stale.isEmpty()) return@withContext false
        cacheDir.mkdirs()
        val updated = stale.count { download(it) }
        if (updated > 0) loadCached()
        updated > 0
    }

    fun shouldBlock(url: Uri): Boolean {
        val host = url.host?.lowercase() ?: return false
        val path = buildString {
            append(url.encodedPath ?: "/")
            url.encodedQuery?.let { append('?').append(it) }
        }
        return rules.matches(host, path)
    }

    private fun readBundled(): String =
        appContext.assets.open("filters.txt").bufferedReader().use { it.readText() }

    private fun download(list: FilterList): Boolean = try {
        val connection = (URL(list.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
        }
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                false
            } else {
                val tmp = File(cacheDir, list.fileName + ".tmp")
                connection.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                tmp.renameTo(File(cacheDir, list.fileName))
            }
        } finally {
            connection.disconnect()
        }
    } catch (e: Exception) {
        Log.w(TAG, "filter download failed: ${list.url}", e)
        false
    }

    private data class FilterList(val url: String, val fileName: String)

    companion object {
        private const val TAG = "AdBlocker"
        private val UPDATE_INTERVAL_MS = TimeUnit.DAYS.toMillis(4)

        private val LISTS = listOf(
            FilterList("https://easylist.to/easylist/easylist.txt", "easylist.txt"),
            FilterList("https://easylist.to/easylist/easyprivacy.txt", "easyprivacy.txt"),
        )
    }
}

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

object FilterParser {

    private val YOUTUBE_DOMAINS = setOf("youtube.com", "m.youtube.com", "www.youtube.com")

    // これ以外のオプションを持つルールは意味が変わるので取り込まない
    private val SUPPORTED_OPTIONS = setOf(
        "third-party", "3p", "script", "image", "stylesheet", "css", "xmlhttprequest", "xhr",
        "subdocument", "frame", "media", "object", "font", "ping", "beacon", "websocket",
        "other", "important", "all", "match-case",
    )

    // ブラウザの CSS では解釈できない拡張セレクタ
    private val PROCEDURAL_SELECTORS = listOf(
        ":-abp-", ":has-text(", ":upward(", ":xpath(", ":remove(", ":style(", ":matches-",
        ":min-text-length(", ":watch-attr(", ":others(", ":contains(",
    )

    fun parse(sources: List<String>): FilterRules {
        val blockedHosts = HashSet<String>()
        val blockedPaths = HashMap<String, MutableList<String>>()
        val allowedHosts = HashSet<String>()
        val allowedPaths = HashMap<String, MutableList<String>>()
        val cosmetic = LinkedHashSet<String>()

        for (source in sources) {
            source.lineSequence().forEach { rawLine ->
                val line = rawLine.trim()
                when {
                    line.isEmpty() || line.startsWith('!') || line.startsWith('[') -> Unit
                    line.contains("#@#") || line.contains("#?#") || line.contains("#$#") ||
                        line.contains("##+js") || line.contains("#%#") -> Unit
                    line.contains("##") -> parseCosmetic(line)?.let(cosmetic::add)
                    line.startsWith("@@||") ->
                        parseNetwork(line.removePrefix("@@"), checkOptions = false, allowedHosts, allowedPaths)
                    line.startsWith("||") ->
                        parseNetwork(line, checkOptions = true, blockedHosts, blockedPaths)
                }
            }
        }
        return FilterRules(blockedHosts, blockedPaths, allowedHosts, allowedPaths, cosmetic.toList())
    }

    private fun parseCosmetic(line: String): String? {
        val (domainPart, selector) = line.split("##", limit = 2)
        if (domainPart.isEmpty() || selector.isBlank()) return null // 汎用ルールは重いので使わない
        if (!appliesToYouTube(domainPart.split(','))) return null
        if (PROCEDURAL_SELECTORS.any { selector.contains(it) }) return null
        return selector.trim()
    }

    private fun appliesToYouTube(domains: List<String>) =
        domains.map { it.trim().lowercase() }.any { !it.startsWith('~') && it in YOUTUBE_DOMAINS }

    private fun parseNetwork(
        line: String,
        checkOptions: Boolean,
        hosts: MutableSet<String>,
        paths: MutableMap<String, MutableList<String>>,
    ) {
        val body = line.removePrefix("||")
        val dollar = body.indexOf('$')
        val pattern = if (dollar >= 0) body.substring(0, dollar) else body
        if (dollar >= 0) {
            val options = body.substring(dollar + 1).split(',').map { it.trim().lowercase() }
            if ("badfilter" in options) return
            // domain= 付きは YouTube 上で有効なルールだけ取り込む（例外ルールも他サイト用を全体に広げない）
            val domainOption = options.firstOrNull { it.startsWith("domain=") }
            if (domainOption != null && !appliesToYouTube(domainOption.removePrefix("domain=").split('|'))) return
            if (checkOptions && options.any { option ->
                    !option.startsWith("domain=") && (
                        option.removePrefix("~").substringBefore('=') !in SUPPORTED_OPTIONS ||
                            option == "~third-party" || option == "~3p"
                        )
                }
            ) return
        }

        val host = pattern.takeWhile { it != '^' && it != '/' && it != '*' && it != '?' && it != ':' && it != '|' }
            .lowercase()
        if (host.isEmpty() || !host.contains('.') || host.startsWith('.') || host.endsWith('.')) return
        val rest = pattern.substring(host.length)
        when {
            rest.isEmpty() || rest == "^" || rest == "^|" || rest == "|" -> hosts += host
            rest.startsWith('/') -> {
                val prefix = rest.takeWhile { it != '*' && it != '^' && it != '|' }
                if (prefix.length >= 2) paths.getOrPut(host) { mutableListOf() } += prefix
            }
        }
    }
}
