package io.github.linkohta.komado

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 通知ボタンと PiP ウィンドウのボタンを受け取る */
class ControlReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val command = when (intent.action) {
            ACTION_TOGGLE -> PlayerCommand.Toggle
            ACTION_REWIND -> PlayerCommand.SeekBy(-SEEK_SECONDS)
            ACTION_FORWARD -> PlayerCommand.SeekBy(SEEK_SECONDS)
            ACTION_NEXT -> PlayerCommand.Next
            ACTION_PREVIOUS -> PlayerCommand.Previous
            ACTION_STOP -> PlayerCommand.Stop
            else -> return
        }
        PlaybackHub.send(command)
        if (command == PlayerCommand.Stop) PlaybackService.stop(context)
    }

    companion object {
        const val SEEK_SECONDS = 10.0

        const val ACTION_TOGGLE = "io.github.linkohta.komado.action.TOGGLE"
        const val ACTION_REWIND = "io.github.linkohta.komado.action.REWIND"
        const val ACTION_FORWARD = "io.github.linkohta.komado.action.FORWARD"
        const val ACTION_NEXT = "io.github.linkohta.komado.action.NEXT"
        const val ACTION_PREVIOUS = "io.github.linkohta.komado.action.PREVIOUS"
        const val ACTION_STOP = "io.github.linkohta.komado.action.STOP"

        private val REQUEST_CODES = listOf(
            ACTION_TOGGLE, ACTION_REWIND, ACTION_FORWARD, ACTION_NEXT, ACTION_PREVIOUS, ACTION_STOP,
        )

        fun pendingIntent(context: Context, action: String): PendingIntent =
            PendingIntent.getBroadcast(
                context,
                REQUEST_CODES.indexOf(action),
                Intent(context, ControlReceiver::class.java).setAction(action),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
    }
}
