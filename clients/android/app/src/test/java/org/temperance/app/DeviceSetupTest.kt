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

    @Test fun `adds https when only the host name is typed`() {
        assertEquals("https://family.example", DeviceSetup.normalizeServer("  family.example "))
        assertEquals("http://family.example", DeviceSetup.normalizeServer("http://family.example"))
        assertEquals("", DeviceSetup.normalizeServer("   "))
    }

    @Test fun `signs into the assigned user and keeps no password`() {
        val identity = setup.signIn("family.example/", "alex", "correct horse", "Pixel 9")
        assertEquals(listOf("POST /v1/device/login"), server.paths())
        assertEquals("Pixel 9", server.enrolledName)
        assertEquals("device-token", identity.state?.token)
        assertEquals("https://family.example", identity.service)
        assertEquals(identity, store.identity)
        assertTrue(tunnelConfig(identity.privateKey, identity.state!!.tunnel).contains("AllowedIPs = 0.0.0.0/0, ::/0"))
        assertFalse(identityToJson(identity).contains("correct horse"))
    }

    @Test fun `wrong password is reported plainly and saves nothing`() {
        val e = assertThrows(CoreException::class.java) { setup.signIn("family.example", "alex", "nope") }
        assertEquals("Invalid username or password", StatusText.error(e))
        assertNull(store.identity)
    }

    @Test fun `plain http and missing fields are rejected before any request`() {
        val http = assertThrows(CoreException::class.java) { setup.signIn("http://family.example", "alex", "correct horse") }
        assertEquals("Enter an HTTPS service origin", StatusText.error(http))
        assertThrows(CoreException::class.java) { setup.signIn("family.example", "alex", "") }
        assertThrows(CoreException::class.java) { setup.signIn("", "alex", "correct horse") }
        assertTrue(server.requests.isEmpty())
    }

    @Test fun `unreachable servers are explained and save nothing`() {
        server.unreachable = true
        val e = assertThrows(java.io.IOException::class.java) { setup.signIn("family.example", "alex", "correct horse") }
        assertEquals("Can't reach the server. Check the address and your connection.", StatusText.error(e))
        assertNull(store.identity)
    }

    @Test fun `a signed-in device cannot be registered again`() {
        setup.signIn("family.example", "alex", "correct horse")
        assertThrows(IllegalStateException::class.java) { setup.signIn("family.example", "alex", "correct horse") }
        assertEquals(1, server.paths().size)
    }
}
