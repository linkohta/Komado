package io.github.linkohta.komado

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URL
import java.util.concurrent.TimeUnit
import androidx.media.app.NotificationCompat as MediaNotificationCompat

/**
 * バックグラウンド再生用のフォアグラウンドサービス。
 * 実際の再生は WebView が行い、ここでは通知・MediaSession・WakeLock でプロセスを生かしておく。
 */
class PlaybackService : Service() {

    private lateinit var session: MediaSessionCompat
    private lateinit var wakeLock: PowerManager.WakeLock
    private val scope = MainScope()
    private var artworkVideoId: String? = null
    private var artwork: Bitmap? = null
    private val stateListener: (PlaybackState) -> Unit = { render(it) }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        session = MediaSessionCompat(this, "Komado").apply {
            setCallback(SessionCallback())
            isActive = true
        }
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Komado:playback")
            .apply { setReferenceCounted(false) }
        PlaybackHub.serviceRunning = true
        PlaybackHub.addListener(stateListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(PlaybackHub.state),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0,
        )
        render(PlaybackHub.state)
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 最近使ったアプリからスワイプで消されたら終了
        PlaybackHub.send(PlayerCommand.Pause)
        stopSelf()
    }

    override fun onDestroy() {
        PlaybackHub.removeListener(stateListener)
        PlaybackHub.serviceRunning = false
        if (wakeLock.isHeld) wakeLock.release()
        session.isActive = false
        session.release()
        scope.cancel()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun render(state: PlaybackState) {
        loadArtworkIfNeeded(state)
        session.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.artist)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.durationMs)
                .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork)
                .build(),
        )
        session.setPlaybackState(buildPlaybackState(state))
        if (state.playing) wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS) else if (wakeLock.isHeld) wakeLock.release()
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(state))
    }

    private fun buildPlaybackState(state: PlaybackState): PlaybackStateCompat {
        var actions = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SEEK_TO or
            PlaybackStateCompat.ACTION_STOP
        if (state.hasNext) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        if (state.hasPrevious) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        return PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(
                if (state.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                state.positionMs,
                if (state.playing) 1f else 0f,
                SystemClock.elapsedRealtime(),
            )
            .addCustomAction(CUSTOM_REWIND, getString(R.string.action_rewind), R.drawable.ic_rewind)
            .addCustomAction(CUSTOM_FORWARD, getString(R.string.action_forward), R.drawable.ic_forward)
            .build()
    }

    private fun buildNotification(state: PlaybackState): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(state.title.ifEmpty { getString(R.string.app_name) })
            .setContentText(state.artist)
            .setLargeIcon(artwork)
            .setContentIntent(openApp)
            .setDeleteIntent(ControlReceiver.pendingIntent(this, ControlReceiver.ACTION_STOP))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(state.playing)
            .addAction(R.drawable.ic_rewind, getString(R.string.action_rewind), ControlReceiver.ACTION_REWIND)
            .addAction(
                if (state.playing) R.drawable.ic_pause else R.drawable.ic_play,
                getString(if (state.playing) R.string.action_pause else R.string.action_play),
                ControlReceiver.ACTION_TOGGLE,
            )
            .addAction(R.drawable.ic_forward, getString(R.string.action_forward), ControlReceiver.ACTION_FORWARD)
            .addAction(R.drawable.ic_skip_next, getString(R.string.action_next), ControlReceiver.ACTION_NEXT)
            .addAction(R.drawable.ic_close, getString(R.string.action_close), ControlReceiver.ACTION_STOP)
            .setStyle(
                MediaNotificationCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2),
            )
        return builder.build()
    }

    private fun NotificationCompat.Builder.addAction(icon: Int, title: String, action: String) =
        addAction(icon, title, ControlReceiver.pendingIntent(this@PlaybackService, action))

    private fun loadArtworkIfNeeded(state: PlaybackState) {
        val videoId = state.videoId ?: return
        if (videoId == artworkVideoId) return
        artworkVideoId = videoId
        artwork = null
        val url = state.artworkUrl ?: "https://i.ytimg.com/vi/$videoId/hqdefault.jpg"
        scope.launch {
            val bitmap = withContext(Dispatchers.IO) {
                runCatching { URL(url).openStream().use(BitmapFactory::decodeStream) }
                    .onFailure { Log.w(TAG, "artwork load failed", it) }
                    .getOrNull()
            }
            if (bitmap != null && artworkVideoId == videoId) {
                artwork = bitmap
                render(PlaybackHub.state)
            }
        }
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_playback),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { setShowBadge(false) }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private inner class SessionCallback : MediaSessionCompat.Callback() {
        override fun onPlay() = PlaybackHub.send(PlayerCommand.Play)
        override fun onPause() = PlaybackHub.send(PlayerCommand.Pause)
        override fun onSkipToNext() = PlaybackHub.send(PlayerCommand.Next)
        override fun onSkipToPrevious() = PlaybackHub.send(PlayerCommand.Previous)
        override fun onSeekTo(pos: Long) = PlaybackHub.send(PlayerCommand.SeekTo(pos / 1000.0))

        override fun onStop() {
            PlaybackHub.send(PlayerCommand.Stop)
            stopSelf()
        }

        override fun onCustomAction(action: String, extras: Bundle?) {
            when (action) {
                CUSTOM_REWIND -> PlaybackHub.send(PlayerCommand.SeekBy(-ControlReceiver.SEEK_SECONDS))
                CUSTOM_FORWARD -> PlaybackHub.send(PlayerCommand.SeekBy(ControlReceiver.SEEK_SECONDS))
            }
        }
    }

    companion object {
        private const val TAG = "PlaybackService"
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 1
        private const val CUSTOM_REWIND = "rewind"
        private const val CUSTOM_FORWARD = "forward"
        private val WAKE_LOCK_TIMEOUT_MS = TimeUnit.HOURS.toMillis(3)

        /** @return 起動できたら true（Android 12+ ではバックグラウンドからの起動が拒否されることがある） */
        fun start(context: Context): Boolean = try {
            ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
            true
        } catch (e: IllegalStateException) {
            Log.w(TAG, "cannot start foreground service now", e)
            false
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, PlaybackService::class.java))
        }
    }
}
