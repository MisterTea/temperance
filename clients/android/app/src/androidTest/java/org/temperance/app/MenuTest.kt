package org.temperance.app

import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.Espresso.openActionBarOverflowOrOptionsMenu
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.action.ViewActions.scrollTo
import androidx.test.espresso.assertion.ViewAssertions.doesNotExist
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.isEnabled
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.hamcrest.Matchers.containsString
import org.hamcrest.Matchers.not
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.temperance.app.TestSupport.app
import org.temperance.app.TestSupport.device
import org.temperance.app.TestSupport.eventually
import org.temperance.app.TestSupport.tapSystem
import org.temperance.app.TestSupport.waitFor
import org.temperance.app.TestSupport.waitForScreen
import uniffi.temperance_core.Diagnostic
import uniffi.temperance_core.Severity

@RunWith(AndroidJUnit4::class)
class MenuTest {
    private lateinit var server: FakeServer
    private lateinit var scenario: ActivityScenario<MainActivity>

    @Before fun setUp() {
        server = TestSupport.reset()
        TestSupport.enrolled(server)
        TestSupport.shell("appops set ${TestSupport.PACKAGE} ACTIVATE_VPN allow")
        scenario = TestSupport.launch()
        waitForScreen(scenario, MainActivity.Screen.STATUS)
    }

    /** Taps a menu item whether it sits in the action bar or the overflow menu. */
    private fun menu(item: Int) {
        try {
            check(item == R.string.menu_refresh)
            onView(withText(item)).perform(click())
        } catch (_: Exception) {
            openActionBarOverflowOrOptionsMenu(TestSupport.instrumentation.targetContext)
            onView(withText(item)).perform(click())
        }
    }

    private fun opensSettingsAndReturns(item: Int) {
        menu(item)
        assertTrue("Settings opened", TestSupport.waitForPackage("com.android.settings"))
        device.pressBack()
        assertTrue("back in Temperance", TestSupport.waitForPackage(TestSupport.PACKAGE))
    }

    @Test fun everyMenuItemIsListedOnTheStatusScreen() {
        openActionBarOverflowOrOptionsMenu(TestSupport.instrumentation.targetContext)
        for (item in listOf(R.string.ask_time, R.string.wifi_sign_in, R.string.menu_vpn_settings, R.string.menu_location, R.string.menu_about)) {
            onView(withText(item)).check(matches(isDisplayed()))
        }
        TestSupport.screenshot("menu-overflow")
        device.pressBack()
        onView(withText(R.string.menu_refresh)).check(matches(isDisplayed()))
    }

    @Test fun setupScreensOnlyOfferAbout() {
        scenario.close()
        TestSupport.reset(server)
        TestSupport.launch()
        openActionBarOverflowOrOptionsMenu(TestSupport.instrumentation.targetContext)
        onView(withText(R.string.menu_about)).check(matches(isDisplayed()))
        onView(withText(R.string.menu_vpn_settings)).check(doesNotExist())
        onView(withText(R.string.menu_refresh)).check(doesNotExist())
    }

    @Test fun refreshFetchesTheLatestRules() {
        server.version = 9; server.remaining = 5
        menu(R.string.menu_refresh)
        waitFor(what = "refresh") { server.paths().contains("GET /v1/device/state") }
        eventually { onView(withId(R.id.detail)).check(matches(withText(containsString("5 minutes left today")))) }
        eventually { onView(withId(R.id.status_line)).check(matches(withText(R.string.refreshed))) }
    }

    @Test fun refreshFailureIsExplained() {
        server.unreachable = true
        menu(R.string.menu_refresh)
        eventually { onView(withId(R.id.status_line)).check(matches(withText("Can't reach the server. Check the address and your connection."))) }
    }

    @Test fun askForMoreTimeFromTheMenuSendsARequest() {
        menu(R.string.ask_time)
        onView(withText(R.string.minutes_30)).perform(click())
        onView(withId(R.id.time_message)).perform(replaceText("Finishing homework video"))
        closeSoftKeyboard()
        TestSupport.screenshot("menu-ask-time")
        onView(withText(R.string.send)).perform(click())
        waitFor(what = "time request") { server.paths().contains("POST /v1/device/requests") }
        val body = server.requests.first { it.url.endsWith("/v1/device/requests") }.body!!
        assertTrue(body, body.contains("\"minutes\":30") && body.contains("Finishing homework video"))
        eventually { onView(withId(R.id.status_line)).check(matches(withText(R.string.request_sent))) }
        eventually { onView(withId(R.id.detail)).check(matches(withText(containsString("waiting for a parent")))) }
        eventually { onView(withId(R.id.ask_time)).check(matches(not(isEnabled()))) }
    }

    @Test fun askForMoreTimeButtonAndCancel() {
        onView(withId(R.id.ask_time)).perform(scrollTo(), click())
        onView(withText(R.string.cancel)).perform(click())
        assertTrue(server.paths().none { it == "POST /v1/device/requests" })
        onView(withId(R.id.ask_time)).check(matches(isEnabled()))
    }

    @Test fun wifiSignInOpensWifiSettings() = opensSettingsAndReturns(R.string.wifi_sign_in)

    @Test fun alwaysOnVpnOpensVpnSettings() = opensSettingsAndReturns(R.string.menu_vpn_settings)

    @Test fun captivePortalShowsHealthCardAndWifiButton() {
        app.health = listOf(Diagnostic("captive_portal", Severity.WARNING, "This Wi-Fi needs you to sign in", "Tap Sign in to Wi-Fi, then come back"))
        eventually { onView(withId(R.id.health)).check(matches(withText(containsString("needs you to sign in")))) }
        onView(withId(R.id.wifi_sign_in)).perform(scrollTo(), click())
        assertTrue(TestSupport.waitForPackage("com.android.settings"))
        device.pressBack()
    }

    @Test fun locationSharingAsksForPermission() {
        TestSupport.shell("pm revoke ${TestSupport.PACKAGE} android.permission.ACCESS_FINE_LOCATION")
        TestSupport.shell("pm revoke ${TestSupport.PACKAGE} android.permission.ACCESS_COARSE_LOCATION")
        menu(R.string.menu_location)
        tapSystem("While using the app", "Only this time", "Allow")
        waitFor(what = "location permission") {
            app.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED
        }
    }

    @Test fun aboutShowsVersionAndServer() {
        menu(R.string.menu_about)
        onView(withText(containsString("Server https://family.example"))).check(matches(isDisplayed()))
        TestSupport.screenshot("menu-about")
        onView(withText(R.string.close)).perform(click())
        assertEquals(MainActivity.Screen.STATUS, TestSupport.onActivity(scenario) { it.screen })
    }
}
