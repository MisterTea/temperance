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
    /** `home` is the dashboard's setup code (`temperance://home#…`): where home is and the gateway's pinned key. */
    fun signIn(home: String, username: String, password: String, deviceName: String = "Android device"): Identity {
        check(store.load()?.state == null) { "This device is already set up" }
        val service = validateService(home)
        val keys = generateKeypair()
        val (status, body) = transport.send(signInRequest(service, username, password, deviceName, keys.publicKey))
        return enrolledIdentity(service, keys, status, body).also(store::save)
    }
}
