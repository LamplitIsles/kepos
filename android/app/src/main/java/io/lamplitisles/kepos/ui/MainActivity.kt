package io.lamplitisles.kepos.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.lamplitisles.kepos.vpn.PeerVpn
import io.lamplitisles.kepos.vpn.PeerVpnError
import io.lamplitisles.kepos.vpn.PeerVpnState
import io.lamplitisles.kepos.vpn.Phase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

// An operation belongs to the app, not a particular Activity instance.
private val actions by lazy { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }
private val identityRecheck = IdentityRecheck()

/** A recheck belongs to the app, including across Activity recreation. */
internal class IdentityRecheck {
  var running by mutableStateOf(false)
    private set

  fun start(scope: CoroutineScope, action: suspend () -> Unit) {
    if (running) return
    running = true
    scope.launch {
      try { action() } finally { running = false }
    }
  }
}

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { MaterialTheme { Surface(modifier = Modifier.fillMaxSize()) { KeposApp() } } }
  }
}

@Composable
private fun KeposApp() {
  val context = LocalContext.current
  val controller = remember { PeerVpn.get(context.applicationContext) }
  val state by controller.state.collectAsStateWithLifecycle()
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  var invitationOpen by remember { mutableStateOf(false) }
  var permissionError by remember { mutableStateOf(false) }
  var pairingNeedsCheck by rememberSaveable { mutableStateOf(false) }
  var acknowledgementError by remember { mutableStateOf<PeerVpnError?>(null) }
  var acknowledging by remember { mutableStateOf(false) }
  val pairingUncertain = pairingNeedsCheck || isUnknownPairing(state.failure)
  fun recheckIdentity() = identityRecheck.start(actions) {
    val failure = controller.prepareIdentity()
    if (failure == null && controller.state.value.failure == PeerVpnError.LocalState) controller.dismissFailure()
  }

  LaunchedEffect(state.failure) {
    if (isUnknownPairing(state.failure)) pairingNeedsCheck = true
  }

  val permission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
    controller.refreshConsent()
    if (controller.state.value.consentGranted) {
      permissionError = false
      actions.launch { controller.connect() }
    } else {
      permissionError = true
    }
  }

  LaunchedEffect(controller) {
    if (state.publicKey == null && state.phase == Phase.Idle) controller.prepareIdentity()
  }
  DisposableEffect(lifecycle, controller) {
    val observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_RESUME) controller.refreshConsent()
    }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }

  Column(
    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text("Kepos", style = MaterialTheme.typography.headlineMedium)
    Text(vpnTitle(state.phase), style = MaterialTheme.typography.titleLarge)
    Text(receiverTitle(state), style = MaterialTheme.typography.bodyMedium)

    when {
      state.phase == Phase.Connected || state.phase == Phase.Connecting ->
        Button(onClick = { controller.disconnect() }) { Text("Disconnect") }
      state.phase == Phase.Pairing -> {
        Text("Pairing…")
        Button(onClick = { controller.disconnect() }) { Text("Stop pairing") }
      }
      state.phase == Phase.Disconnecting -> Text("Disconnecting…")
      identityRecheck.running -> Button(onClick = {}, enabled = false) { Text("Checking…") }
      state.publicKey == null ->
        Button(onClick = { actions.launch { controller.prepareIdentity() } }) { Text("Set up Kepos") }
      needsStateRecheck(state) && !pairingUncertain ->
        Button(onClick = { recheckIdentity() }) {
          Text("Recheck this device")
        }
      state.paired ->
        Button(onClick = {
          controller.dismissFailure()
          permissionError = false
          controller.refreshConsent()
          if (controller.state.value.consentGranted) {
            actions.launch { controller.connect() }
          } else {
            val intent = controller.consentIntent()
            if (intent == null) {
              controller.refreshConsent()
              if (controller.state.value.consentGranted) actions.launch { controller.connect() }
              else permissionError = true
            } else {
              try { permission.launch(intent) } catch (_: Exception) { permissionError = true }
            }
          }
        }, enabled = !pairingUncertain) { Text("Connect") }
      else ->
        Button(
          onClick = { controller.dismissFailure(); invitationOpen = true },
          enabled = !pairingUncertain,
        ) { Text("Pair with receiver") }
    }

    if (permissionError) {
      Text("Allow Kepos to use VPN in Android settings, then try again.", color = MaterialTheme.colorScheme.error)
    }
    state.failure?.let { failure ->
      if (!isUnknownPairing(failure)) Text(errorMessage(failure), color = MaterialTheme.colorScheme.error)
    }
    if (pairingUncertain) {
      Text(errorMessage(PeerVpnError.PairingOutcomeUnknown), color = MaterialTheme.colorScheme.error)
      acknowledgementError?.let { Text(errorMessage(it), color = MaterialTheme.colorScheme.error) }
      TextButton(enabled = !identityRecheck.running, onClick = { recheckIdentity() }) { Text("Recheck this device") }
      TextButton(enabled = !acknowledging, onClick = {
        acknowledging = true
        acknowledgementError = null
        actions.launch {
          val failure = controller.acknowledgeUnknownPairing()
          if (failure == null) pairingNeedsCheck = false else acknowledgementError = failure
          acknowledging = false
        }
      }) { Text("I checked with the receiver") }
    }
    state.publicKey?.let { key ->
      Text("Your public key", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
      Text("Use this key to identify this device to the receiver operator.")
      Text(key, style = MaterialTheme.typography.bodySmall)
      TextButton(onClick = {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Kepos public key", key))
      }, contentPadding = PaddingValues(0.dp)) { Text("Copy public key") }
    }
  }

  if (invitationOpen) {
    var invitation by remember { mutableStateOf("") }
    AlertDialog(
      onDismissRequest = { invitation = ""; invitationOpen = false },
      title = { Text("Pair with receiver") },
      text = {
        OutlinedTextField(
          value = invitation,
          onValueChange = { invitation = it },
          modifier = Modifier.fillMaxWidth(),
          label = { Text("Invitation code") },
          singleLine = true,
          visualTransformation = PasswordVisualTransformation(),
          keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
        )
      },
      confirmButton = {
        TextButton(enabled = invitation.isNotBlank(), onClick = {
          val code = invitation.trim()
          invitation = ""
          invitationOpen = false
          actions.launch { controller.pair(code) }
        }) { Text("Pair") }
      },
      dismissButton = {
        TextButton(onClick = { invitation = ""; invitationOpen = false }) { Text("Cancel") }
      },
    )
  }
}

internal fun isUnknownPairing(error: PeerVpnError?): Boolean =
  error == PeerVpnError.PairingOutcomeUnknown || error == PeerVpnError.PairingConflictUnknown

internal fun needsStateRecheck(state: PeerVpnState): Boolean =
  state.phase == Phase.Idle && state.publicKey != null && !state.paired && state.failure == PeerVpnError.LocalState

internal fun vpnTitle(phase: Phase): String = when (phase) {
  Phase.Idle, Phase.Pairing -> "VPN disconnected"
  Phase.Connecting -> "Connecting…"
  Phase.Connected -> "VPN on"
  Phase.Disconnecting -> "Disconnecting…"
}

internal fun receiverTitle(state: PeerVpnState): String = when {
  state.publicKey == null -> "Setup needed"
  !state.paired -> "Not paired"
  state.phase != Phase.Connected -> "Receiver configured"
  state.peers == null -> "Receiver status unavailable"
  state.peers.any { it.connected } -> "Receiver connected"
  else -> "Receiver not connected"
}

internal fun errorMessage(error: PeerVpnError): String = when (error) {
  PeerVpnError.LocalState -> "Kepos could not access its identity or configuration. Check storage and try again."
  PeerVpnError.IdentityInUse -> "This identity is already in use. Wait for the other operation to finish."
  PeerVpnError.UnusableInvitation -> "The invitation is invalid, expired, or already used. Ask for a new one."
  PeerVpnError.ReceiverUnavailable -> "The receiver could not be reached. Check your network and try again."
  PeerVpnError.ReceiverCapacity -> "The receiver has no free device or address slots. Ask its operator to review capacity."
  PeerVpnError.ReceiverRouteConflict -> "The receiver has an address conflict. Ask its operator to check the configuration."
  PeerVpnError.LocalAddressConflict -> "An address is already in use on this device. Ask the receiver operator for another address."
  PeerVpnError.RouteInspectionUnavailable -> "Kepos could not check this device's network addresses. Check your network and try again."
  PeerVpnError.PairingOutcomeUnknown, PeerVpnError.PairingConflictUnknown -> "Pairing may have succeeded. Ask the receiver operator to check authorized devices using your public key before trying another invitation."
  PeerVpnError.ReceiverExcludedAddress -> "This device has an excluded address. Ask the receiver operator to check its authorization."
  PeerVpnError.VpnPermissionRequired -> "Allow Kepos to use VPN in Android settings, then try again."
  PeerVpnError.Unpaired -> "Pair this device with a receiver before connecting."
  PeerVpnError.Busy -> "Wait for the current operation to finish."
  PeerVpnError.ProviderUnavailable -> "Kepos could not complete the VPN operation. Check your network and try again."
}
