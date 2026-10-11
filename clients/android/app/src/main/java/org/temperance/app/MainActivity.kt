package org.temperance.app
import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {
    private val app get() = application as TemperanceApp
    private lateinit var status: TextView
    private lateinit var headline: TextView
    private lateinit var detail: TextView
    private lateinit var health: TextView
    private lateinit var signIn: Button
    private lateinit var enrollment: LinearLayout
    private lateinit var enrolled: LinearLayout
    private val handler = Handler(Looper.getMainLooper())
    private val refreshUI = object : Runnable { override fun run() { render(); handler.postDelayed(this, 1000) } }

    private fun render() {
        status.text = app.status
        val child = app.child
        enrollment.visibility = if (child == null) View.VISIBLE else View.GONE
        enrolled.visibility = if (child == null) View.GONE else View.VISIBLE
        if (child != null) {
            headline.text = child.headline
            detail.text = listOfNotNull(
                child.detail,
                child.remainingMinutes?.let { "$it min left today" } ?: "No daily limit",
                child.nextChange,
                if (child.pendingRequest) "Your request is waiting for a parent." else null,
            ).joinToString("\n")
            val issues = app.health
            health.text = issues.joinToString("\n\n") { "${it.message}\n${it.action}" }
            health.visibility = if (issues.isEmpty()) View.GONE else View.VISIBLE
            signIn.visibility = if (issues.any { it.code == "captive_portal" || it.code == "gateway_unreachable" }) View.VISIBLE else View.GONE
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 80, 48, 48) }
        layout.addView(TextView(this).apply { text = "Temperance"; textSize = 32f })
        status = TextView(this).apply { textSize = 16f }; layout.addView(status)

        enrollment = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fun field(parent: LinearLayout, hint: String, secret: Boolean = false) = EditText(this).apply {
            this.hint = hint; if (secret) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; parent.addView(this)
        }
        val service = field(enrollment, "https://policy.example.com")
        val code = field(enrollment, "Enrollment code", true)
        val name = field(enrollment, "Device name")
        enrollment.addView(Button(this).apply { text = "Enroll device"; setOnClickListener {
            val values = Triple(service.text.toString(), code.text.toString(), name.text.toString())
            app.executor.execute { try { app.enroll(values.first, values.second, values.third) } catch (e: Exception) { app.status = e.message ?: "Enrollment failed" } }
        } })
        layout.addView(enrollment)

        enrolled = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        headline = TextView(this).apply { textSize = 24f }; enrolled.addView(headline)
        detail = TextView(this).apply { textSize = 16f }; enrolled.addView(detail)
        health = TextView(this).apply { textSize = 14f; setPadding(0, 24, 0, 24) }; enrolled.addView(health)
        // Android opens captive-portal sign-in outside the VPN from the Wi-Fi network entry.
        signIn = Button(this).apply { text = "Sign in to Wi-Fi"; setOnClickListener { startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) } }
        enrolled.addView(signIn)
        val message = field(enrolled, "Why do you need more time?")
        listOf(15u, 30u, 60u).forEach { minutes ->
            enrolled.addView(Button(this).apply { text = "Ask for $minutes more minutes"; setOnClickListener {
                val note = message.text.toString()
                app.executor.execute { try { app.askForTime(minutes, note) } catch (e: Exception) { app.status = e.message ?: "Request failed" } }
            } })
        }
        enrolled.addView(Button(this).apply { text = "Install / start VPN"; setOnClickListener {
            val intent = VpnService.prepare(this@MainActivity)
            if (intent != null) startActivityForResult(intent, 1) else startVPN()
        } })
        enrolled.addView(Button(this).apply { text = "Allow location requests from parents"; setOnClickListener {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.POST_NOTIFICATIONS), 2)
        } })
        enrolled.addView(Button(this).apply { text = "Always-on & lockdown settings"; setOnClickListener { startActivity(Intent(Settings.ACTION_VPN_SETTINGS)) } })
        layout.addView(enrolled)
        layout.addView(TextView(this).apply { text = "Enable Always-on VPN and Block connections without VPN in Android settings. For tamper resistance, a device owner must manage these settings. DNS filters cannot identify every encrypted DNS service." })
        setContentView(ScrollView(this).apply { addView(layout) })
    }
    private fun startVPN() { startForegroundService(Intent(this, SessionService::class.java)) }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) { super.onActivityResult(requestCode, resultCode, data); if (requestCode == 1 && resultCode == RESULT_OK) startVPN() }
    override fun onResume() { super.onResume(); handler.post(refreshUI) }
    override fun onPause() { handler.removeCallbacks(refreshUI); super.onPause() }
}
