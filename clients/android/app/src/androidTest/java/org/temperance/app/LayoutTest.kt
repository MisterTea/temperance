package org.temperance.app

import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.Espresso.openActionBarOverflowOrOptionsMenu
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.action.ViewActions.scrollTo
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.temperance.app.TestSupport.app
import org.temperance.app.TestSupport.device
import org.temperance.app.TestSupport.onActivity
import org.temperance.app.TestSupport.shell
import org.temperance.app.TestSupport.waitForScreen
import uniffi.temperance_core.Diagnostic
import uniffi.temperance_core.Severity

@RunWith(AndroidJUnit4::class)
class LayoutTest {
    /** [widthDp] and [fontScale] are what the activity must report before it is audited. */
    private class Display(val name: String, val widthDp: Int?, val fontScale: Float = 1f, val apply: () -> Unit)

    private fun phoneDisplay() { shell("wm size 1080x2400"); shell("wm density 420") }

    private val displays = listOf(
        Display("phone", 411) { phoneDisplay() },
        Display("small-phone", 360) { shell("wm size 720x1280"); shell("wm density 320") },
        Display("landscape", null) { device.setOrientationLeft() },
        Display("large-text", 411, 1.3f) { phoneDisplay(); shell("settings put system font_scale 1.3") },
        Display("largest-text", 411, 2.0f) { phoneDisplay(); shell("settings put system font_scale 2.0") },
        Display("tablet", 800) { shell("wm size 1600x2560"); shell("wm density 320") },
    )

    private val problems = mutableListOf<String>()
    private lateinit var server: FakeServer

    @Before fun setUp() {
        restoreDisplay()
        server = TestSupport.reset(FakeServer(family = listOf(1L to "Alexandria-Josephine Montgomery-Wellington")))
    }

    @After fun restoreDisplay() {
        shell("wm size reset"); shell("wm density reset"); shell("settings put system font_scale 1.0")
        device.setOrientationNatural(); device.unfreezeRotation()
        device.waitForIdle()
    }

    private fun settle() { device.waitForIdle(); Thread.sleep(1200); TestSupport.dismissNotResponding(); device.waitForIdle() }

    private fun audit(scenario: ActivityScenario<MainActivity>, label: String, dialog: Boolean = false) {
        settle()
        problems += onActivity(scenario) { activity ->
            val root = if (dialog) activity.dialog!!.window!!.decorView else activity.window.decorView
            LayoutAudit.problems(root, label)
        }
        TestSupport.screenshot("layout-$label")
    }

    private fun configured(scenario: ActivityScenario<MainActivity>, display: Display) = onActivity(scenario) { a ->
        val c = a.resources.configuration
        kotlin.math.abs(c.fontScale - display.fontScale) < 0.01f && (display.widthDp?.let { it == c.screenWidthDp } ?: (c.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE))
    }

    /** Runs [block] once per display, restoring the default display between runs. */
    private fun eachDisplay(scenario: ActivityScenario<MainActivity>, screen: MainActivity.Screen, block: (String) -> Unit) {
        for (display in displays) {
            restoreDisplay()
            display.apply()
            settle()
            if (!configured(scenario, display)) { display.apply(); settle() }
            try { TestSupport.waitFor(20_000, what = "${display.name} configuration") { configured(scenario, display) } } catch (e: AssertionError) { throw AssertionError("${e.message}; activity has ${onActivity(scenario) { it.resources.configuration }}") }
            settle()
            waitForScreen(scenario, screen)
            block(display.name)
        }
        assertTrue("Layout problems:\n" + problems.distinct().joinToString("\n"), problems.isEmpty())
    }

    private fun showKeyboard(scenario: ActivityScenario<MainActivity>) {
        onActivity(scenario) { a ->
            val field = a.findViewById<android.widget.EditText>(R.id.password)
            field.requestFocus()
            a.window.insetsController?.show(android.view.WindowInsets.Type.ime())
        }
        TestSupport.waitFor(what = "the on-screen keyboard") {
            onActivity(scenario) { it.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true }
        }
    }

    @Test fun setupScreen() {
        val scenario = TestSupport.launch()
        eachDisplay(scenario, MainActivity.Screen.SETUP) { name ->
            audit(scenario, "$name-setup")
            onView(withId(R.id.server)).perform(scrollTo(), replaceText(FakeServer.HOME))
            onView(withId(R.id.password)).perform(scrollTo(), replaceText("wrong"))
            closeSoftKeyboard()
            onView(withId(R.id.sign_in)).perform(scrollTo(), click())
            settle()
            audit(scenario, "$name-setup-error")
            showKeyboard(scenario)
            audit(scenario, "$name-setup-keyboard")
            closeSoftKeyboard()
        }
    }

    @Test fun vpnPermissionScreen() {
        TestSupport.enrolled(server)
        val scenario = TestSupport.launch()
        eachDisplay(scenario, MainActivity.Screen.VPN) { name -> audit(scenario, "$name-vpn") }
    }

    @Test fun statusScreenAndDialogs() {
        TestSupport.enrolled(server)
        shell("appops set ${TestSupport.PACKAGE} ACTIVATE_VPN allow")
        val scenario = TestSupport.launch()
        eachDisplay(scenario, MainActivity.Screen.STATUS) { name ->
            app.health = emptyList()
            audit(scenario, "$name-status")
            app.health = listOf(
                Diagnostic("captive_portal", Severity.WARNING, "This Wi-Fi needs you to sign in before the family VPN can connect", "Tap Sign in to Wi-Fi, finish signing in, then come back"),
                Diagnostic("notifications_off", Severity.INFO, "Notifications are off", "Turn on notifications so you know when time is almost up"),
            )
            app.status = "Can't reach your family's Temperance right now. The last rules stay in effect."
            audit(scenario, "$name-status-issues")
            onView(withId(R.id.ask_time)).perform(scrollTo(), click())
            audit(scenario, "$name-time-dialog", dialog = true)
            onActivity(scenario) { it.dialog!!.dismiss() }
            openActionBarOverflowOrOptionsMenu(TestSupport.instrumentation.targetContext)
            settle()
            TestSupport.screenshot("layout-$name-menu")
            val about = TestSupport.app.getString(R.string.menu_about)
            if (device.findObject(androidx.test.uiautomator.By.text(about)) == null) {
                androidx.test.uiautomator.UiScrollable(androidx.test.uiautomator.UiSelector().scrollable(true))
                    .scrollIntoView(androidx.test.uiautomator.UiSelector().text(about))
            }
            onView(withText(R.string.menu_about)).perform(click())
            audit(scenario, "$name-about-dialog", dialog = true)
            onActivity(scenario) { it.dialog!!.dismiss() }
            onView(withId(R.id.emergency_unlock)).perform(scrollTo(), click())
            audit(scenario, "$name-emergency-dialog", dialog = true)
            onActivity(scenario) { it.dialog!!.dismiss() }
        }
    }
}
