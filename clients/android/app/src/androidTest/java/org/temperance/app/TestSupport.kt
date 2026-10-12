package org.temperance.app

import android.app.Activity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertTrue

object TestSupport {
    val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    val device: UiDevice get() = UiDevice.getInstance(instrumentation)
    val app get() = instrumentation.targetContext.applicationContext as TemperanceApp
    const val PACKAGE = "org.temperance.app"

    fun shell(command: String): String =
        instrumentation.uiAutomation.executeShellCommand(command).use { fd ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().readText()
        }

    /** The emulator's SystemUI sometimes stalls after display changes; never let that dialog steal focus. */
    fun dismissNotResponding() {
        repeat(3) {
            if (device.findObject(By.textContains("isn't responding")) == null) return
            device.findObject(By.text("Wait"))?.click()
            device.waitForIdle()
        }
    }

    /** Fresh, unenrolled app talking to a scripted server, with VPN consent revoked. */
    fun reset(server: FakeServer = FakeServer()): FakeServer {
        runCatching { app.disconnect() }
        app.vault.clear()
        app.child = null
        app.health = emptyList()
        app.status = ""
        app.transport = server
        app.getSharedPreferences("ui", android.content.Context.MODE_PRIVATE).edit().clear().commit()
        dismissNotResponding()
        shell("settings put secure show_ime_with_hard_keyboard 1")
        shell("appops set $PACKAGE ACTIVATE_VPN default")
        shell("pm revoke $PACKAGE android.permission.POST_NOTIFICATIONS")
        return server
    }

    /** Puts the app in the signed-in state without going through the form. */
    fun enrolled(server: FakeServer) { app.signIn("family.example", "alex", server.password, "Test phone") }

    fun launch(): ActivityScenario<MainActivity> = ActivityScenario.launch(MainActivity::class.java)

    fun <T> onActivity(scenario: ActivityScenario<MainActivity>, block: (MainActivity) -> T): T {
        var result: T? = null
        scenario.onActivity { result = block(it) }
        @Suppress("UNCHECKED_CAST") return result as T
    }

    fun waitFor(timeoutMs: Long = 10_000, what: String, condition: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (condition()) return
            Thread.sleep(100)
        }
        assertTrue("Timed out waiting for $what", condition())
    }

    /** Background work and the once-a-second render loop finish outside Espresso's idling sync. */
    fun eventually(timeoutMs: Long = 10_000, check: () -> Unit) {
        val end = System.currentTimeMillis() + timeoutMs
        while (true) {
            try { check(); return } catch (e: Throwable) {
                if (System.currentTimeMillis() > end) throw e
                Thread.sleep(200)
            }
        }
    }

    fun waitForScreen(scenario: ActivityScenario<MainActivity>, screen: MainActivity.Screen) =
        waitFor(what = "screen $screen") { onActivity(scenario) { it.screen } == screen }

    /** Taps a button in a system dialog (VPN consent, runtime permission). */
    fun tapSystem(vararg labels: String, timeoutMs: Long = 10_000) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            dismissNotResponding()
            for (label in labels) {
                val button = device.findObject(By.text(label)) ?: device.findObject(By.text(label.uppercase()))
                if (button != null) { button.click(); device.waitForIdle(); return }
            }
            Thread.sleep(200)
        }
        throw AssertionError("No system button ${labels.toList()} on screen")
    }

    fun foregroundPackage(): String = device.currentPackageName ?: ""

    fun waitForPackage(pkg: String) = device.wait(Until.hasObject(By.pkg(pkg).depth(0)), 10_000)

    /** Saved where the shell user can read them: adb pull /data/local/tmp/temperance-shots */
    fun screenshot(label: String) {
        device.waitForIdle()
        shell("mkdir -p /data/local/tmp/temperance-shots")
        shell("screencap -p /data/local/tmp/temperance-shots/${label.replace(Regex("[^A-Za-z0-9_-]+"), "-")}.png")
    }

    fun activityOf(scenario: ActivityScenario<MainActivity>): Activity = onActivity(scenario) { it }
}
