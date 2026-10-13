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
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import uniffi.temperance_core.ChildStatus
import uniffi.temperance_core.Connectivity
import uniffi.temperance_core.DeviceFacts
import uniffi.temperance_core.Diagnostic
import uniffi.temperance_core.HttpRequest
import uniffi.temperance_core.Identity
import uniffi.temperance_core.ParentSummary
import uniffi.temperance_core.RemoteSession
import uniffi.temperance_core.RemoteSessionInterface
import uniffi.temperance_core.describeParentIdentity
import uniffi.temperance_core.pairParent
import uniffi.temperance_core.parsePairingLink
import uniffi.temperance_core.childAlerts
import uniffi.temperance_core.childStatus
import uniffi.temperance_core.diagnose
import uniffi.temperance_core.diagnosticsRequest
import uniffi.temperance_core.homeSend
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

/** AES-GCM encrypted text in private preferences, keyed by the Android Keystore. */
class Sealed(private val context: Context, private val file: String, private val key: () -> SecretKey = ::keystoreKey) {
    private val prefs get() = context.getSharedPreferences(file, Context.MODE_PRIVATE)
    @Synchronized fun read(): String? {
        val text = prefs.getString("identity", null) ?: return null
        val raw = Base64.decode(text, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        return String(cipher.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8)
    }
    @Synchronized fun write(text: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val raw = cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("identity", Base64.encodeToString(raw, Base64.NO_WRAP)).commit())
    }
    @Synchronized fun clear() { prefs.edit().clear().commit() }
}

/** The child device's identity. */
class Vault(context: Context, key: () -> SecretKey = ::keystoreKey) : IdentityStore {
    private val sealed = Sealed(context, "vault", key)
    override fun load(): Identity? = sealed.read()?.let(::identityFromJson)
    override fun save(identity: Identity) = sealed.write(identityToJson(identity))
    fun clear() = sealed.clear()
}

/** Sends a request built by the shared core to the home gateway: inside the tunnel while it is up, otherwise over QUIC. */
class HomeTransport(private val tunnelUp: () -> Boolean) : Transport {
    override fun send(request: HttpRequest): Pair<UShort, String> =
        homeSend(request, tunnelUp()).let { it.status to it.body }
}

open class TemperanceApp : Application() {
    val executor = Executors.newSingleThreadExecutor()
    lateinit var backend: Backend
    lateinit var vault: Vault
    /** Replaced by instrumentation tests with a scripted server. */
    @Volatile var transport: Transport = HomeTransport { connected }
    val setup get() = DeviceSetup({ transport.send(it) }, vault)
    @Volatile var status = ""
    @Volatile var child: ChildStatus? = null
    @Volatile var connected = false
    /** Recent alerts, newest first, also shown in the app: the child may have dismissed the notification. */
    @Volatile var alerts: List<Alert> = emptyList()
    data class Alert(val at: Long, val message: String)
    val tunnel = object : Tunnel {
        override fun getName() = "temperance"
        override fun onStateChange(newState: Tunnel.State) { connected = newState == Tunnel.State.UP }
    }
    protected open fun createBackend(): Backend = GoBackend(this)
    protected open fun createVault() = Vault(this)
    protected open fun createParentVault() = Sealed(this, "parent_vault")

    /** A parent's phone: the pairing (its key and the gateway's pinned key) and the running session. */
    lateinit var parentVault: Sealed
    /** Replaced by tests: both dial the home gateway. */
    var pairing: (String, String) -> String = { link, name -> pairParent(link, name) }
    var startRemote: (String) -> RemoteSessionInterface = { RemoteSession.start(it) }
    @Volatile private var remote: RemoteSessionInterface? = null
    /** `child` or `parent` once chosen on first launch. */
    var mode: String?
        get() = getSharedPreferences("ui", Context.MODE_PRIVATE).getString("mode", null)
        set(value) { getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("mode", value).apply() }
    val paired get() = parentVault.read() != null
    fun parent(): ParentSummary? = parentVault.read()?.let(::describeParentIdentity)
    fun pair(link: String, name: String) {
        val trimmed = link.trim()
        parsePairingLink(trimmed)
        parentVault.write(pairing(trimmed, name.trim()))
    }
    /** The dashboard address for the web view, starting the local proxy if needed. */
    @Synchronized fun openRemote(): String {
        val identity = parentVault.read() ?: error("Pair this phone first")
        return (remote ?: startRemote(identity).also { remote = it }).url()
    }
    @Synchronized fun closeRemote() { remote?.stop(); remote = null }
    fun unpair() { closeRemote(); parentVault.clear() }

    override fun onCreate() {
        super.onCreate(); vault = createVault(); parentVault = createParentVault(); backend = createBackend()
        GoBackend.setAlwaysOnCallback { startForegroundService(Intent(this, SessionService::class.java)) }
        vault.load()?.state?.let { child = childStatus(it, now()) }
    }
    private fun now() = System.currentTimeMillis() / 1000

    fun signIn(home: String, username: String, password: String, deviceName: String = "Android device") {
        val identity = setup.signIn(home, username, password, deviceName)
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
        status = ""
        alerts.forEach(::notifyChild)
        this.alerts = (alerts.reversed().map { Alert(System.currentTimeMillis(), it) } + this.alerts).take(5)
        if (latest.locationRequested) shareLocation(next)
        checkHealth(next, true)
    }

    @Volatile var health: List<Diagnostic> = emptyList()
    private var reported: List<String>? = null

    private fun locationGranted() = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        .any { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    /** Set once the child has been asked to share location; until then it isn't reported as off. */
    var askedLocation: Boolean
        get() = getSharedPreferences("ui", Context.MODE_PRIVATE).getBoolean("askedLocation", false)
        set(value) { getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putBoolean("askedLocation", value).apply() }

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
            locationAllowed = if (locationGranted()) true else if (askedLocation) false else null,
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
        manager.notify(message.hashCode(), Notification.Builder(this, "alerts").setContentText(message).setSmallIcon(android.R.drawable.ic_dialog_info).setAutoCancel(true).build())
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
