package org.temperance.app

import uniffi.temperance_core.ChildStatus
import uniffi.temperance_core.CoreException
import uniffi.temperance_core.Diagnostic

object StatusText {
    fun error(e: Throwable): String = when (e) {
        is CoreException.Invalid -> e.detail
        is CoreException.Service -> e.detail
        is java.net.UnknownHostException -> "Can't find that server. Check the address."
        is javax.net.ssl.SSLException -> "The server's HTTPS certificate isn't trusted."
        is java.io.IOException -> "Can't reach the server. Check the address and your connection."
        else -> e.message ?: e.javaClass.simpleName
    }

    fun detail(child: ChildStatus): String = listOfNotNull(
        child.detail.takeIf { it.isNotBlank() },
        child.remainingMinutes?.let { if (it == 1u) "1 minute left today" else "$it minutes left today" } ?: "No daily limit",
        child.nextChange,
        if (child.pendingRequest) "Your request is waiting for a parent." else null,
    ).joinToString("\n")

    fun needsWifiSignIn(issues: List<Diagnostic>) = issues.any { it.code == "captive_portal" || it.code == "gateway_unreachable" }

    fun vpn(connected: Boolean, permission: Boolean) = when {
        !permission -> "VPN permission needed"
        connected -> "Family VPN connected"
        else -> "Family VPN not connected"
    }
}
