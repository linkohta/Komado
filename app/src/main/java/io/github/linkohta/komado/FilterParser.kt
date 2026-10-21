package io.github.linkohta.komado

/**
 * Adblock Plus 形式のフィルターリストを [FilterRules] に変換する。
 * 対応範囲は AdBlocker.kt の説明を参照。未対応のオプションを持つルールは安全側に倒して捨てる。
 */
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
