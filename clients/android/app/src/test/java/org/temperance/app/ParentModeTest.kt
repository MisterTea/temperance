package org.temperance.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.fakes.RoboMenu
import org.robolectric.shadows.ShadowToast
import uniffi.temperance_core.CoreException
import uniffi.temperance_core.RemoteSessionInterface
import uniffi.temperance_core.parsePairingLink

private fun link(json: String) = "temperance://pair#" + Base64.encodeToString(json.toByteArray(), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
private val LINK = link("""{"v":1,"host":"parkers.ddnsfree.com","port":51820,"pin":"PIN","code":"CODE","household":"The Parkers"}""")
private const val IDENTITY = """{"v":1,"host":"parkers.ddnsfree.com","port":51820,"pin":"PIN","key":"KEY","id":"par_1","name":"Pixel 9","household":"The Parkers"}"""

class FakeSession : RemoteSessionInterface {
    var stopped = false
    override fun stop() { stopped = true }
    override fun url() = "http://127.0.0.1:5555/__temperance/start?t=token"
}

@RunWith(RobolectricTestRunner::class)
class ParentModeTest {
    private val app = TestApp.current
    private val sessions = mutableListOf<FakeSession>()
    private val paired = mutableListOf<Pair<String, String>>()
    private var main: ActivityController<MainActivity>? = null
    private var parent: ActivityController<ParentActivity>? = null

    @Before fun fakeHome() {
        app.pairing = { link, name -> paired += link to name; IDENTITY }
        app.startRemote = { FakeSession().also { sessions += it } }
    }
    @After fun close() {
        main?.pause()?.stop()?.destroy()
        parent?.pause()?.stop()?.destroy()
    }

    private fun launchMain() = Robolectric.buildActivity(MainActivity::class.java).setup().also { main = it }.get()
    private fun launchParent() = Robolectric.buildActivity(ParentActivity::class.java).setup().also { parent = it }.get()
    private fun <T : View> Activity.view(id: Int): T = findViewById(id)
    private fun Activity.next() = shadowOf(this).nextStartedActivity?.component?.className

    @Test fun `parses the dashboard's pairing link`() {
        val parsed = parsePairingLink(LINK)
        assertEquals("parkers.ddnsfree.com", parsed.host)
        assertEquals(51820.toUShort(), parsed.port)
        val error = runCatching { parsePairingLink("https://example.com") }.exceptionOrNull()
        assertTrue(error is CoreException && StatusText.error(error).contains("not a Temperance pairing code"))
    }

    @Test fun `a fresh install asks whether this is a child's device or a parent's`() {
        val activity = launchMain()
        assertEquals(MainActivity.Screen.CHOOSE, activity.screen)
        activity.view<Button>(R.id.choose_child).performClick()
        assertEquals("child", app.mode)
        assertEquals(MainActivity.Screen.SETUP, activity.screen)
        activity.view<Button>(R.id.parent_instead).performClick()
        assertEquals("parent", app.mode)
        assertEquals(ParentActivity::class.java.name, activity.next())
        assertTrue(activity.isFinishing)
    }

    @Test fun `choosing parent never asks for the VPN`() {
        val activity = launchMain()
        activity.view<Button>(R.id.choose_parent).performClick()
        val started = generateSequence { shadowOf(activity).nextStartedActivityForResult }.toList()
        assertEquals(listOf(ParentActivity::class.java.name), started.map { it.intent.component?.className })
        assertTrue(started.none { it.requestCode == MainActivity.REQUEST_VPN })
    }

    @Test fun `a paired phone opens straight to the dashboard`() {
        app.parentVault.write(IDENTITY)
        val activity = launchMain()
        assertEquals(ParentActivity::class.java.name, activity.next())
        val dashboard = launchParent()
        assertEquals("The Parkers", dashboard.title)
        assertEquals(FakeSession().url(), shadowOf(dashboard.web!!).lastLoadedUrl)
        assertTrue(dashboard.web!!.settings.javaScriptEnabled)
    }

    @Test fun `pairs by pasting the link, then shows the dashboard`() {
        val activity = launchParent()
        assertNull(activity.web)
        assertEquals("robolectric", activity.view<EditText>(R.id.phone_name).text.toString().lowercase().substringAfterLast(' '))
        activity.view<EditText>(R.id.link).setText("nonsense")
        activity.view<Button>(R.id.pair).performClick()
        assertEquals(activity.getString(R.string.pairing), activity.view<Button>(R.id.pair).text)
        app.settle()
        assertTrue(activity.view<TextView>(R.id.error).text.contains("not a Temperance pairing code"))
        activity.view<EditText>(R.id.link).setText("  $LINK\n")
        activity.view<EditText>(R.id.phone_name).setText("Robin's Pixel")
        activity.view<Button>(R.id.pair).performClick()
        app.settle()
        assertEquals(listOf(LINK to "Robin's Pixel"), paired)
        assertEquals(IDENTITY, app.parentVault.read())
        assertEquals("par_1", app.parent()?.id)
        assertNotNull(activity.web)
        assertEquals(1, sessions.size)
    }

    @Test fun `shows why pairing failed`() {
        app.pairing = { _, _ -> throw CoreException.Service(403u, "That pairing code has expired or was already used.") }
        val activity = launchParent()
        activity.view<EditText>(R.id.link).setText(LINK)
        activity.view<EditText>(R.id.phone_name).onEditorAction(android.view.inputmethod.EditorInfo.IME_ACTION_GO)
        app.settle()
        assertEquals("That pairing code has expired or was already used.", activity.view<TextView>(R.id.error).text.toString())
        assertFalse(app.paired)
    }

    @Test fun `a scanned code pairs at once`() {
        val activity = launchParent()
        activity.view<Button>(R.id.scan).performClick()
        val scan = shadowOf(activity).nextStartedActivityForResult
        assertEquals(ScanActivity::class.java.name, scan.intent.component?.className)
        shadowOf(activity).receiveResult(scan.intent, Activity.RESULT_OK, Intent().putExtra(ScanActivity.EXTRA_LINK, LINK))
        app.settle()
        assertEquals(LINK, paired.single().first)
        assertNotNull(activity.web)
    }

    @Test fun `reloads, unpairs and keeps other sites out of the app`() {
        app.parentVault.write(IDENTITY)
        val activity = launchParent()
        val menu = RoboMenu(activity).also { activity.onCreateOptionsMenu(it); activity.onPrepareOptionsMenu(it) }
        assertTrue(menu.findItem(R.id.menu_unpair).isVisible)
        activity.onOptionsItemSelected(menu.findItem(R.id.menu_reload))
        assertTrue(sessions[0].stopped)
        assertEquals(2, sessions.size)

        val client = ParentActivity.LoopbackOnly(activity)
        assertFalse(client.leave(Uri.parse("http://127.0.0.1:5555/")))
        assertTrue(client.leave(Uri.parse("https://github.com/MisterTea/temperance")))
        assertEquals(Intent.ACTION_VIEW, shadowOf(activity).nextStartedActivity.action)

        activity.onOptionsItemSelected(menu.findItem(R.id.menu_unpair))
        activity.dialog!!.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertFalse(app.paired)
        assertTrue(sessions[1].stopped)
        assertNull(activity.web)
        assertNotNull(activity.findViewById(R.id.pair))
    }

    @Test fun `a broken pairing sends the phone back to pair again`() {
        app.parentVault.write(IDENTITY)
        app.startRemote = { throw CoreException.Invalid("This phone's pairing is damaged. Pair it again.") }
        val activity = launchParent()
        assertNull(activity.web)
        assertEquals("This phone's pairing is damaged. Pair it again.", activity.view<TextView>(R.id.error).text.toString())
    }

    @Test fun `a child's device can still be chosen from the pairing screen`() {
        app.mode = "parent"
        val activity = launchParent()
        activity.view<Button>(R.id.child_instead).performClick()
        assertEquals("child", app.mode)
        assertEquals(MainActivity::class.java.name, activity.next())
        assertTrue(activity.isFinishing)
    }

    @Test fun `the scanner asks for the camera and returns only pairing links`() {
        val controller = Robolectric.buildActivity(ScanActivity::class.java).setup()
        val scanner = controller.get()
        assertEquals(listOf(Manifest.permission.CAMERA), shadowOf(scanner).lastRequestedPermission.requestedPermissions.toList())
        scanner.found("https://example.com")
        assertFalse(scanner.isFinishing)
        scanner.found(LINK)
        assertTrue(scanner.isFinishing)
        assertEquals(LINK, shadowOf(scanner).resultIntent.getStringExtra(ScanActivity.EXTRA_LINK))
        controller.pause().stop().destroy()

        val denied = Robolectric.buildActivity(ScanActivity::class.java).setup()
        denied.get().onRequestPermissionsResult(ScanActivity.REQUEST_CAMERA, arrayOf(Manifest.permission.CAMERA), intArrayOf(-1))
        assertTrue(denied.get().isFinishing)
        assertEquals(Activity.RESULT_CANCELED, shadowOf(denied.get()).resultCode)
        assertEquals(app.getString(R.string.camera_needed), ShadowToast.getTextOfLatestToast())
        denied.pause().stop().destroy()
    }
}
