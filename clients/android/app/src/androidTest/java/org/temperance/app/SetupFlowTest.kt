package org.temperance.app

import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.action.ViewActions.scrollTo
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.temperance.app.TestSupport.app
import org.temperance.app.TestSupport.launch
import org.temperance.app.TestSupport.onActivity
import org.temperance.app.TestSupport.tapSystem
import org.temperance.app.TestSupport.waitFor
import org.temperance.app.TestSupport.waitForScreen

@RunWith(AndroidJUnit4::class)
class SetupFlowTest {
    private lateinit var server: FakeServer

    @Before fun setUp() { server = TestSupport.reset() }

    private fun signIn(password: String = "correct horse") {
        onView(withId(R.id.server)).perform(replaceText("family.example"))
        onView(withId(R.id.username)).perform(replaceText("admin"))
        onView(withId(R.id.password)).perform(replaceText(password))
        closeSoftKeyboard()
        onView(withId(R.id.sign_in)).perform(scrollTo(), click())
    }

    @Test fun startupAsksForServerUsernameAndPassword() {
        val scenario = launch()
        assertEquals(MainActivity.Screen.SETUP, onActivity(scenario) { it.screen })
        onView(withText(R.string.setup_title)).check(matches(isDisplayed()))
        onView(withId(R.id.server)).check(matches(isDisplayed()))
        onView(withId(R.id.password)).check(matches(isDisplayed()))
        TestSupport.screenshot("flow-1-setup")
    }

    @Test fun wrongPasswordAndBadAddressesExplainWhatToFix() {
        launch()
        signIn("wrong")
        onView(withId(R.id.error)).check(matches(withText("Invalid username or password")))
        onView(withId(R.id.server)).perform(replaceText("http://family.example"))
        onView(withId(R.id.sign_in)).perform(scrollTo(), click())
        onView(withId(R.id.error)).check(matches(withText("Enter an HTTPS service origin")))
        server.unreachable = true
        onView(withId(R.id.server)).perform(replaceText("family.example"))
        onView(withId(R.id.sign_in)).perform(scrollTo(), click())
        onView(withId(R.id.error)).check(matches(withText("Can't reach the server. Check the address and your connection.")))
        TestSupport.screenshot("flow-2-error")
    }

    @Test fun signInEnrollsAsksForVpnPermissionAndConnects() {
        val scenario = launch()
        signIn()
        // Android's own VPN consent dialog, then the notification permission prompt.
        tapSystem("OK")
        tapSystem("Allow")
        waitForScreen(scenario, MainActivity.Screen.STATUS)
        assertEquals(1L, server.enrolledProfile)
        assertEquals(0, server.revoked)
        assertTrue(app.vpnPermission())
        waitFor(20_000, "the WireGuard tunnel to come up") { app.connected }
        onView(withId(R.id.vpn_state)).check(matches(withText("Family VPN connected")))
        onView(withId(R.id.headline)).check(matches(isDisplayed()))
        TestSupport.screenshot("flow-4-status")
    }

    @Test fun decliningVpnPermissionExplainsAndCanRetry() {
        val scenario = launch()
        signIn()
        tapSystem("Cancel")
        waitForScreen(scenario, MainActivity.Screen.VPN)
        onView(withId(R.id.error)).check(matches(withText(R.string.vpn_denied)))
        TestSupport.screenshot("flow-5-vpn-denied")
        onView(withId(R.id.allow_vpn)).perform(click())
        tapSystem("OK")
        waitForScreen(scenario, MainActivity.Screen.STATUS)
    }

    @Test fun setupSurvivesRotation() {
        val scenario = launch()
        signIn()
        tapSystem("Cancel")
        waitForScreen(scenario, MainActivity.Screen.VPN)
        TestSupport.device.setOrientationLeft()
        try {
            waitForScreen(scenario, MainActivity.Screen.VPN)
            onView(withId(R.id.allow_vpn)).check(matches(isDisplayed()))
        } finally { TestSupport.device.setOrientationNatural() }
    }
}
