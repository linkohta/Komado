package io.github.linkohta.komado

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
