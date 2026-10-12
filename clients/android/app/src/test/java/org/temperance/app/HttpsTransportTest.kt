package org.temperance.app

import javax.net.ssl.HttpsURLConnection
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import uniffi.temperance_core.Header
import uniffi.temperance_core.HttpRequest

class HttpsTransportTest {
    @Test fun `sends core requests over HTTPS and never follows redirects`() {
        val root = HeldCertificate.Builder().certificateAuthority(0).build()
        val leaf = HeldCertificate.Builder().signedBy(root).addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(leaf, root.certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(root.certificate).build()
        val previous = HttpsURLConnection.getDefaultSSLSocketFactory()
        MockWebServer().use { server ->
            server.useHttps(serverTls.sslSocketFactory(), false)
            server.enqueue(MockResponse().setBody("""{"ok":true}"""))
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://elsewhere.example/").setBody("moved"))
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Invalid username or password"}"""))
            server.enqueue(MockResponse().setResponseCode(204))
            HttpsURLConnection.setDefaultSSLSocketFactory(clientTls.sslSocketFactory())
            try {
                val url = server.url("/v1/device/login").newBuilder().host("localhost").build().toString()
                val post = HttpRequest("POST", url, listOf(Header("Content-Type", "application/json")), """{"a":1}""")
                assertEquals(200.toUShort() to """{"ok":true}""", HttpsTransport.send(post))
                server.takeRequest().let {
                    assertEquals("POST", it.method)
                    assertEquals("application/json", it.getHeader("Content-Type"))
                    assertEquals("""{"a":1}""", it.body.readUtf8())
                }
                val get = HttpRequest("GET", url, emptyList(), null)
                assertEquals("redirects are returned, not followed", 302.toUShort() to "", HttpsTransport.send(get))
                assertEquals(401.toUShort() to """{"error":"Invalid username or password"}""", HttpsTransport.send(get))
                assertEquals(204.toUShort() to "", HttpsTransport.send(get))
            } finally {
                HttpsURLConnection.setDefaultSSLSocketFactory(previous)
            }
        }
        assertThrows(ClassCastException::class.java) { HttpsTransport.send(HttpRequest("GET", "http://family.example/", emptyList(), null)) }
    }
}
