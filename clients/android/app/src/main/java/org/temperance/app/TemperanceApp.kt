package org.temperance.app

import android.app.Application
import android.content.Context
import android.content.Intent
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import org.json.JSONObject
import java.net.URL
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection

class Vault(private val context: Context) {
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("temperance", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("temperance", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun load(): JSONObject? {
        val text = context.getSharedPreferences("vault", Context.MODE_PRIVATE).getString("identity", null) ?: return null
        val raw = Base64.decode(text, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8))
    }
    @Synchronized fun save(data: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val raw = cipher.iv + cipher.doFinal(data.toString().toByteArray(Charsets.UTF_8))
        check(context.getSharedPreferences("vault", Context.MODE_PRIVATE).edit().putString("identity", Base64.encodeToString(raw, Base64.NO_WRAP)).commit())
    }
}

fun api(service: String, path: String, token: String = "", body: JSONObject? = null): JSONObject {
    val url = URL(service.trimEnd('/') + path)
    require(url.protocol == "https" && url.userInfo == null) { "Use an HTTPS policy service" }
    val connection = url.openConnection() as HttpsURLConnection
    connection.connectTimeout = 10000; connection.readTimeout = 10000; connection.instanceFollowRedirects = false
    if (token.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer $token")
    try {
        if (body != null) {
            connection.requestMethod = "POST"; connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        check(connection.responseCode == 200) { "Policy service returned ${connection.responseCode}" }
        return connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
    } finally { connection.disconnect() }
}

class TemperanceApp : Application() {
    val executor = Executors.newSingleThreadExecutor()
    lateinit var backend: GoBackend
    lateinit var vault: Vault
    @Volatile var status = "Enroll to install your family's VPN."
    val tunnel = object : Tunnel {
        override fun getName() = "temperance"
        override fun onStateChange(newState: Tunnel.State) { status = "VPN ${newState.name.lowercase()}" }
    }
    override fun onCreate() {
        super.onCreate(); vault = Vault(this); backend = GoBackend(this)
        GoBackend.setAlwaysOnCallback { startForegroundService(Intent(this, SessionService::class.java)) }
    }
    fun connect() {
        val identity = vault.load() ?: error("Enroll first")
        val state = identity.getJSONObject("state")
        val t = state.getJSONObject("tunnel")
        val privateKey = identity.getString("private_key")
        // Config.parse validates every field; route scope is fixed by the app.
        val config = """
            [Interface]
            PrivateKey = $privateKey
            Address = ${t.getString("address")}, ${t.getString("address_v6")}
            DNS = ${t.getString("dns")}
            [Peer]
            PublicKey = ${t.getString("public_key")}
            Endpoint = ${t.getString("endpoint")}
            AllowedIPs = 0.0.0.0/0, ::/0
            PersistentKeepalive = 25
        """.trimIndent()
        require(listOf(privateKey, t.getString("public_key"), t.getString("endpoint"), t.getString("address"), t.getString("address_v6"), t.getString("dns")).none { it.contains('\n') || it.contains('\r') })
        backend.setState(tunnel, Tunnel.State.UP, Config.parse(config.byteInputStream()))
    }
    fun refresh() {
        val identity = vault.load() ?: return
        val old = identity.optJSONObject("state") ?: return
        val state = api(identity.getString("service"), "/v1/device/state", old.getString("token"))
        state.put("token", old.getString("token")); identity.put("state", state); vault.save(identity)
        status = "Policy ${state.getInt("version")} · ${state.getJSONObject("policy").getInt("used")} activity minutes"
    }
}
