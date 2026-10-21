package io.github.linkohta.komado

import android.app.Activity
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log
import android.util.Rational

/**
 * ピクチャーインピクチャーのパラメータ（アスペクト比・ボタン・自動遷移）を再生状態から組み立てる。
 * 同じ内容を何度も setPictureInPictureParams しないようにキーで間引く。
 */
class PipController(private val activity: Activity) {

    private var lastKey: String? = null

    /** 再生中の動画があり、まだ PiP でなければ PiP に入ってよい */
    fun shouldEnter(state: PlaybackState = PlaybackHub.state): Boolean =
        state.playing && state.videoId != null && !activity.isInPictureInPictureMode

    /** 再生状態が変わるたびに呼ぶ。Android 12+ はこれで自動遷移の可否も更新される */
    fun update(state: PlaybackState = PlaybackHub.state) {
        val key = "${shouldEnter(state)}:${state.playing}:${state.videoWidth}x${state.videoHeight}"
        if (key == lastKey) return
        lastKey = key
        try {
            activity.setPictureInPictureParams(build(state))
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "invalid PiP params", e)
        }
    }

    /** Android 11 以下向け: ホームに戻るときに手動で PiP に入る */
    fun enterNow() {
        runCatching { activity.enterPictureInPictureMode(build(PlaybackHub.state)) }
    }

    /** PiP に入った / 出たあとは次の update で必ず再設定する */
    fun invalidate() {
        lastKey = null
    }

    private fun build(state: PlaybackState): PictureInPictureParams {
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
        Icon.createWithResource(activity, icon),
        activity.getString(title),
        activity.getString(title),
        ControlReceiver.pendingIntent(activity, action),
    )

    companion object {
        private const val TAG = "PipController"
        private const val MAX_ASPECT = 2.39f

        /** PiP が受け付ける範囲（1:2.39〜2.39:1）に収めたアスペクト比。不明なら 16:9 */
        fun aspectRatio(width: Int, height: Int): Rational {
            if (width <= 0 || height <= 0) return Rational(16, 9)
            val ratio = width.toFloat() / height
            return when {
                ratio > MAX_ASPECT -> Rational(239, 100)
                ratio < 1 / MAX_ASPECT -> Rational(100, 239)
                else -> Rational(width, height)
            }
        }
    }
}
