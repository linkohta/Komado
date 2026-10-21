package io.github.linkohta.komado

import android.content.Context
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
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
        Http.get(list.url, connectTimeoutMs = 15_000, readTimeoutMs = 30_000) { connection ->
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                false
            } else {
                val tmp = File(cacheDir, list.fileName + ".tmp")
                connection.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                tmp.renameTo(File(cacheDir, list.fileName))
            }
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
