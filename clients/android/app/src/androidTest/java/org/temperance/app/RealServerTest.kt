package org.temperance.app

import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.action.ViewActions.scrollTo
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.HttpURLConnection
import java.net.URL
import org.hamcrest.Matchers.containsString
import org.hamcrest.Matchers.not
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.temperance.app.TestSupport.app
import org.temperance.app.TestSupport.eventually
import org.temperance.app.TestSupport.tapSystem
import org.temperance.app.TestSupport.waitFor
import org.temperance.app.TestSupport.waitForScreen

/** Runs only from e2e/real-server.sh, which passes the server URL, child credentials and the admin token. */
@RunWith(AndroidJUnit4::class)
class RealServerTest {
    private val args = InstrumentationRegistry.getArguments()

    @Test fun setsUpAgainstTheRealPolicyService() {
        val server = args.getString("server")
        assumeTrue("needs -e server", server != null)
        TestSupport.reset()
        app.transport = HttpsTransport

        val scenario = TestSupport.launch()
        onView(withId(R.id.server)).perform(replaceText(server!!.removePrefix("https://")))
        onView(withId(R.id.username)).perform(replaceText(args.getString("username")!!))
        onView(withId(R.id.password)).perform(replaceText("not the password"))
        closeSoftKeyboard()
        onView(withId(R.id.sign_in)).perform(scrollTo(), click())
        eventually { onView(withId(R.id.error)).check(matches(withText("Invalid username or password"))) }

        onView(withId(R.id.password)).perform(replaceText(args.getString("password")!!))
        closeSoftKeyboard()
        onView(withId(R.id.sign_in)).perform(scrollTo(), click())

        eventually { onView(withId(R.id.allow_vpn)).perform(click()) }
        tapSystem("OK")
        tapSystem("Allow")
        waitForScreen(scenario, MainActivity.Screen.STATUS)
        waitFor(20_000, "the WireGuard tunnel to come up") { app.connected }
        onView(withId(R.id.remaining)).check(matches(withText(containsString("60 minutes left today"))))
        TestSupport.screenshot("real-server-status")

        onView(withText(R.string.menu_refresh)).perform(click())
        eventually { onView(withId(R.id.status_line)).check(matches(withText(R.string.refreshed))) }

        // Real browsing through the embedded gateway: DNS on 10.77.0.1 and TCP relayed by the server.
        waitFor(30_000, "a page to load through the tunnel") { browse() }

        // The parent lowers the limit below the minutes the gateway has already counted.
        val riley = admin("GET", "api/state").getJSONArray("profiles").objects().first { it.getString("name") == "Riley" }
        admin("POST", "api/profiles", JSONObject().put("id", riley.getInt("id")).put("name", "Riley").put("limit", 1))
        waitFor(30_000, "browsing to be blocked once time ran out") { !browse() }
        onView(withText(R.string.menu_refresh)).perform(click())
        eventually { onView(withId(R.id.headline)).check(matches(withText("Time's up for today"))) }
        TestSupport.screenshot("real-server-time-up")

        onView(withId(R.id.ask_time)).perform(scrollTo(), click())
        onView(withText(R.string.minutes_30)).perform(click())
        onView(withText(R.string.send)).perform(click())
        eventually { onView(withId(R.id.status_line)).check(matches(withText(R.string.request_sent))) }
        eventually { onView(withId(R.id.remaining)).check(matches(withText(containsString("waiting for a parent")))) }
        TestSupport.screenshot("real-server-requested")
        assertTrue("still blocked while the request is pending", !browse())

        val request = admin("GET", "api/state").getJSONArray("requests").objects().first { it.getString("status") == "pending" }
        admin("POST", "api/requests", JSONObject().put("id", request.getString("id")).put("approve", true))
        waitFor(30_000, "browsing to come back after the reward") { browse() }
        onView(withText(R.string.menu_refresh)).perform(click())
        eventually { onView(withId(R.id.headline)).check(matches(not(withText("Time's up for today")))) }
        TestSupport.screenshot("real-server-restored")
    }

    private fun browse(): Boolean = runCatching {
        val connection = URL(args.getString("site") ?: "https://example.com/").openConnection() as HttpURLConnection
        connection.connectTimeout = 4_000
        connection.readTimeout = 4_000
        connection.useCaches = false
        connection.setRequestProperty("Connection", "close")
        try { connection.responseCode in 200..399 && connection.inputStream.readBytes().isNotEmpty() } finally { connection.disconnect() }
    }.getOrDefault(false)

    private fun admin(method: String, path: String, body: JSONObject? = null): JSONObject {
        val server = args.getString("server")!!
        val connection = URL("$server/$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.setRequestProperty("Authorization", "Bearer ${args.getString("admin")}")
        connection.setRequestProperty("Origin", server)
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        try {
            val text = (if (connection.responseCode < 400) connection.inputStream else connection.errorStream).bufferedReader().readText()
            assertTrue("$method $path: ${connection.responseCode} $text", connection.responseCode < 400)
            return JSONObject(text)
        } finally { connection.disconnect() }
    }

    private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
}
