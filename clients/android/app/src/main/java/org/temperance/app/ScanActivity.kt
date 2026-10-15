package org.temperance.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/** Scans a dashboard QR code (pairing, or a client's device setup) with CameraX and ML Kit, and returns the link. */
class ScanActivity : Activity(), LifecycleOwner {
    private val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry
    private val analysis = Executors.newSingleThreadExecutor()
    private lateinit var preview: PreviewView
    private var done = false
    private var announced: String? = null
    private var dialog: AlertDialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        registry.currentState = Lifecycle.State.CREATED
        preview = PreviewView(this)
        val hint = TextView(this).apply {
            setText(R.string.scan_hint)
            setTextColor(getColor(R.color.card))
            setShadowLayer(4f, 0f, 1f, getColor(R.color.ink))
            textSize = 16f
            gravity = Gravity.CENTER
        }
        setContentView(FrameLayout(this).apply {
            addView(preview, FrameLayout.LayoutParams(-1, -1))
            addView(hint, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { bottomMargin = (64 * resources.displayMetrics.density).toInt() })
        })
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
    }

    override fun onStart() { super.onStart(); registry.currentState = Lifecycle.State.STARTED }
    override fun onResume() { super.onResume(); registry.currentState = Lifecycle.State.RESUMED }
    override fun onPause() { registry.currentState = Lifecycle.State.STARTED; super.onPause() }
    override fun onStop() { registry.currentState = Lifecycle.State.CREATED; super.onStop() }
    override fun onDestroy() {
        dialog?.dismiss()
        registry.currentState = Lifecycle.State.DESTROYED
        analysis.shutdown()
        super.onDestroy()
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = runCatching { future.get() }.getOrElse { return@addListener refuse() }
            val view = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
            val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
            val frames = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            frames.setAnalyzer(analysis) { image -> scan(scanner, image) }
            provider.unbindAll()
            runCatching { provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, view, frames) }.onFailure { refuse() }
        }, ContextCompat.getMainExecutor(this))
    }

    @OptIn(ExperimentalGetImage::class)
    private fun scan(scanner: com.google.mlkit.vision.barcode.BarcodeScanner, image: ImageProxy) {
        val media = image.image ?: return image.close()
        scanner.process(InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees))
            .addOnSuccessListener(ContextCompat.getMainExecutor(this)) { codes ->
                val prefix = intent.getStringExtra(EXTRA_PREFIX) ?: PAIR_PREFIX
                val values = codes.mapNotNull { it.rawValue?.trim() }.filter { it.isNotEmpty() }
                val text = values.firstOrNull { it.startsWith(prefix) } ?: values.firstOrNull() ?: return@addOnSuccessListener
                found(text)
            }
            .addOnCompleteListener { image.close() }
    }

    /** Accepts a link of the requested kind. Any other code stays on screen, with an explanation. */
    fun found(text: String) {
        if (done) return
        val value = text.trim()
        if (value.isEmpty()) return
        val prefix = intent.getStringExtra(EXTRA_PREFIX) ?: PAIR_PREFIX
        if (value.startsWith(prefix)) {
            dialog?.dismiss()
            done = true
            setResult(RESULT_OK, Intent().putExtra(EXTRA_LINK, value))
            finish()
            return
        }
        if (value == announced || dialog?.isShowing == true) return
        announced = value
        dialog = AlertDialog.Builder(this)
            .setMessage(rejectMessage(prefix, value))
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun rejectMessage(expected: String, text: String) = getString(when {
        expected == PAIR_PREFIX && text.startsWith(HOME_PREFIX) -> R.string.scan_wrong_child
        expected == HOME_PREFIX && text.startsWith(PAIR_PREFIX) -> R.string.scan_wrong_parent
        expected == HOME_PREFIX -> R.string.scan_wrong_setup
        else -> R.string.scan_wrong_pair
    })

    private fun refuse() {
        Toast.makeText(this, R.string.camera_needed, Toast.LENGTH_LONG).show()
        setResult(RESULT_CANCELED)
        finish()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera() else refuse()
    }

    companion object {
        const val EXTRA_LINK = "link"
        const val EXTRA_PREFIX = "prefix"
        const val PAIR_PREFIX = "temperance://pair#"
        const val HOME_PREFIX = "temperance://home#"
        const val REQUEST_CAMERA = 11
    }
}
