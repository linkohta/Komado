package io.github.linkohta.komado

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.security.MessageDigest

/**
 * SponsorBlock API クライアント。
 * 動画 ID そのものは送らず、SHA-256 の先頭 4 文字だけで問い合わせる（k-匿名性 API）。
 */
class SponsorBlockClient {

    private val cache = HashMap<String, JSONArray>()

    /** @return [{start, end, category}] の配列（秒単位） */
    suspend fun fetchSegments(videoId: String): JSONArray {
        cache[videoId]?.let { return it }
        val result = withContext(Dispatchers.IO) { request(videoId) } ?: return JSONArray()
        cache[videoId] = result
        return result
    }

    private fun request(videoId: String): JSONArray? = try {
        val prefix = sha256(videoId).take(4)
        val categories = URLEncoder.encode(JSONArray(CATEGORIES.keys).toString(), "UTF-8")
        val actionTypes = URLEncoder.encode("""["skip"]""", "UTF-8")
        val url = "$API/skipSegments/$prefix?categories=$categories&actionTypes=$actionTypes"
        Http.get(url, connectTimeoutMs = 10_000, readTimeoutMs = 10_000) { connection ->
            when (connection.responseCode) {
                HttpURLConnection.HTTP_OK -> {
                    val body = connection.inputStream.bufferedReader().use { it.readText() }
                    extract(JSONArray(body), videoId)
                }
                HttpURLConnection.HTTP_NOT_FOUND -> JSONArray() // セグメントなし
                else -> null
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "SponsorBlock request failed", e)
        null
    }

    private fun extract(videos: JSONArray, videoId: String): JSONArray {
        val result = JSONArray()
        for (i in 0 until videos.length()) {
            val video = videos.getJSONObject(i)
            if (video.optString("videoID") != videoId) continue
            val segments = video.optJSONArray("segments") ?: continue
            for (j in 0 until segments.length()) {
                val segment = segments.getJSONObject(j)
                val range = segment.optJSONArray("segment") ?: continue
                result.put(
                    JSONObject()
                        .put("start", range.getDouble(0))
                        .put("end", range.getDouble(1))
                        .put("category", segment.optString("category")),
                )
            }
        }
        return result
    }

    private fun sha256(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
            .joinToString("") { "%02x".format(it) }

    companion object {
        private const val TAG = "SponsorBlock"
        private const val API = "https://sponsor.ajay.app/api"

        /** スキップするカテゴリと、トーストに出す名前 */
        val CATEGORIES = linkedMapOf(
            "sponsor" to "スポンサー",
            "selfpromo" to "自己宣伝",
            "interaction" to "高評価・登録のお願い",
        )

        fun label(category: String) = CATEGORIES[category] ?: category
    }
}
