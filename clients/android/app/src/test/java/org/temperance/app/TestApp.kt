package org.temperance.app

import android.os.Looper
import com.wireguard.android.backend.Backend
import com.wireguard.android.backend.Statistics
import com.wireguard.android.backend.Tunnel
import com.wireguard.android.backend.statistics
import com.wireguard.config.Config
import com.wireguard.crypto.Key
import javax.crypto.spec.SecretKeySpec
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/** The app under Robolectric: a software vault key and a fake WireGuard backend (see robolectric.properties). */
class TestApp : TemperanceApp() {
    val wireGuard = FakeBackend()
    override fun createBackend() = wireGuard
    override fun createVault() = Vault(this) { SecretKeySpec(ByteArray(32) { it.toByte() }, "AES") }

    companion object {
        val current get() = RuntimeEnvironment.getApplication() as TestApp
    }
}

class FakeBackend : Backend {
    var state = Tunnel.State.DOWN
    var config: Config? = null
    /** Unix millis of the last handshake reported by getStatistics, or null to fail. */
    var handshake: Long? = 0
    override fun getRunningTunnelNames(): Set<String> = if (state == Tunnel.State.UP) setOf("temperance") else emptySet()
    override fun getState(tunnel: Tunnel) = state
    override fun getStatistics(tunnel: Tunnel): Statistics =
        statistics(Key.fromBase64(FakeServer.SERVER_KEY), handshake ?: error("no statistics"))
    override fun getVersion() = "test"
    override fun isAlwaysOn() = false
    override fun isLockdownEnabled() = false
    override fun setState(tunnel: Tunnel, state: Tunnel.State, config: Config?): Tunnel.State {
        this.state = state; this.config = config
        tunnel.onStateChange(state)
        return state
    }
}

/** Waits for work on the app's executor, then runs what it posted to the main thread. */
fun TemperanceApp.settle() {
    repeat(2) { executor.submit {}.get(); shadowOf(Looper.getMainLooper()).idle() }
}
