package com.zahran.printbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service that owns the [BridgeServer] lifecycle.  Without
 * a foreground service the OS would freeze the embedded HTTP server
 * the moment Chrome moves to the foreground for printing — defeating
 * the whole bridge design.
 *
 * The notification doubles as the user-visible "Bridge running on
 * :8911" indicator, with a tap-target that opens [MainActivity].
 */
class BridgeService : Service() {

    companion object {
        private const val TAG = "BridgeService"
        private const val NOTIF_CHANNEL_ID = "print_bridge"
        const val NOTIF_ID = 7011

        const val ACTION_START = "com.zahran.printbridge.action.START"
        const val ACTION_STOP = "com.zahran.printbridge.action.STOP"
    }

    private var server: BridgeServer? = null
    private val binder = LocalBinder()

    /** Local binder so [MainActivity] can read `defaultPrinterMac` etc. */
    inner class LocalBinder : Binder() {
        fun service(): BridgeService = this@BridgeService
    }

    /** Currently selected printer for the bridge (mirrors what the
     *  user picked in [MainActivity]).  Persisted across rebinds. */
    @Volatile var selectedMac: String? = null
        set(value) {
            field = value
            server?.defaultPrinterMac = value
        }

    @Volatile var selectedName: String? = null
        set(value) {
            field = value
            server?.defaultPrinterName = value
        }

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        when (action) {
            ACTION_START -> startBridge()
            ACTION_STOP -> {
                stopBridge()
                stopSelf()
            }
        }
        // STICKY: the OS restarts the service on its own if the
        // process is killed — important for retail tablets that go
        // through Doze cycles overnight.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        stopBridge()
        super.onDestroy()
    }

    // ─── Bridge lifecycle ─────────────────────────────────────────

    private fun startBridge() {
        if (server != null) {
            updateNotification()
            return
        }
        try {
            val srv = BridgeServer(
                ctx = applicationContext,
                defaultPrinterMac = selectedMac,
                defaultPrinterName = selectedName,
                versionName = BuildConfig.VERSION_NAME,
            )
            srv.startBridge()
            server = srv
            startForegroundCompat()
            Log.i(TAG, "Bridge service started.")
        } catch (e: Exception) {
            // Most likely BindException (port in use) — log + stop
            // gracefully so the user can see "stopped" in the UI.
            Log.e(TAG, "Failed to start bridge", e)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun stopBridge() {
        server?.stopBridge()
        server = null
    }

    // ─── Foreground notification ─────────────────────────────────

    private fun startForegroundCompat() {
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+: typed foreground service required.
            startForeground(
                NOTIF_ID,
                notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun updateNotification() {
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val tap = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val urlText = "${BridgeServer.LOOPBACK_HOST}:${BridgeServer.BRIDGE_PORT}"
        return NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(R.string.notif_text, urlText))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(tap)
            // Required by Android 12+ — a notification accompanying
            // a foreground service must be PRIORITY_LOW or higher.
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(NOTIF_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            NOTIF_CHANNEL_ID,
            getString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notif_channel_desc)
            setShowBadge(false)
        }
        mgr.createNotificationChannel(channel)
    }
}
