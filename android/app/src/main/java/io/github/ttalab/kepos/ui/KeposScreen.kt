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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
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
) {
  KeposTheme {
    Surface(modifier = Modifier.fillMaxSize(), color = KeposPalette.Ink) {
      when (KeposUiModel.from(snapshot).destination) {
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
      items(model.services, key = { it.id }) { service ->
        Column(modifier = Modifier.fillMaxWidth()) {
          Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(service.name, fontWeight = FontWeight.SemiBold)
            Text(if (service.available) "Available" else "Unavailable")
          }
          Text("${service.id} · ${service.kind}", style = MaterialTheme.typography.bodySmall)
          service.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
      }
    }
    item {
      Text("Local bindings: ${model.bindings}", style = MaterialTheme.typography.bodyMedium)
    }
  }
}

private fun RuntimeSnapshot.connectionsSummary(): String {
  val connected = connections.count { it.status == "connected" }
  return "$connected connected · ${connections.size} configured"
}
