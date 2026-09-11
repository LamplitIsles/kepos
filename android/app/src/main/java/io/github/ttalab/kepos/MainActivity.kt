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
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.kepos.ui.KeposScreen

class MainActivity : ComponentActivity() {
  private var snapshot by mutableStateOf(RuntimeSnapshot(RuntimeState.STOPPED))
  private var subscription: AutoCloseable? = null
  private var bound = false
  private val runtimeStartPreference by lazy { RuntimeStartPreference(this) }
  private val requestNotificationPermission = registerForActivityResult(
    androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
  ) {
    KeposForegroundService.start(this)
  }
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, service: IBinder) {
      val binder = service as KeposForegroundService.LocalBinder
      subscription = binder.observe { snapshot = it }
    }

    override fun onServiceDisconnected(name: ComponentName) {
      subscription?.close()
      subscription = null
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
        onCopyText = { text -> copyText(text) },
        onOpenUrl = { url -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
      )
    }
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
    if (bound) unbindService(connection)
    bound = false
    super.onStop()
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
      ClipData.newPlainText("Kepos peer value", text),
    )
  }
}
