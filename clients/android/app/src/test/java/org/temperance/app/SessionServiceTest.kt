package org.temperance.app

import android.app.Service
import com.wireguard.android.backend.Tunnel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class SessionServiceTest {
    private val app = TestApp.current

    @Test fun `runs in the foreground and connects the VPN when started`() {
        app.transport = FakeServer()
        val controller = Robolectric.buildService(SessionService::class.java).create()
        assertNotNull(shadowOf(controller.get()).lastForegroundNotification)
        assertNull(controller.get().onBind(null))

        assertEquals(Service.START_STICKY, controller.get().onStartCommand(null, 0, 1))
        app.settle()
        assertEquals("Enroll first", app.status)

        app.signIn(FakeServer.HOME, "alex", "correct horse")
        controller.startCommand(0, 2)
        app.settle()
        assertEquals(Tunnel.State.UP, app.wireGuard.state)
        controller.destroy()
    }
}
