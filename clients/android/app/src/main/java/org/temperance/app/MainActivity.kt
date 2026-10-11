package org.temperance.app
import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.wireguard.crypto.KeyPair
import org.json.JSONObject
import java.net.URI

class MainActivity : Activity() {
    private val app get() = application as TemperanceApp
    private lateinit var status: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val refreshUI = object : Runnable { override fun run() { status.text = app.status; handler.postDelayed(this, 1000) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(36, 70, 36, 36) }
        layout.addView(TextView(this).apply { text = "Temperance"; textSize = 32f })
        status = TextView(this).apply { textSize = 16f }; layout.addView(status)
        fun field(hint: String, secret: Boolean = false) = EditText(this).apply { this.hint = hint; if (secret) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; layout.addView(this) }
        val service = field("https://policy.example.com")
        val code = field("Enrollment code", true)
        val name = field("Device name")
        layout.addView(Button(this).apply { text = "Enroll device"; setOnClickListener {
            val serviceText = service.text.toString().trim().trimEnd('/')
            val codeText = code.text.toString().trim(); val nameText = name.text.toString().trim()
            app.executor.execute {
                try {
                    require(URI(serviceText).scheme == "https" && URI(serviceText).rawUserInfo == null && URI(serviceText).rawQuery == null && URI(serviceText).rawFragment == null && (URI(serviceText).path.isNullOrEmpty())) { "Enter an HTTPS service origin" }
                    val previous = app.vault.load()
                    require(previous?.has("state") != true) { "Device already enrolled" }
                    val keys = KeyPair()
                    val identity = JSONObject().put("service", serviceText).put("private_key", keys.privateKey.toBase64())
                    app.vault.save(identity)
                    val state = api(serviceText, "/v1/enroll", body = JSONObject().put("code", codeText).put("name", nameText).put("public_key", keys.publicKey.toBase64()))
                    identity.put("state", state); app.vault.save(identity); app.status = "Enrolled. Tap Install VPN."
                } catch(e: Exception) { app.status = e.message ?: "Enrollment failed" }
            }
        } })
        layout.addView(Button(this).apply { text = "Install / start VPN"; setOnClickListener {
            val intent = VpnService.prepare(this@MainActivity)
            if (intent != null) startActivityForResult(intent, 1) else startVPN()
        } })
        layout.addView(Button(this).apply { text = "Always-on & lockdown settings"; setOnClickListener { startActivity(Intent(Settings.ACTION_VPN_SETTINGS)) } })
        layout.addView(TextView(this).apply { text = "Enable Always-on VPN and Block connections without VPN in Android settings. For tamper resistance, a device owner must manage these settings. DNS filters cannot identify every encrypted DNS service." })
        setContentView(layout)
    }
    private fun startVPN() { startForegroundService(Intent(this, SessionService::class.java)) }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) { super.onActivityResult(requestCode, resultCode, data); if (requestCode == 1 && resultCode == RESULT_OK) startVPN() }
    override fun onResume() { super.onResume(); handler.post(refreshUI) }
    override fun onPause() { handler.removeCallbacks(refreshUI); super.onPause() }
}
