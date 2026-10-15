package org.temperance.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import uniffi.temperance_core.coreVersion
import uniffi.temperance_core.parseHomeLink

/** Edge-to-edge is enforced on Android 15+; keep content clear of bars and the keyboard and centred on tablets. */
internal fun Activity.fitSystemBars(screen: View) {
    val column = findViewById<View?>(R.id.column)
    val base = column?.paddingStart ?: 0
    fun centre(width: Int) {
        column ?: return
        val maxWidth = (640 * resources.displayMetrics.density).toInt()
        val side = maxOf(base, (width - maxWidth) / 2)
        if (side != column.paddingStart) column.setPaddingRelative(side, column.paddingTop, side, column.paddingBottom)
    }
    // The framework action bar already pads android.R.id.content; only the insets passed down remain.
    // Margins rather than padding, so ScrollView's scroll-to-focus keeps fields above the keyboard.
    screen.setOnApplyWindowInsetsListener { view, insets ->
        val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val ime = insets.getInsets(WindowInsets.Type.ime())
        val params = view.layoutParams as android.view.ViewGroup.MarginLayoutParams
        val bottom = maxOf(bars.bottom, ime.bottom)
        if (params.leftMargin != bars.left || params.topMargin != bars.top || params.rightMargin != bars.right || params.bottomMargin != bottom) {
            params.setMargins(bars.left, bars.top, bars.right, bottom)
            view.layoutParams = params
        }
        insets
    }
    screen.addOnLayoutChangeListener { _, l, _, r, _, ol, _, or, _ -> if (r - l != or - ol) screen.post { centre(r - l) } }
    screen.requestApplyInsets()
}

internal fun defaultDeviceName(): String {
    val model = Build.MODEL.orEmpty()
    val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
    return (if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model").trim().take(80).ifEmpty { "Android device" }
}

class MainActivity : Activity() {
    enum class Screen(val layout: Int) {
        CHOOSE(R.layout.screen_choose), SETUP(R.layout.screen_setup), VPN(R.layout.screen_vpn), STATUS(R.layout.screen_status)
    }

    private val app get() = application as TemperanceApp
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable { override fun run() { show(); handler.postDelayed(this, 1000) } }
    private var shown: Screen? = null
    private var busy = false
    private var error: String? = null
    private var vpnDenied = false

    val screen: Screen? get() = shown
    /** The dialog currently on screen, if any. */
    var dialog: AlertDialog? = null
        private set

    /** An admin's phone never asks for the VPN; an enrolled client device never leaves client mode. */
    private fun parentMode() = !app.enrolled && (app.paired || app.mode == "parent")

    private fun current() = when {
        !app.enrolled && app.mode == null -> Screen.CHOOSE
        !app.enrolled -> Screen.SETUP
        !app.vpnPermission() && !app.emergencyDisabled -> Screen.VPN
        else -> Screen.STATUS
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vpnDenied = savedInstanceState?.getBoolean("vpnDenied") ?: false
        show()
        if (app.enrolled && app.vpnPermission() && !app.emergencyDisabled) startVpn()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("vpnDenied", vpnDenied)
    }

    private fun show() {
        if (parentMode()) {
            handler.removeCallbacks(tick)
            startActivity(Intent(this, ParentActivity::class.java))
            return finish()
        }
        val next = current()
        if (next != shown) {
            val restore = shown == null
            shown = next
            if (!restore) error = null
            setContentView(next.layout)
            fitSystemBars((findViewById<android.view.ViewGroup>(android.R.id.content)).getChildAt(0))
            when (next) {
                Screen.CHOOSE -> bindChoose()
                Screen.SETUP -> bindSetup()
                Screen.VPN -> bindVpn()
                Screen.STATUS -> bindStatus()
            }
            invalidateOptionsMenu()
        }
        render()
    }

    private fun showError(view: TextView, message: String?) {
        view.text = message
        view.visibility = if (message == null) View.GONE else View.VISIBLE
    }

    private fun run(work: () -> Unit) {
        busy = true; error = null; render()
        app.executor.execute {
            val failure = try { work(); null } catch (e: Exception) { StatusText.error(e) }
            handler.post { busy = false; error = failure; show() }
        }
    }

    private fun bindSetup() {
        val server = findViewById<EditText>(R.id.server)
        val username = findViewById<EditText>(R.id.username)
        val password = findViewById<EditText>(R.id.password)
        val submit = findViewById<Button>(R.id.sign_in)
        submit.setOnClickListener {
            val values = Triple(server.text.toString(), username.text.toString(), password.text.toString())
            run { app.signIn(values.first, values.second, values.third, defaultDeviceName()) }
        }
        password.setOnEditorActionListener { _, action, _ -> (action == EditorInfo.IME_ACTION_GO).also { if (it) submit.performClick() } }
        findViewById<Button>(R.id.scan_setup).setOnClickListener {
            startActivityForResult(Intent(this, ScanActivity::class.java).putExtra(ScanActivity.EXTRA_PREFIX, ScanActivity.HOME_PREFIX), REQUEST_SCAN)
        }
        findViewById<Button>(R.id.parent_instead).setOnClickListener { app.mode = "parent"; show() }
    }

    private fun bindChoose() {
        findViewById<Button>(R.id.choose_child).setOnClickListener { app.mode = "child"; show() }
        findViewById<Button>(R.id.choose_parent).setOnClickListener { app.mode = "parent"; show() }
    }

    private fun bindVpn() {
        findViewById<Button>(R.id.allow_vpn).setOnClickListener { requestVpn() }
    }

    private fun requestVpn() {
        val intent = android.net.VpnService.prepare(this)
        if (intent == null) onVpnAllowed() else startActivityForResult(intent, REQUEST_VPN)
    }

    private fun onVpnAllowed() {
        vpnDenied = false
        if (app.emergencyDisabled) run { app.resumeProtection(); startVpn() } else startVpn()
        show()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            val prefs = getSharedPreferences("ui", Context.MODE_PRIVATE)
            if (!prefs.getBoolean("askedNotifications", false)) {
                prefs.edit().putBoolean("askedNotifications", true).apply()
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            }
        }
    }

    private fun startVpn() { startForegroundService(Intent(this, SessionService::class.java)) }

    private fun bindStatus() {
        findViewById<Button>(R.id.emergency_vpn_settings).setOnClickListener { startActivity(Intent(Settings.ACTION_VPN_SETTINGS)) }
        findViewById<Button>(R.id.emergency_unlock).setOnClickListener { emergencyUnlockDialog() }
        findViewById<Button>(R.id.resume_vpn).setOnClickListener {
            if (!app.vpnPermission()) requestVpn() else run { app.resumeProtection(); startVpn() }
        }
        findViewById<Button>(R.id.ask_time).setOnClickListener { askForTime() }
        findViewById<Button>(R.id.wifi_sign_in).setOnClickListener { openWifi() }
    }

    private fun render() {
        when (shown) {
            Screen.SETUP -> {
                val button = findViewById<Button>(R.id.sign_in)
                button.isEnabled = !busy
                button.setText(if (busy) R.string.signing_in else R.string.sign_in)
                showError(findViewById(R.id.error), error)
            }
            Screen.CHOOSE -> {}
            Screen.VPN -> showError(findViewById(R.id.error), if (vpnDenied) getString(R.string.vpn_denied) else error)
            Screen.STATUS -> renderStatus()
            null -> {}
        }
    }

    private fun renderStatus() {
        val child = app.child ?: return
        findViewById<TextView>(R.id.headline).text = child.headline
        findViewById<TextView>(R.id.detail).apply { text = child.detail; visibility = if (child.detail.isBlank()) View.GONE else View.VISIBLE }
        findViewById<TextView>(R.id.remaining).text = StatusText.remaining(child)
        findViewById<TextView>(R.id.next_change).apply { text = child.nextChange; visibility = if (child.nextChange.isNullOrBlank()) View.GONE else View.VISIBLE }
        val vpn = findViewById<TextView>(R.id.vpn_state)
        vpn.text = if (app.emergencyDisabled) "VPN turned off by an admin. Protection is off until you turn the VPN back on." else StatusText.vpn(app.connected, app.vpnPermission())
        findViewById<Button>(R.id.emergency_unlock).isEnabled = !busy
        findViewById<Button>(R.id.resume_vpn).isEnabled = !busy
        for (id in listOf(R.id.resume_vpn, R.id.emergency_vpn_settings, R.id.emergency_android_note)) {
            findViewById<View>(id).visibility = if (app.emergencyDisabled) View.VISIBLE else View.GONE
        }
        findViewById<View>(R.id.always_on_note).visibility = if (app.emergencyDisabled) View.GONE else View.VISIBLE
        vpn.compoundDrawableTintList = ColorStateList.valueOf(getColor(if (app.connected) R.color.brand else R.color.error))
        val issues = app.health
        val health = findViewById<TextView>(R.id.health)
        health.text = android.text.SpannableStringBuilder().apply {
            issues.forEachIndexed { i, issue ->
                if (i > 0) append("\n\n")
                val start = length
                append(issue.message)
                setSpan(android.text.style.StyleSpan(android.graphics.Typeface.BOLD), start, length, 0)
                append("\n").append(issue.action)
            }
        }
        health.visibility = if (issues.isEmpty()) View.GONE else View.VISIBLE
        findViewById<View>(R.id.wifi_sign_in).visibility = if (StatusText.needsWifiSignIn(issues)) View.VISIBLE else View.GONE
        val alerts = app.alerts
        val list = findViewById<ViewGroup>(R.id.alerts_list)
        if (list.tag != alerts) {
            val clock = android.text.format.DateFormat.getTimeFormat(this)
            list.removeAllViews()
            for (alert in alerts) {
                val row = layoutInflater.inflate(R.layout.alert_row, list, false)
                row.findViewById<TextView>(R.id.alert_time).text = clock.format(java.util.Date(alert.at))
                row.findViewById<TextView>(R.id.alert_message).text = alert.message
                list.addView(row)
            }
            list.tag = alerts
        }
        findViewById<View>(R.id.alerts).visibility = if (alerts.isEmpty()) View.GONE else View.VISIBLE
        findViewById<Button>(R.id.ask_time).apply {
            visibility = if (child.canRequestTime && !child.pendingRequest) View.VISIBLE else View.GONE
            isEnabled = !busy
        }
        val line = error ?: app.status
        findViewById<TextView>(R.id.status_line).apply { text = line; visibility = if (line.isBlank()) View.GONE else View.VISIBLE }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean { menuInflater.inflate(R.menu.main, menu); return true }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        val enrolled = shown == Screen.STATUS
        for (id in listOf(R.id.menu_refresh, R.id.menu_ask_time, R.id.menu_wifi, R.id.menu_vpn_settings, R.id.menu_location)) {
            menu.findItem(id).isVisible = enrolled
        }
        menu.findItem(R.id.menu_ask_time).isEnabled = app.child?.let { it.canRequestTime && !it.pendingRequest } ?: false
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.menu_refresh -> run { app.refresh(); app.status = getString(R.string.refreshed) }
            R.id.menu_ask_time -> askForTime()
            R.id.menu_wifi -> openWifi()
            R.id.menu_vpn_settings -> startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
            R.id.menu_location -> { app.askedLocation = true; requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQUEST_LOCATION) }
            R.id.menu_about -> about()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun emergencyUnlockDialog() {
        val input = EditText(this).apply {
            id = android.R.id.edit
            hint = "Household admin password"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        dialog = AlertDialog.Builder(this)
            .setTitle("Admin emergency unlock")
            .setMessage("Works even when the server is offline. Filtering and time limits stop until you turn the VPN back on. Android's Block connections without VPN setting must also be turned off by an admin if enabled.")
            .setView(input)
            .setNegativeButton(android.R.string.cancel) { _, _ -> input.text.clear() }
            .setPositiveButton("Turn off VPN") { _, _ ->
                val password = input.text.toString()
                input.text.clear()
                run { app.emergencyDisable(password) }
            }.create().also { it.setOnDismissListener { input.text.clear() }; it.show() }
    }

    private fun openWifi() { startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) }

    private fun askForTime() {
        val view = layoutInflater.inflate(R.layout.dialog_time, null)
        dialog = AlertDialog.Builder(this)
            .setTitle(R.string.time_title)
            .setView(view)
            .setPositiveButton(R.string.send) { _, _ ->
                val minutes = when (view.findViewById<RadioGroup>(R.id.minutes).checkedRadioButtonId) {
                    R.id.minutes_30 -> 30u
                    R.id.minutes_60 -> 60u
                    else -> 15u
                }
                val note = view.findViewById<EditText>(R.id.time_message).text.toString()
                run { app.askForTime(minutes, note) }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun about() {
        val version = packageManager.getPackageInfo(packageName, 0).versionName ?: ""
        val server = runCatching { parseHomeLink(app.vault.load()!!.service).let { "${it.host}:${it.port}" } }.getOrNull() ?: "not connected"
        dialog = AlertDialog.Builder(this)
            .setTitle(R.string.menu_about)
            .setMessage(getString(R.string.about_text, version, coreVersion(), server))
            .setPositiveButton(R.string.close, null)
            .show()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_SCAN) {
            val link = data?.getStringExtra(ScanActivity.EXTRA_LINK)
            if (resultCode == RESULT_OK && link != null && shown == Screen.SETUP) {
                findViewById<EditText>(R.id.server).setText(link)
                findViewById<EditText>(R.id.username).requestFocus()
            }
            return
        }
        if (requestCode != REQUEST_VPN) return
        if (resultCode == RESULT_OK) onVpnAllowed() else { vpnDenied = true; render() }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_LOCATION) {
            val granted = grantResults.any { it == PackageManager.PERMISSION_GRANTED }
            Toast.makeText(this, if (granted) R.string.location_on else R.string.location_off, Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() { super.onResume(); handler.post(tick) }
    override fun onPause() { handler.removeCallbacks(tick); super.onPause() }

    companion object {
        const val REQUEST_VPN = 1
        const val REQUEST_LOCATION = 2
        const val REQUEST_NOTIFICATIONS = 3
        const val REQUEST_SCAN = 4
    }
}
