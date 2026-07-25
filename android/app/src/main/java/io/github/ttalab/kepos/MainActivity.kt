package io.github.ttalab.kepos

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.kepos.ui.KeposScreen

class MainActivity : ComponentActivity() {
  private var snapshot by mutableStateOf(RuntimeSnapshot(RuntimeState.STOPPED))
  private var subscription: AutoCloseable? = null
  private var service: KeposForegroundService.LocalBinder? = null
  private var bound = false
  private var pendingPairingInvitation: String? = null
  private val runtimeStartPreference by lazy { RuntimeStartPreference(this) }
  private val requestNotificationPermission = registerForActivityResult(
    ActivityResultContracts.RequestPermission(),
  ) {
    KeposForegroundService.start(this)
  }
  private val scanPairingInvitation = registerForActivityResult(ScanContract()) { result ->
    result.contents?.let(::queuePairingInvitation)
  }
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, service: IBinder) {
      val binder = service as KeposForegroundService.LocalBinder
      this@MainActivity.service = binder
      subscription = binder.observe {
        snapshot = it
        dispatchPendingPairing()
      }
    }

    override fun onServiceDisconnected(name: ComponentName) {
      subscription?.close()
      subscription = null
      service = null
      snapshot = RuntimeSnapshot(RuntimeState.STOPPED)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    setContent {
      KeposScreen(
        snapshot = snapshot,
        onStart = { startRuntime() },
        onStop = { KeposForegroundService.stop(this) },
        onConfigure = { publisherKey ->
          service?.configurePublisher(publisherKey)
        },
        onScanPairing = { scanPairingInvitation.launch(pairingScanOptions()) },
        onCopyText = { text -> copyText(text) },
        onOpenUrl = { url ->
          startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        },
      )
    }
    intent?.data?.toString()?.let(::acceptDeepLink)
  }

  override fun onStart() {
    super.onStart()
    bound = bindService(
      Intent(this, KeposForegroundService::class.java),
      connection,
      Context.BIND_AUTO_CREATE,
    )
    if (runtimeStartPreference.isEnabled()) startRuntime()
  }

  override fun onStop() {
    subscription?.close()
    subscription = null
    service = null
    if (bound) unbindService(connection)
    bound = false
    super.onStop()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    intent.data?.toString()?.let(::acceptDeepLink)
  }

  private fun startRuntime() {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
      return
    }
    KeposForegroundService.start(this)
  }

  private fun copyText(text: String) {
    getSystemService(ClipboardManager::class.java).setPrimaryClip(
      ClipData.newPlainText("Kepos service address", text),
    )
  }

  private fun acceptDeepLink(invitation: String) {
    val uri = Uri.parse(invitation)
    if (uri.scheme == "kepos" && uri.host == "pair") {
      queuePairingInvitation(invitation)
    }
  }

  private fun queuePairingInvitation(invitation: String) {
    pendingPairingInvitation = invitation
    startRuntime()
    dispatchPendingPairing()
  }

  private fun dispatchPendingPairing() {
    val invitation = pendingPairingInvitation ?: return
    if (snapshot.state != RuntimeState.RUNNING) return
    val binder = service ?: return
    pendingPairingInvitation = null
    binder.pairPublisher(invitation, Build.MODEL, "android").whenComplete { _, error ->
      if (error == null) return@whenComplete
      runOnUiThread {
        Toast.makeText(
          applicationContext,
          error.cause?.message ?: error.message ?: "Pairing failed",
          Toast.LENGTH_LONG,
        ).show()
      }
    }
  }

  private fun pairingScanOptions() = ScanOptions()
    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
    .setPrompt("Scan a Kepos invitation")
    .setBeepEnabled(false)
    .setOrientationLocked(false)
}
