package org.temperance.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import uniffi.temperance_core.CoreException
import uniffi.temperance_core.HttpRequest

class HomeTransportTest {
    @Test fun `only speaks to a home's pinned WireGuard port, never the web`() {
        var asked = 0
        val transport = HomeTransport { asked++; false }
        for (url in listOf("https://family.example/v1/device/state", "temperance://family.example:51820/v1/device/state")) {
            assertThrows(url, CoreException::class.java) { transport.send(HttpRequest("GET", url, emptyList(), null)) }
        }
        assertEquals("the tunnel state is read for every request", 2, asked)
    }
}
