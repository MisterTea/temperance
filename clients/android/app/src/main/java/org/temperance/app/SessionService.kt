package org.temperance.app
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SessionService : Service() {
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("vpn", "Family VPN", NotificationManager.IMPORTANCE_LOW))
        startForeground(1, Notification.Builder(this, "vpn").setContentTitle("Temperance VPN").setContentText("Your family's rules apply on this device").setSmallIcon(android.R.drawable.ic_lock_lock).build())
        val app = application as TemperanceApp
        scheduler.scheduleWithFixedDelay({ try { app.refresh() } catch (_: Exception) { app.status = "Can't reach your family's Temperance right now. The last rules stay in effect." } }, 30, 30, TimeUnit.SECONDS)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as TemperanceApp
        app.executor.execute { try { app.connect() } catch (e: Exception) { app.status = StatusText.error(e) } }
        return START_STICKY
    }
    override fun onDestroy() { scheduler.shutdownNow(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
