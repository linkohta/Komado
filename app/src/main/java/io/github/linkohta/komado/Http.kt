package io.github.linkohta.komado

import java.net.HttpURLConnection
import java.net.URL

/** HttpURLConnection の接続・切断の定型を 1 か所にまとめる */
object Http {
    /**
     * [url] に GET して [handler] の結果を返す。接続は必ず切断する。
     * 失敗（例外）は呼び出し側で扱う。
     */
    fun <T> get(url: String, connectTimeoutMs: Int, readTimeoutMs: Int, handler: (HttpURLConnection) -> T): T {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
        }
        try {
            return handler(connection)
        } finally {
            connection.disconnect()
        }
    }
}
