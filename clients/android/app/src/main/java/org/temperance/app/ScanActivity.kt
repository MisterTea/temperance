package org.temperance.app

import android.Manifest
import android.app.Activity
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

/** Scans a dashboard QR code (pairing, or a child's device setup) with CameraX and ML Kit, and returns the link. */
class ScanActivity : Activity(), LifecycleOwner {
    private val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry
    private val analysis = Executors.newSingleThreadExecutor()
    private lateinit var preview: PreviewView
    private var done = false

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
    override fun onDestroy() { registry.currentState = Lifecycle.State.DESTROYED; analysis.shutdown(); super.onDestroy() }

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
            .addOnSuccessListener(ContextCompat.getMainExecutor(this)) { codes -> codes.firstNotNullOfOrNull { it.rawValue }?.let(::found) }
            .addOnCompleteListener { image.close() }
    }

    /** Takes the first Temperance link of the requested kind; other QR codes are ignored. */
    fun found(text: String) {
        if (done || !text.startsWith(intent.getStringExtra(EXTRA_PREFIX) ?: PAIR_PREFIX)) return
        done = true
        setResult(RESULT_OK, Intent().putExtra(EXTRA_LINK, text))
        finish()
    }

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
