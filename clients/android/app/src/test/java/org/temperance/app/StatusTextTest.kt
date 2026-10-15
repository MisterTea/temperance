package org.temperance.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.temperance_core.ChildStatus
import uniffi.temperance_core.Diagnostic
import uniffi.temperance_core.Severity

class StatusTextTest {
    private fun child(remaining: UInt?, next: String? = null, pending: Boolean = false) =
        ChildStatus("You're online", "Rules are on.", true, 20u, remaining, next, pending, true)

    @Test fun `remaining time and pending request, without the rule or the next change`() {
        assertEquals("40 minutes left today", StatusText.remaining(child(40u)))
        assertEquals("1 minute left today\nYour request is waiting for an admin.",
            StatusText.remaining(child(1u, "Bedtime starts in 5 min", true)))
        assertEquals("No daily limit", StatusText.remaining(child(null)))
    }

    @Test fun `wifi sign-in is offered for captive portals and unreachable gateways`() {
        val portal = Diagnostic("captive_portal", Severity.WARNING, "Wi-Fi needs sign-in", "Open Wi-Fi settings")
        val other = Diagnostic("notifications_off", Severity.INFO, "Notifications are off", "Turn them on")
        val gateway = Diagnostic("gateway_unreachable", Severity.ERROR, "The VPN cannot reach your gateway", "Try Sign in to Wi-Fi")
        assertTrue(StatusText.needsWifiSignIn(listOf(gateway)))
        assertTrue(StatusText.needsWifiSignIn(listOf(other, portal)))
        assertFalse(StatusText.needsWifiSignIn(listOf(other)))
    }

    @Test fun `vpn state`() {
        assertEquals("VPN permission needed", StatusText.vpn(connected = true, permission = false))
        assertEquals("Family VPN connected", StatusText.vpn(connected = true, permission = true))
        assertEquals("Family VPN not connected", StatusText.vpn(connected = false, permission = true))
    }
}
