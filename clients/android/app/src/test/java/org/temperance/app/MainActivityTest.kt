package org.temperance.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Insets
import android.provider.Settings
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.RadioGroup
import android.widget.TextView
import com.google.android.material.textfield.TextInputLayout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.fakes.RoboMenu
import org.robolectric.shadows.ShadowToast
import org.robolectric.shadows.ShadowVpnService
import uniffi.temperance_core.Connectivity
import uniffi.temperance_core.DeviceFacts
import uniffi.temperance_core.diagnose

@RunWith(RobolectricTestRunner::class)
class MainActivityTest {
    private val app = TestApp.current
    private val server = FakeServer()
    private lateinit var controller: ActivityController<MainActivity>
    private val activity get() = controller.get()

    @Before fun useFakeServer() { app.transport = server; app.mode = "child"; ShadowVpnService.setPrepareResult(null) }
    @After fun close() { if (::controller.isInitialized) controller.pause().stop().destroy() }

    private fun launch() { controller = Robolectric.buildActivity(MainActivity::class.java).setup() }
    private fun <T : View> view(id: Int): T = activity.findViewById(id)
    private fun text(id: Int) = view<TextView>(id).text.toString()
    private fun visible(id: Int) = view<View>(id).visibility == View.VISIBLE
    private fun menu() = RoboMenu(activity).also { activity.onCreateOptionsMenu(it); activity.onPrepareOptionsMenu(it) }
    private fun select(id: Int) = activity.onOptionsItemSelected(menu().findItem(id))
    private fun nextActivity() = shadowOf(activity).nextStartedActivity?.action

    @Test fun `the password can be shown and masked again`() {
        launch()
        val layout = view<TextInputLayout>(R.id.password_layout)
        val password = view<EditText>(R.id.password)
        val reveal = layout.findViewById<View>(com.google.android.material.R.id.text_input_end_icon)
        assertEquals(TextInputLayout.END_ICON_PASSWORD_TOGGLE, layout.endIconMode)
        assertTrue(reveal.isShown)
        password.setText("correct horse")
        password.setSelection(password.length())
        assertTrue(password.transformationMethod is PasswordTransformationMethod)
        reveal.performClick()
        assertEquals(null, password.transformationMethod)
        assertEquals("correct horse", password.text.toString())
        assertEquals(password.length(), password.selectionEnd)
        reveal.performClick()
        assertTrue(password.transformationMethod is PasswordTransformationMethod)
    }

    @Test fun `signing in reports errors, then asks for the VPN and explains a refusal`() {
        ShadowVpnService.setPrepareResult(Intent("android.net.vpn.PREPARE"))
        launch()
        assertEquals(MainActivity.Screen.SETUP, activity.screen)
        assertFalse(menu().findItem(R.id.menu_refresh).isVisible)
        view<EditText>(R.id.server).setText(FakeServer.HOME)
        view<EditText>(R.id.username).setText("alex")
        view<EditText>(R.id.password).setText("wrong")
        view<Button>(R.id.sign_in).performClick()
        assertEquals(activity.getString(R.string.signing_in), text(R.id.sign_in))
        assertFalse(view<Button>(R.id.sign_in).isEnabled)
        app.settle()
        assertEquals("Invalid username or password", text(R.id.error))

        view<EditText>(R.id.password).setText("correct horse")
        view<EditText>(R.id.password).onEditorAction(EditorInfo.IME_ACTION_GO)
        app.settle()
        assertEquals("robolectric", server.enrolledName)
        assertEquals(MainActivity.Screen.VPN, activity.screen)
        assertEquals("the explanation shows before Android's dialog", null, shadowOf(activity).nextStartedActivityForResult)
        view<Button>(R.id.allow_vpn).performClick()
        val prepare = shadowOf(activity).nextStartedActivityForResult
        assertEquals(MainActivity.REQUEST_VPN, prepare.requestCode)
        shadowOf(activity).receiveResult(prepare.intent, Activity.RESULT_CANCELED, null)
        assertEquals(activity.getString(R.string.vpn_denied), text(R.id.error))

        controller.recreate()
        assertEquals("the refusal survives rotation", activity.getString(R.string.vpn_denied), text(R.id.error))

        view<Button>(R.id.allow_vpn).performClick()
        val again = shadowOf(activity).nextStartedActivityForResult
        ShadowVpnService.setPrepareResult(null)
        shadowOf(activity).receiveResult(again.intent, Activity.RESULT_OK, null)
        assertEquals(MainActivity.Screen.STATUS, activity.screen)
        assertEquals(SessionService::class.java.name, shadowOf(activity).nextStartedService.component?.className)
        assertEquals(Manifest.permission.POST_NOTIFICATIONS, shadowOf(activity).lastRequestedPermission.requestedPermissions.single())
    }

    @Test fun `the status screen shows rules, health and Wi-Fi sign-in`() {
        app.signIn(FakeServer.HOME, "alex", "correct horse")
        launch()
        assertEquals(MainActivity.Screen.STATUS, activity.screen)
        assertEquals(SessionService::class.java.name, shadowOf(activity).nextStartedService.component?.className)
        assertEquals(app.child!!.headline, text(R.id.headline))
        assertEquals("the remaining time has its own line", app.child!!.detail, text(R.id.detail))
        assertEquals(StatusText.remaining(app.child!!), text(R.id.remaining))
        assertEquals(StatusText.vpn(false, true), text(R.id.vpn_state))
        assertFalse(visible(R.id.health))
        assertFalse(visible(R.id.wifi_sign_in))

        assertFalse(visible(R.id.next_change))
        assertFalse(visible(R.id.alerts))
        app.child = app.child!!.copy(nextChange = "Bedtime starts in 5 min")
        val at = java.util.GregorianCalendar(2026, 9, 12, 9, 5).timeInMillis
        app.alerts = listOf(TemperanceApp.Alert(at, "Your request for 30 minutes was approved"), TemperanceApp.Alert(at, "10 minutes left today"))
        app.connected = true
        app.health = diagnose(DeviceFacts(true, true, 600u, Connectivity.CaptivePortal(null), false, true, true, null), System.currentTimeMillis() / 1000)
        app.status = "Policy 3"
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1))
        assertEquals(StatusText.vpn(true, true), text(R.id.vpn_state))
        assertEquals("Bedtime starts in 5 min", text(R.id.next_change))
        assertTrue(visible(R.id.next_change))
        assertTrue(visible(R.id.alerts))
        val clock = android.text.format.DateFormat.getTimeFormat(activity).format(java.util.Date(at))
        val rows = view<android.view.ViewGroup>(R.id.alerts_list)
        assertEquals("one row per alert, newest first", listOf("Your request for 30 minutes was approved", "10 minutes left today"),
            (0 until rows.childCount).map { rows.getChildAt(it).findViewById<TextView>(R.id.alert_message).text.toString() })
        assertEquals(clock, rows.getChildAt(0).findViewById<TextView>(R.id.alert_time).text.toString())
        assertTrue(visible(R.id.health))
        assertTrue(text(R.id.health).contains(app.health.first().message))
        assertEquals("Policy 3", text(R.id.status_line))
        assertTrue(visible(R.id.wifi_sign_in))
        view<Button>(R.id.wifi_sign_in).performClick()
        assertEquals(Settings.ACTION_WIFI_SETTINGS, nextActivity())
    }

    @Test fun `asking for more time sends the chosen minutes`() {
        app.signIn(FakeServer.HOME, "alex", "correct horse")
        launch()
        view<Button>(R.id.ask_time).performClick()
        val dialog = activity.dialog!!
        dialog.findViewById<RadioGroup>(R.id.minutes).check(R.id.minutes_30)
        dialog.findViewById<EditText>(R.id.time_message).setText("homework")
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        app.settle()
        assertTrue(server.requests.last { it.url.endsWith("/v1/device/requests") }.body!!.contains("\"minutes\":30"))
        assertEquals("Request sent to your parents.", text(R.id.status_line))
        assertFalse("a pending request hides the button", visible(R.id.ask_time))
        assertFalse(menu().findItem(R.id.menu_ask_time).isEnabled)

        select(R.id.menu_ask_time)
        activity.dialog!!.findViewById<RadioGroup>(R.id.minutes).check(R.id.minutes_60)
        activity.dialog!!.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        app.settle()
        assertTrue(server.requests.last { it.url.endsWith("/v1/device/requests") }.body!!.contains("\"minutes\":60"))
    }

    @Test fun `the menu refreshes, opens settings, asks for location and shows about`() {
        app.signIn(FakeServer.HOME, "alex", "correct horse")
        launch()
        assertTrue(menu().findItem(R.id.menu_refresh).isVisible)
        server.version = 7
        assertTrue(select(R.id.menu_refresh))
        app.settle()
        assertEquals(activity.getString(R.string.refreshed), text(R.id.status_line))
        assertEquals(7uL, app.vault.load()?.state?.version)

        select(R.id.menu_wifi)
        assertEquals(Settings.ACTION_WIFI_SETTINGS, nextActivity())
        select(R.id.menu_vpn_settings)
        assertEquals(Settings.ACTION_VPN_SETTINGS, nextActivity())

        select(R.id.menu_location)
        assertTrue(app.askedLocation)
        val asked = shadowOf(activity).lastRequestedPermission
        assertEquals(MainActivity.REQUEST_LOCATION, asked.requestCode)
        activity.onRequestPermissionsResult(MainActivity.REQUEST_LOCATION, asked.requestedPermissions, intArrayOf(PackageManager.PERMISSION_GRANTED, PackageManager.PERMISSION_DENIED))
        assertEquals(activity.getString(R.string.location_on), ShadowToast.getTextOfLatestToast())
        activity.onRequestPermissionsResult(MainActivity.REQUEST_LOCATION, asked.requestedPermissions, intArrayOf(PackageManager.PERMISSION_DENIED, PackageManager.PERMISSION_DENIED))
        assertEquals(activity.getString(R.string.location_off), ShadowToast.getTextOfLatestToast())

        select(R.id.menu_about)
        val about = shadowOf(activity.dialog!!)
        assertTrue(about.message.contains("Home family.example:51820"))
        assertTrue(about.message.contains("Core "))
        assertFalse(activity.onOptionsItemSelected(RoboMenu(activity).add("other")))
    }

    @Config(qualifiers = "w1200dp-h800dp")
    @Test fun `content stays clear of system bars and the keyboard and is centred on wide screens`() {
        launch()
        val screen = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0)
        val insets = WindowInsets.Builder()
            .setInsets(WindowInsets.Type.systemBars(), Insets.of(0, 40, 0, 20))
            .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, 300))
            .build()
        screen.dispatchApplyWindowInsets(insets)
        val margins = screen.layoutParams as android.view.ViewGroup.MarginLayoutParams
        assertEquals(listOf(0, 40, 0, 300), listOf(margins.leftMargin, margins.topMargin, margins.rightMargin, margins.bottomMargin))

        shadowOf(android.os.Looper.getMainLooper()).idle()
        val column = view<View>(R.id.column)
        val expected = (screen.width - (640 * activity.resources.displayMetrics.density).toInt()) / 2
        assertTrue(expected > 0)
        assertEquals(expected, column.paddingStart)
        assertEquals(expected, column.paddingEnd)
    }
}
