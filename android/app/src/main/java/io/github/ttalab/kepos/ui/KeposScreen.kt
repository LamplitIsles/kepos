package io.github.ttalab.kepos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState

@Composable
fun KeposScreen(
  snapshot: RuntimeSnapshot,
  onStart: () -> Unit,
  onStop: () -> Unit,
  onCopyText: (String) -> Unit,
  onOpenUrl: (String) -> Unit,
  onConfigure: (String) -> Unit = {},
  onScanPairing: () -> Unit = {},
) {
  val model = KeposUiModel.from(snapshot)
  KeposTheme {
    Surface(modifier = Modifier.fillMaxSize(), color = KeposPalette.Ink) {
      when (model.destination) {
        KeposDestination.SETUP -> SetupScreen(
          snapshot = snapshot,
          onConfigure = onConfigure,
          onScanPairing = onScanPairing,
          onCopyText = onCopyText,
        )
        KeposDestination.STOPPED -> StateScreen(
          title = "Kepos is off",
          detail = "Start the peer network to use configured services.",
          action = "Start",
          onAction = onStart,
        )
        KeposDestination.FAILED -> StateScreen(
          title = "Kepos stopped",
          detail = snapshot.error ?: "The peer network could not keep running.",
          action = "Retry",
          onAction = onStart,
        )
        KeposDestination.CONNECTING -> StateScreen(
          title = "Starting peer network",
          detail = "Loading the canonical peer configuration.",
          action = null,
          onAction = {},
          progress = true,
        )
        KeposDestination.SERVICES -> PeerHome(
          snapshot = snapshot,
          onStop = onStop,
          onCopyText = onCopyText,
          onOpenUrl = onOpenUrl,
        )
      }
    }
  }
}

@Composable
private fun StateScreen(
  title: String,
  detail: String,
  action: String?,
  onAction: () -> Unit,
  progress: Boolean = false,
) {
  Column(
    modifier = Modifier.fillMaxSize().padding(28.dp),
    verticalArrangement = Arrangement.Center,
  ) {
    Text("KEPOS", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(18.dp))
    Text(title, style = MaterialTheme.typography.headlineMedium)
    Spacer(Modifier.height(8.dp))
    Text(detail, style = MaterialTheme.typography.bodyLarge)
    Spacer(Modifier.height(22.dp))
    if (progress) CircularProgressIndicator()
    if (action != null) Button(onClick = onAction) { Text(action) }
  }
}

@Composable
private fun PeerHome(
  snapshot: RuntimeSnapshot,
  onStop: () -> Unit,
  onCopyText: (String) -> Unit,
  onOpenUrl: (String) -> Unit,
) {
  val model = KeposUiModel.from(snapshot)
  LazyColumn(
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(20.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    item {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Column {
          Text("Peer services", style = MaterialTheme.typography.headlineMedium)
          snapshot.publisher?.displayName?.let {
            Text("Publisher: $it", style = MaterialTheme.typography.bodyMedium)
          }
          Text(snapshot.connectionsSummary(), style = MaterialTheme.typography.bodyMedium)
        }
        OutlinedButton(onClick = onStop) { Text("Stop") }
      }
    }
    item {
      Column {
        Text("Peer identity", style = MaterialTheme.typography.titleMedium)
        Text(
          model.peerKey ?: "Identity unavailable",
          fontFamily = FontFamily.Monospace,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
        if (model.peerKey != null) {
          OutlinedButton(onClick = { onCopyText(model.peerKey) }) { Text("Copy key") }
        }
      }
    }
    if (model.error != null) item { Text(model.error, color = MaterialTheme.colorScheme.error) }
    item { Text("Configured services", style = MaterialTheme.typography.titleMedium) }
    if (model.services.isEmpty()) {
      item { Text("No services configured.", style = MaterialTheme.typography.bodyMedium) }
    } else {
      items(model.services) { service ->
        Column(modifier = Modifier.fillMaxWidth()) {
          Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(service.name, fontWeight = FontWeight.SemiBold)
            Text(if (service.available) "Available" else "Unavailable")
          }
          Text("${service.id} · ${service.kind}", style = MaterialTheme.typography.bodySmall)
          service.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
          val canAct = service.available && (
            service.action == ServiceAction.OPEN && service.url != null ||
              service.action != ServiceAction.OPEN && service.copyText != null
            )
          when (service.action) {
            ServiceAction.OPEN -> OutlinedButton(
              onClick = { service.url?.let(onOpenUrl) },
              enabled = canAct,
            ) { Text("Open") }
            ServiceAction.COPY_URL -> OutlinedButton(
              onClick = { service.copyText?.let(onCopyText) },
              enabled = canAct,
            ) { Text("Copy URL") }
            ServiceAction.COPY_COMMAND -> OutlinedButton(
              onClick = { service.copyText?.let(onCopyText) },
              enabled = canAct,
            ) { Text("Copy command") }
            ServiceAction.COPY_ENDPOINT -> OutlinedButton(
              onClick = { service.copyText?.let(onCopyText) },
              enabled = canAct,
            ) { Text("Copy endpoint") }
          }
        }
      }
    }
    item {
      Text("Local bindings: ${model.bindings}", style = MaterialTheme.typography.bodyMedium)
    }
  }
}

@Composable
private fun SetupScreen(
  snapshot: RuntimeSnapshot,
  onConfigure: (String) -> Unit,
  onScanPairing: () -> Unit,
  onCopyText: (String) -> Unit,
) {
  var publisherKey by rememberSaveable { mutableStateOf("") }
  Column(
    modifier = Modifier.fillMaxSize().padding(28.dp),
    verticalArrangement = Arrangement.Center,
  ) {
    Text("KEPOS", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(18.dp))
    Text("Connect this device", style = MaterialTheme.typography.headlineMedium)
    Spacer(Modifier.height(8.dp))
    Text(
      snapshot.error ?: "Choose a trusted peer by scanning its invitation or entering its public key.",
      style = MaterialTheme.typography.bodyLarge,
    )
    snapshot.subscriberPublicKey?.let { key ->
      Spacer(Modifier.height(18.dp))
      Text("Your peer key", style = MaterialTheme.typography.labelMedium)
      Text(
        key,
        fontFamily = FontFamily.Monospace,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
      OutlinedButton(onClick = { onCopyText(key) }) { Text("Copy key") }
    }
    Spacer(Modifier.height(18.dp))
    Button(onClick = onScanPairing, modifier = Modifier.fillMaxWidth()) {
      Text("Scan invitation")
    }
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(
      value = publisherKey,
      onValueChange = { value ->
        publisherKey = value.lowercase()
          .filter { character -> character in '0'..'9' || character in 'a'..'f' }
          .take(64)
      },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Peer public key") },
      keyboardOptions = KeyboardOptions(
        autoCorrectEnabled = false,
        keyboardType = KeyboardType.Ascii,
      ),
      singleLine = true,
    )
    Button(
      onClick = { onConfigure(publisherKey) },
      enabled = publisherKey.length == 64,
      modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
    ) { Text("Connect with key") }
  }
}

private fun RuntimeSnapshot.connectionsSummary(): String {
  val connected = connections.count { it.status == "connected" }
  return "$connected connected · ${connections.size} configured"
}
