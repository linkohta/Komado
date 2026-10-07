package io.github.linkohta.komado

import org.json.JSONObject

/** WebView 内の <video> の状態。inject.js から送られてくる。 */
data class PlaybackState(
    val videoId: String? = null,
    val title: String = "",
    val artist: String = "",
    val artworkUrl: String? = null,
    val playing: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val videoWidth: Int = 0,
    val videoHeight: Int = 0,
    val hasNext: Boolean = false,
    val hasPrevious: Boolean = false,
) {
    companion object {
        fun fromJson(json: JSONObject) = PlaybackState(
            videoId = json.optStringOrNull("videoId"),
            title = json.optStringOrNull("title").orEmpty(),
            artist = json.optStringOrNull("artist").orEmpty(),
            artworkUrl = json.optStringOrNull("artwork")?.takeIf { it.startsWith("https://") },
            playing = json.optBoolean("playing"),
            positionMs = json.optLong("position"),
            durationMs = json.optLong("duration"),
            videoWidth = json.optInt("width"),
            videoHeight = json.optInt("height"),
            hasNext = json.optBoolean("hasNext"),
            hasPrevious = json.optBoolean("hasPrev"),
        )
    }
}

fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).ifEmpty { null }

sealed interface PlayerCommand {
    data object Play : PlayerCommand
    data object Pause : PlayerCommand
    data object Toggle : PlayerCommand
    data object Next : PlayerCommand
    data object Previous : PlayerCommand
    data class SeekBy(val seconds: Double) : PlayerCommand
    data class SeekTo(val seconds: Double) : PlayerCommand

    /** 再生を止めて通知（フォアグラウンドサービス）も閉じる */
    data object Stop : PlayerCommand
}

/**
 * Activity（WebView を持つ）と通知・PiP・MediaSession をつなぐプロセス内のハブ。
 * すべてメインスレッドから触る前提。
 */
object PlaybackHub {
    var state = PlaybackState()
        private set

    /** WebView にコマンドを流す関数。Activity が生きている間だけ設定される。 */
    var controller: ((PlayerCommand) -> Unit)? = null

    var serviceRunning = false

    private val listeners = mutableListOf<(PlaybackState) -> Unit>()

    fun update(newState: PlaybackState) {
        state = newState
        listeners.toList().forEach { it(newState) }
    }

    fun send(command: PlayerCommand) {
        controller?.invoke(command)
    }

    fun addListener(listener: (PlaybackState) -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: (PlaybackState) -> Unit) {
        listeners -= listener
    }

    fun reset() {
        state = PlaybackState()
    }
}
