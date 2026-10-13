package org.temperance.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.temperance_core.CoreException
import uniffi.temperance_core.identityToJson
import uniffi.temperance_core.tunnelConfig

class DeviceSetupTest {
    private val server = FakeServer()
    private val store = MemoryStore()
    private val setup = DeviceSetup(server, store)

    @Test fun `signs into the assigned user over the home's WireGuard port and keeps no password`() {
        val identity = setup.signIn("  ${FakeServer.HOME}\n", "alex", "correct horse", "Pixel 9")
        assertEquals(listOf("POST /v1/device/login"), server.paths())
        assertTrue(server.requests.single().url.startsWith("temperance://AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8@family.example:51820/"))
        assertEquals("Pixel 9", server.enrolledName)
        assertEquals("device-token", identity.state?.token)
        assertEquals(FakeServer.HOME, identity.service)
        assertEquals(identity, store.identity)
        assertTrue(tunnelConfig(identity.privateKey, identity.state!!.tunnel).contains("AllowedIPs = 0.0.0.0/0, ::/0"))
        assertFalse(identityToJson(identity).contains("correct horse"))
    }

    @Test fun `wrong password is reported plainly and saves nothing`() {
        val e = assertThrows(CoreException::class.java) { setup.signIn(FakeServer.HOME, "alex", "nope") }
        assertEquals("Invalid username or password", StatusText.error(e))
        assertNull(store.identity)
    }

    @Test fun `web addresses and missing fields are rejected before any request`() {
        for (address in listOf("family.example", "https://family.example", "")) {
            val e = assertThrows(CoreException::class.java) { setup.signIn(address, "alex", "correct horse") }
            assertTrue(StatusText.error(e), StatusText.error(e).startsWith("Scan or paste the setup code"))
        }
        assertThrows(CoreException::class.java) { setup.signIn(FakeServer.HOME, "alex", "") }
        assertTrue(server.requests.isEmpty())
    }

    @Test fun `unreachable servers are explained and save nothing`() {
        server.unreachable = true
        val e = assertThrows(java.io.IOException::class.java) { setup.signIn(FakeServer.HOME, "alex", "correct horse") }
        assertEquals("Can't reach the server. Check the address and your connection.", StatusText.error(e))
        assertNull(store.identity)
    }

    @Test fun `a signed-in device cannot be registered again`() {
        setup.signIn(FakeServer.HOME, "alex", "correct horse")
        assertThrows(IllegalStateException::class.java) { setup.signIn(FakeServer.HOME, "alex", "correct horse") }
        assertEquals(1, server.paths().size)
    }
}
