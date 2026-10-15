package org.temperance.app

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.location.Location
import android.location.LocationManager
import com.wireguard.android.backend.Tunnel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class TemperanceAppTest {
    private val app = TestApp.current
    private val server = FakeServer()

    @Before fun useFakeServer() { app.transport = server }

    private fun signIn() = app.signIn(FakeServer.HOME, "alex", "correct horse", "Pixel 9")
    private fun notifications() = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications
        .map { it.extras.getString("android.text") }
    private fun bodies(path: String) = server.requests.filter { it.url.endsWith(path) }.map { it.body.orEmpty() }

    @Test fun `the vault keeps the identity encrypted and restores it at start-up`() {
        assertNull(app.vault.load())
        assertFalse(app.enrolled)
        signIn()
        val stored = app.getSharedPreferences("vault", Context.MODE_PRIVATE).getString("identity", null)!!
        assertFalse(stored.contains("device-token"))
        assertEquals("device-token", app.vault.load()?.state?.token)

        app.child = null
        app.onCreate()
        assertTrue(app.enrolled)
        assertEquals(40u, app.child?.remainingMinutes)

        app.vault.clear()
        assertNull(app.vault.load())
    }

    @Test fun `connect hands the core's tunnel to WireGuard and follows its state`() {
        assertEquals("Enroll first", assertThrows(IllegalStateException::class.java) { app.connect() }.message)
        signIn()
        app.connect()
        assertEquals(Tunnel.State.UP, app.wireGuard.state)
        assertEquals("192.0.2.1:51820", app.wireGuard.config!!.peers.single().endpoint.get().toString())
        assertTrue(app.connected)
        app.disconnect()
        assertEquals(Tunnel.State.DOWN, app.wireGuard.state)
        assertFalse(app.connected)
    }

    @Test fun `refresh saves the new policy, tells the child, and reports health only when it changes`() {
        app.refresh()
        assertTrue("nothing to refresh before sign-in", server.requests.isEmpty())
        signIn()
        app.connect()
        app.wireGuard.handshake = System.currentTimeMillis() - 5_000
        server.version = 4; server.remaining = 10
        app.status = "Can't reach your family's Temperance right now. The last rules stay in effect."
        app.refresh()
        assertEquals("a successful refresh clears the status line", "", app.status)
        assertEquals(10u, app.child?.remainingMinutes)
        assertEquals(4uL, app.vault.load()?.state?.version)
        assertEquals(listOf("10 minutes left today"), notifications())
        assertEquals("alerts are kept for the app too", listOf("10 minutes left today"), app.alerts.map { it.message })
        assertEquals(1, bodies("/v1/device/diagnostics").size)

        app.wireGuard.handshake = null
        app.refresh()
        assertEquals("unchanged health is not reported again", 1, bodies("/v1/device/diagnostics").size)
        app.wireGuard.handshake = 0
        app.refresh()
        assertTrue(app.health.isNotEmpty())
        assertEquals(2, bodies("/v1/device/diagnostics").size)
    }

    @Test fun `an unreachable service shows in health and the error reaches the caller`() {
        signIn()
        server.unreachable = true
        assertThrows(java.io.IOException::class.java) { app.refresh() }
        assertTrue(app.health.isNotEmpty())
        assertTrue("nothing is reported while offline", bodies("/v1/device/diagnostics").isEmpty())
    }

    @Test fun `a parent's location request is answered with a recent fix or a reason`() {
        signIn()
        server.locationRequested = true
        app.refresh()
        assertTrue(bodies("/v1/device/location").last().contains("location permission not granted"))
        assertEquals("An admin viewed this device's location", notifications().last())

        shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        app.refresh()
        assertTrue(bodies("/v1/device/location").last().contains("no recent location fix"))

        val manager = shadowOf(app.getSystemService(LocationManager::class.java))
        manager.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
        manager.setLastKnownLocation(LocationManager.GPS_PROVIDER, Location(LocationManager.GPS_PROVIDER).apply {
            latitude = 41.88; longitude = -87.63; accuracy = 12f; time = System.currentTimeMillis()
        })
        app.refresh()
        assertTrue(bodies("/v1/device/location").last().contains("41.88"))
    }

    @Test fun `location sharing is only reported as off once the child has been asked`() {
        signIn()
        app.refresh()
        assertFalse(app.health.any { it.code == "location_off" })
        app.askedLocation = true
        app.refresh()
        assertTrue(app.health.any { it.code == "location_off" })
        shadowOf(app).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)
        app.refresh()
        assertFalse(app.health.any { it.code == "location_off" })
    }

    @Test fun `asking for time sends the request and shows it as pending`() {
        assertThrows(IllegalStateException::class.java) { app.askForTime(15u, "") }
        signIn()
        app.askForTime(30u, "homework")
        assertTrue(bodies("/v1/device/requests").single().contains("\"minutes\":30"))
        assertEquals("Request sent to your admins.", app.status)
        assertTrue(app.child!!.pendingRequest)
    }
}
