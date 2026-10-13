package org.temperance.app

import uniffi.temperance_core.HttpRequest
import uniffi.temperance_core.Identity

/** A scripted Temperance service speaking the same JSON as the Next.js server. */
class FakeServer(
    var password: String = "correct horse",
    var family: List<Pair<Long, String>> = listOf(1L to "Alex", 2L to "Sam Longname-Example"),
) : Transport {
    val requests = mutableListOf<HttpRequest>()
    var reason = "allowed"
    var remaining = 40
    var version = 3
    var pending = false
    var revoked = 0
    var unreachable = false
    var locationRequested = false
    var enrolledProfile: Long? = null
    var enrolledName: String? = null

    fun paths() = requests.map { "${it.method} ${it.url.substringAfter("://").substringAfter('/').let { p -> "/$p" }}" }

    @Synchronized override fun send(request: HttpRequest): Pair<UShort, String> {
        requests += request
        if (unreachable) throw java.io.IOException("Unable to resolve host")
        val path = request.url.substringAfter("://").substringAfter('/').let { "/$it" }
        val body = request.body ?: ""
        val bearer = request.headers.firstOrNull { it.name == "Authorization" }?.value?.removePrefix("Bearer ")
        return when ("${request.method} $path") {
            "POST /v1/device/login" -> {
                if (!body.contains("\"password\":\"$password\"")) 401.toUShort() to """{"error":"Invalid username or password"}"""
                else { enrolledProfile = family.firstOrNull()?.first ?: 1L; enrolledName = Regex("\"name\":\"([^\"]*)\"").find(body)?.groupValues?.get(1); ok(state(token = true)) }
            }
            "GET /v1/device/state" -> ok(state(token = false))
            "POST /v1/device/requests" -> {
                pending = true
                val minutes = Regex("\"minutes\":(\\d+)").find(body)!!.groupValues[1]
                ok("""{"id":"r1","minutes":$minutes,"message":"","status":"pending","at":$NOW}""")
            }
            "POST /v1/device/diagnostics", "POST /v1/device/location" -> ok("{}")
            else -> 404.toUShort() to """{"error":"Not found"}"""
        }
    }

    private fun ok(body: String) = 200.toUShort() to body

    private fun state(token: Boolean): String {
        val name = family.firstOrNull { it.first == (enrolledProfile ?: 1L) }?.second ?: "Alex"
        val requests = if (pending) """[{"id":"r1","minutes":15,"message":"","status":"pending","at":$NOW}]""" else "[]"
        return """{${if (token) "\"token\":\"device-token\"," else ""}"device_id":"dev-1","version":$version,
            "policy":{"id":${enrolledProfile ?: 1},"name":"$name","limit":60,"used":${60 - remaining},"timezone":"UTC"},
            "tunnel":{"address":"10.77.0.2/32","address_v6":"fd77::2/128","dns":"10.77.0.1","endpoint":"192.0.2.1:51820","public_key":"$SERVER_KEY","allowed_ips":"0.0.0.0/0, ::/0","keepalive":25},
            "status":{"reason":"$reason","remaining_minutes":$remaining,"active_windows":[],"observed_at":$NOW},
            "requests":$requests,"location_requested":$locationRequested}"""
    }

    companion object {
        const val SERVER_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
        /** The dashboard's setup code for family.example:51820. */
        const val HOME = "temperance://home#eyJ2IjoxLCJob3N0IjoiZmFtaWx5LmV4YW1wbGUiLCJwb3J0Ijo1MTgyMCwicGluIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVhHQmthR3h3ZEhoOCIsImhvdXNlaG9sZCI6IlRoZSBSaXZlcmFzIn0"
        val NOW get() = System.currentTimeMillis() / 1000
    }
}

class MemoryStore(var identity: Identity? = null) : IdentityStore {
    override fun load() = identity
    override fun save(identity: Identity) { this.identity = identity }
}
