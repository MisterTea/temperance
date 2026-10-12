package org.temperance.app

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.VpnService
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.wireguard.android.backend.Backend
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import java.net.URL
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection
import uniffi.temperance_core.ChildStatus
import uniffi.temperance_core.Connectivity
import uniffi.temperance_core.DeviceFacts
import uniffi.temperance_core.Diagnostic
import uniffi.temperance_core.HttpRequest
import uniffi.temperance_core.Identity
import uniffi.temperance_core.childAlerts
import uniffi.temperance_core.childStatus
import uniffi.temperance_core.diagnose
import uniffi.temperance_core.diagnosticsRequest
import uniffi.temperance_core.locationRequest
import uniffi.temperance_core.locationUnavailableRequest
import uniffi.temperance_core.parseOk
import uniffi.temperance_core.identityFromJson
import uniffi.temperance_core.identityToJson
import uniffi.temperance_core.parseDeviceState
import uniffi.temperance_core.parseTimeRequest
import uniffi.temperance_core.refreshedIdentity
import uniffi.temperance_core.stateRequest
import uniffi.temperance_core.timeRequest
import uniffi.temperance_core.tunnelConfig

private fun keystoreKey(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey("temperance", null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
        init(KeyGenParameterSpec.Builder("temperance", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
}

/** AES-GCM encrypted identity, keyed by the Android Keystore. */
class Vault(private val context: Context, private val key: () -> SecretKey = ::keystoreKey) : IdentityStore {
    @Synchronized override fun load(): Identity? {
        val text = context.getSharedPreferences("vault", Context.MODE_PRIVATE).getString("identity", null) ?: return null
        val raw = Base64.decode(text, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        return identityFromJson(String(cipher.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8))
    }
    @Synchronized override fun save(identity: Identity) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val raw = cipher.iv + cipher.doFinal(identityToJson(identity).toByteArray(Charsets.UTF_8))
        check(context.getSharedPreferences("vault", Context.MODE_PRIVATE).edit().putString("identity", Base64.encodeToString(raw, Base64.NO_WRAP)).commit())
    }
    @Synchronized fun clear() { context.getSharedPreferences("vault", Context.MODE_PRIVATE).edit().clear().commit() }
}

/** Executes a request built by the shared core; redirects are never followed. */
object HttpsTransport : Transport {
    override fun send(request: HttpRequest): Pair<UShort, String> {
        val connection = URL(request.url).openConnection() as HttpsURLConnection
        connection.connectTimeout = 10000; connection.readTimeout = 10000; connection.instanceFollowRedirects = false
        connection.requestMethod = request.method
        request.headers.forEach { connection.setRequestProperty(it.name, it.value) }
        try {
            request.body?.let { body -> connection.doOutput = true; connection.outputStream.use { it.write(body.toByteArray()) } }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            return status.toUShort() to (stream?.bufferedReader()?.use { it.readText() } ?: "")
        } finally { connection.disconnect() }
    }
}

open class TemperanceApp : Application() {
    val executor = Executors.newSingleThreadExecutor()
    lateinit var backend: Backend
    lateinit var vault: Vault
    /** Replaced by instrumentation tests with a scripted server. */
    @Volatile var transport: Transport = HttpsTransport
    val setup get() = DeviceSetup({ transport.send(it) }, vault)
    @Volatile var status = ""
    @Volatile var child: ChildStatus? = null
    @Volatile var connected = false
    val tunnel = object : Tunnel {
        override fun getName() = "temperance"
        override fun onStateChange(newState: Tunnel.State) { connected = newState == Tunnel.State.UP }
    }
    protected open fun createBackend(): Backend = GoBackend(this)
    protected open fun createVault() = Vault(this)
    override fun onCreate() {
        super.onCreate(); vault = createVault(); backend = createBackend()
        GoBackend.setAlwaysOnCallback { startForegroundService(Intent(this, SessionService::class.java)) }
        vault.load()?.state?.let { child = childStatus(it, now()) }
    }
    private fun now() = System.currentTimeMillis() / 1000

    fun signIn(server: String, username: String, password: String, deviceName: String = "Android device") {
        val identity = setup.signIn(server, username, password, deviceName)
        child = childStatus(identity.state!!, now())
    }
    val enrolled get() = child != null
    fun vpnPermission() = VpnService.prepare(this) == null
    fun disconnect() { backend.setState(tunnel, Tunnel.State.DOWN, null) }
    fun connect() {
        val identity = vault.load() ?: error("Enroll first")
        val config = tunnelConfig(identity.privateKey, identity.state?.tunnel ?: error("Enroll first"))
        backend.setState(tunnel, Tunnel.State.UP, Config.parse(config.byteInputStream()))
    }
    fun refresh() {
        val identity = vault.load()?.takeIf { it.state != null } ?: return
        val (code, body) = try { transport.send(stateRequest(identity)) } catch (e: Exception) { checkHealth(identity, false); throw e }
        val latest = parseDeviceState(code, body)
        val alerts = childAlerts(identity.state, latest, now())
        val next = refreshedIdentity(identity, latest, connected)
        vault.save(next)
        child = childStatus(next.state!!, now())
        status = "Policy ${next.state!!.version}"
        alerts.forEach(::notifyChild)
        if (latest.locationRequested) shareLocation(next)
        checkHealth(next, true)
    }

    @Volatile var health: List<Diagnostic> = emptyList()
    private var reported: List<String>? = null

    private fun locationGranted() = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        .any { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    /** Gathers platform facts; the shared core decides what they mean. Reports changes to parents. */
    private fun checkHealth(identity: Identity, policyReachable: Boolean) {
        val handshake = try {
            if (connected) backend.getStatistics(tunnel).let { stats -> stats.peers().maxOfOrNull { stats.peer(it)?.latestHandshakeEpochMillis() ?: 0L } } else null
        } catch (_: Exception) { null }
        val connectivity = getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION") val networks = connectivity.allNetworks.mapNotNull { connectivity.getNetworkCapabilities(it) }.filter { !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
        val facts = DeviceFacts(
            vpnPermission = VpnService.prepare(this) == null,
            tunnelUp = connected,
            secondsSinceHandshake = handshake?.let { if (it == 0L) ULong.MAX_VALUE else ((System.currentTimeMillis() - it) / 1000).coerceAtLeast(0).toULong() },
            connectivity = when {
                networks.any { it.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL) } -> Connectivity.CaptivePortal(null)
                networks.none { it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) } -> Connectivity.Offline
                else -> null
            },
            policyReachable = policyReachable,
            notificationsAllowed = getSystemService(NotificationManager::class.java).areNotificationsEnabled(),
            locationAllowed = locationGranted(),
            portalSignInUntil = null,
        )
        health = diagnose(facts, now())
        val codes = health.map { it.code }
        if (!policyReachable || codes == reported) return
        try {
            val (code, body) = transport.send(diagnosticsRequest(identity, health))
            parseOk(code, body)
            reported = codes
        } catch (_: Exception) {}
    }

    private fun notifyChild(message: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("alerts", "Time and rules", NotificationManager.IMPORTANCE_DEFAULT))
        manager.notify(message.hashCode(), Notification.Builder(this, "alerts").setContentTitle("Temperance").setContentText(message).setSmallIcon(android.R.drawable.ic_dialog_info).setAutoCancel(true).build())
    }

    /** Answers a parent's one-time request with the freshest fix the OS already has. */
    private fun shareLocation(identity: Identity) {
        val request = if (!locationGranted()) {
            locationUnavailableRequest(identity, "location permission not granted")
        } else {
            val manager = getSystemService(LocationManager::class.java)
            val fix = try {
                manager.getProviders(true).mapNotNull { manager.getLastKnownLocation(it) }.maxByOrNull { it.time }
            } catch (_: SecurityException) { null }
            if (fix == null || System.currentTimeMillis() - fix.time > 15 * 60_000) locationUnavailableRequest(identity, "no recent location fix")
            else locationRequest(identity, fix.latitude, fix.longitude, fix.accuracy.toDouble())
        }
        val (code, body) = transport.send(request)
        parseOk(code, body)
        notifyChild("A parent viewed this device's location")
    }
    fun askForTime(minutes: UInt, message: String) {
        val identity = vault.load() ?: error("Enroll first")
        val (code, body) = transport.send(timeRequest(identity, minutes, message))
        parseTimeRequest(code, body)
        refresh()
        status = "Request sent to your parents."
    }
}
