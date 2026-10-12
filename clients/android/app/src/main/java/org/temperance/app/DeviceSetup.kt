package org.temperance.app

import uniffi.temperance_core.HttpRequest
import uniffi.temperance_core.Identity
import uniffi.temperance_core.signInRequest
import uniffi.temperance_core.enrolledIdentity
import uniffi.temperance_core.generateKeypair
import uniffi.temperance_core.validateService

fun interface Transport { fun send(request: HttpRequest): Pair<UShort, String> }
interface IdentityStore { fun load(): Identity?; fun save(identity: Identity) }
/** The server assigns the authenticated user's profile. No admin session or password is saved. */
class DeviceSetup(private val transport: Transport, private val store: IdentityStore) {
    fun signIn(server: String, username: String, password: String, deviceName: String = "Android device"): Identity {
        check(store.load()?.state == null) { "This device is already set up" }
        val origin = validateService(normalizeServer(server))
        val keys = generateKeypair()
        val (status, body) = transport.send(signInRequest(origin, username, password, deviceName, keys.publicKey))
        return enrolledIdentity(origin, keys, status, body).also(store::save)
    }
    companion object {
        fun normalizeServer(raw: String): String { val trimmed=raw.trim();return if(trimmed.isEmpty()||"://" in trimmed)trimmed else "https://$trimmed" }
    }
}
