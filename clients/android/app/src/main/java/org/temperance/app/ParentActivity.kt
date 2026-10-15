package org.temperance.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView

/** An admin's phone: pair once, then the family dashboard through the home gateway. */
class ParentActivity : Activity() {
    private val app get() = application as TemperanceApp
    private val handler = Handler(Looper.getMainLooper())
    private var busy = false
    /** The dashboard, once paired. */
    var web: WebView? = null
        private set
    var dialog: AlertDialog? = null
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (app.paired) showDashboard() else showPairing()
    }

    private fun showPairing() {
        web = null
        setContentView(R.layout.screen_pair)
        fitSystemBars(findViewById<ViewGroup>(android.R.id.content).getChildAt(0))
        title = getString(R.string.app_name)
        val link = findViewById<EditText>(R.id.link)
        val name = findViewById<EditText>(R.id.phone_name).apply { setText(defaultDeviceName()) }
        val pair = findViewById<Button>(R.id.pair)
        pair.setOnClickListener { pair(link.text.toString(), name.text.toString()) }
        name.setOnEditorActionListener { _, action, _ -> (action == EditorInfo.IME_ACTION_GO).also { if (it) pair.performClick() } }
        findViewById<Button>(R.id.scan).apply {
            visibility = if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) View.VISIBLE else View.GONE
            setOnClickListener { startActivityForResult(Intent(this@ParentActivity, ScanActivity::class.java), REQUEST_SCAN) }
        }
        findViewById<Button>(R.id.child_instead).setOnClickListener {
            app.mode = "child"
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }
        invalidateOptionsMenu()
    }

    private fun pair(link: String, name: String) {
        if (busy) return
        render(busy = true, error = null)
        app.executor.execute {
            val failure = try { app.pair(link, name); null } catch (e: Exception) { StatusText.error(e) }
            handler.post {
                render(busy = false, error = failure)
                if (failure == null) showDashboard()
            }
        }
    }

    private fun render(busy: Boolean, error: String?) {
        this.busy = busy
        val button = findViewById<Button?>(R.id.pair) ?: return
        button.isEnabled = !busy
        button.setText(if (busy) R.string.pairing else R.string.pair)
        findViewById<TextView>(R.id.error).apply { text = error; visibility = if (error == null) View.GONE else View.VISIBLE }
    }

    private fun showDashboard() {
        val url = try { app.openRemote() } catch (e: Exception) { return showPairing().also { render(false, StatusText.error(e)) } }
        title = app.parent()?.household?.takeIf { it.isNotBlank() } ?: getString(R.string.app_name)
        val view = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = LoopbackOnly(this@ParentActivity)
            loadUrl(url)
        }
        web = view
        val frame = FrameLayout(this).apply { addView(view, FrameLayout.LayoutParams(-1, -1)) }
        setContentView(frame)
        fitSystemBars(frame)
        invalidateOptionsMenu()
    }

    /** Pages from the local proxy stay in the app; links elsewhere open in the browser. */
    class LoopbackOnly(private val activity: Activity) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = leave(request.url)
        fun leave(url: Uri): Boolean {
            if (url.host == "127.0.0.1") return false
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, url)) }
            return true
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean { menuInflater.inflate(R.menu.parent, menu); return true }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        menu.findItem(R.id.menu_reload).isVisible = web != null
        menu.findItem(R.id.menu_unpair).isVisible = web != null
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.menu_reload -> { app.closeRemote(); showDashboard() }
            R.id.menu_unpair -> dialog = AlertDialog.Builder(this)
                .setTitle(R.string.menu_unpair)
                .setMessage(R.string.unpair_confirm)
                .setPositiveButton(R.string.unpair) { _, _ -> app.unpair(); showPairing() }
                .setNegativeButton(R.string.cancel, null)
                .show()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    @Deprecated("Activity back handling")
    override fun onBackPressed() {
        val view = web
        if (view != null && view.canGoBack()) view.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val link = data?.getStringExtra(ScanActivity.EXTRA_LINK)
        if (requestCode != REQUEST_SCAN || resultCode != RESULT_OK || link == null) return
        findViewById<EditText?>(R.id.link)?.apply {
            setText(link)
            visibility = View.GONE
        }
        findViewById<View>(R.id.link_label).visibility = View.GONE
        findViewById<EditText>(R.id.phone_name).apply {
            requestFocus()
            selectAll()
        }
    }

    override fun onDestroy() {
        if (isFinishing) app.closeRemote()
        super.onDestroy()
    }

    companion object {
        const val REQUEST_SCAN = 10
    }
}
