package io.github.ttalab.kepos.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ArrowLeft
import com.composables.icons.lucide.AudioLines
import com.composables.icons.lucide.BookOpen
import com.composables.icons.lucide.Box as BoxIcon
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.ExternalLink
import com.composables.icons.lucide.GitBranch
import com.composables.icons.lucide.Gauge
import com.composables.icons.lucide.Hammer
import com.composables.icons.lucide.Images
import com.composables.icons.lucide.DatabaseBackup
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Network
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.Settings
import com.composables.icons.lucide.SquareTerminal
import com.composables.icons.lucide.Unplug
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState

@Composable
fun KeposScreen(
  snapshot: RuntimeSnapshot,
  onStart: () -> Unit,
  onStop: () -> Unit,
  onConfigure: (String) -> Unit,
  onCopyText: (String) -> Unit,
  onOpenUrl: (String) -> Unit,
  onScanPairing: () -> Unit = {},
) {
  val model = KeposUiModel.from(snapshot)
  var showSettings by rememberSaveable { mutableStateOf(false) }
  var changingPublisher by rememberSaveable { mutableStateOf(false) }
  var confirmChange by rememberSaveable { mutableStateOf(false) }

  BackHandler(enabled = changingPublisher) {
    changingPublisher = false
    showSettings = true
  }
  BackHandler(enabled = showSettings) {
    showSettings = false
  }

  KeposTheme {
    Surface(
      modifier = Modifier.fillMaxSize(),
      color = KeposPalette.Ink,
    ) {
      when {
        changingPublisher -> SetupScreen(
          title = "Change publisher",
          subtitle = "Enter the public key for the publisher this phone should trust.",
          onBack = {
            changingPublisher = false
            showSettings = true
          },
          onConfigure = { key ->
            changingPublisher = false
            onConfigure(key)
          },
        )
        showSettings -> SettingsScreen(
          snapshot = snapshot,
          onBack = { showSettings = false },
          onChangePublisher = { confirmChange = true },
          onCopyText = onCopyText,
          onStop = onStop,
        )
        model.destination == KeposDestination.SETUP -> SetupScreen(
          title = "Bring your services here.",
          subtitle = snapshot.error
            ?: "Connect this phone to one trusted Kepos publisher.",
          subscriberPublicKey = snapshot.subscriberPublicKey,
          onCopyText = onCopyText,
          onConfigure = onConfigure,
          onScanPairing = onScanPairing,
        )
        model.destination == KeposDestination.SERVICES -> ServiceHome(
          model = model,
          onCopyText = onCopyText,
          onOpenUrl = onOpenUrl,
          onSettings = { showSettings = true },
        )
        model.destination == KeposDestination.FAILED -> ConnectionScreen(
          title = "Kepos stopped",
          detail = model.error ?: "The subscriber could not keep running.",
          action = "Retry",
          onAction = onStart,
          secondaryAction = "Diagnostics",
          onSecondaryAction = { showSettings = true },
        )
        model.destination == KeposDestination.STOPPED -> ConnectionScreen(
          title = "Kepos is off",
          detail = "Start the subscriber to reach your private services.",
          action = "Start",
          onAction = onStart,
        )
        else -> ConnectionScreen(
          title = connectionTitle(model.connection),
          detail = connectionDetail(model.connection),
          action = if (model.connection == "awaiting-approval") {
            "Scan another code"
          } else {
            null
          },
          onAction = onScanPairing,
          secondaryAction = "Settings",
          onSecondaryAction = { showSettings = true },
        )
      }
    }

    if (confirmChange) {
      AlertDialog(
        onDismissRequest = { confirmChange = false },
        title = { Text("Change publisher?") },
        text = {
          Text("This phone will stop using the current publisher after the new key is saved.")
        },
        confirmButton = {
          TextButton(onClick = {
            confirmChange = false
            showSettings = false
            changingPublisher = true
          }) { Text("Continue") }
        },
        dismissButton = {
          TextButton(onClick = { confirmChange = false }) { Text("Cancel") }
        },
      )
    }
  }
}

@Composable
private fun ServiceHome(
  model: KeposUiModel,
  onCopyText: (String) -> Unit,
  onOpenUrl: (String) -> Unit,
  onSettings: () -> Unit,
) {
  val contentAlpha = if (model.available) 1f else 0.42f
  LazyColumn(
    modifier = Modifier
      .fillMaxSize()
      .statusBarsPadding(),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(
      start = 20.dp,
      end = 20.dp,
      top = 14.dp,
      bottom = 24.dp,
    ),
  ) {
    item {
      BrandBar(onSettings)
      Spacer(Modifier.height(30.dp))
      ServiceHeader(
        connection = model.connection,
        serviceCount = model.services.size,
      )
      Spacer(Modifier.height(14.dp))
    }
    items(model.services, key = { service -> service.id }) { service ->
      ServiceListItem(
        service = service,
        available = model.available,
        modifier = Modifier.alpha(contentAlpha),
        onAction = {
          when (service.action) {
            ServiceAction.OPEN -> service.url?.let(onOpenUrl)
            ServiceAction.COPY_URL,
            ServiceAction.COPY_COMMAND,
            -> service.copyText?.let(onCopyText)
          }
        },
      )
    }
  }
}

@Composable
private fun BrandBar(onSettings: () -> Unit) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    PortalMark()
    Spacer(Modifier.width(12.dp))
    Text(
      text = "KEPOS",
      color = KeposPalette.Cream,
      fontFamily = KeposMono,
      fontWeight = FontWeight.SemiBold,
      fontSize = 15.sp,
      letterSpacing = 3.2.sp,
    )
    Spacer(Modifier.weight(1f))
    IconButton(onClick = onSettings) {
      Icon(
        imageVector = Lucide.Settings,
        contentDescription = "Settings",
        tint = KeposPalette.Muted,
      )
    }
  }
}

@Composable
private fun PortalMark() {
  Canvas(Modifier.size(width = 34.dp, height = 24.dp)) {
    val stroke = 2.dp.toPx()
    val scaleX = size.width / 40f
    val scaleY = size.height / 28f
    val portal = Path().apply {
      moveTo(15f * scaleX, 3f * scaleY)
      lineTo(4f * scaleX, 3f * scaleY)
      lineTo(4f * scaleX, 25f * scaleY)
      lineTo(15f * scaleX, 25f * scaleY)

      moveTo(25f * scaleX, 3f * scaleY)
      lineTo(36f * scaleX, 3f * scaleY)
      lineTo(36f * scaleX, 25f * scaleY)
      lineTo(25f * scaleX, 25f * scaleY)

      moveTo(10f * scaleX, 14f * scaleY)
      lineTo(30f * scaleX, 14f * scaleY)
    }
    drawPath(
      path = portal,
      color = KeposPalette.Lime,
      style = Stroke(width = stroke, cap = StrokeCap.Square),
    )
  }
}

@Composable
private fun ServiceHeader(connection: String?, serviceCount: Int) {
  Column {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.Bottom,
    ) {
      Column(modifier = Modifier.weight(1f)) {
        Text(
          text = "SUBSCRIBER",
          color = KeposPalette.Lime,
          style = MaterialTheme.typography.labelMedium,
        )
        Text(
          text = "Remote services",
          modifier = Modifier.padding(top = 4.dp),
          style = MaterialTheme.typography.headlineLarge.copy(
            fontSize = 34.sp,
            lineHeight = 38.sp,
          ),
        )
      }
      ConnectionStatus(connection)
    }
    Text(
      text = if (serviceCount == 1) "1 SERVICE" else "$serviceCount SERVICES",
      modifier = Modifier
        .fillMaxWidth()
        .padding(top = 12.dp, bottom = 10.dp),
      color = KeposPalette.Muted,
      style = MaterialTheme.typography.labelMedium,
    )
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .height(1.dp)
        .background(KeposPalette.Line),
    )
  }
}

@Composable
private fun ConnectionStatus(connection: String?) {
  Row(
    modifier = Modifier.padding(bottom = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Canvas(Modifier.size(7.dp)) {
      drawCircle(
        if (connection == "connected") KeposPalette.Lime else KeposPalette.Muted,
      )
    }
    Spacer(Modifier.width(8.dp))
    Text(
      text = statusLabel(connection).uppercase(),
      color = if (connection == "connected") KeposPalette.Lime else KeposPalette.Muted,
      style = MaterialTheme.typography.labelMedium.copy(fontSize = 10.sp),
    )
  }
}

@Composable
private fun ServiceListItem(
  service: ServiceUiModel,
  available: Boolean,
  modifier: Modifier = Modifier,
  onAction: () -> Unit,
) {
  Row(
    modifier = modifier
      .fillMaxWidth()
      .height(66.dp)
      .drawBehind {
        drawLine(
          color = KeposPalette.Line,
          start = Offset(0f, size.height),
          end = Offset(size.width, size.height),
          strokeWidth = 1.dp.toPx(),
        )
      },
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier = Modifier
        .size(34.dp)
        .border(1.dp, KeposPalette.Line, RoundedCornerShape(2.dp)),
      contentAlignment = Alignment.Center,
    ) {
      Icon(
        imageVector = serviceIcon(service.icon),
        contentDescription = null,
        tint = KeposPalette.LimeSoft,
        modifier = Modifier.size(18.dp),
      )
    }
    Spacer(Modifier.width(13.dp))
    Text(
      text = service.name,
      modifier = Modifier.weight(1f),
      style = MaterialTheme.typography.titleLarge.copy(
        fontSize = 15.sp,
        lineHeight = 20.sp,
      ),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    ServiceActionButton(service, available, onAction)
  }
}

@Composable
private fun ServiceActionButton(
  service: ServiceUiModel,
  available: Boolean,
  onAction: () -> Unit,
) {
  val label = when (service.action) {
    ServiceAction.OPEN -> "Open"
    ServiceAction.COPY_URL -> "Copy URL"
    ServiceAction.COPY_COMMAND -> "Copy command"
  }
  val icon = when (service.action) {
    ServiceAction.OPEN -> Lucide.ExternalLink
    ServiceAction.COPY_URL,
    ServiceAction.COPY_COMMAND,
    -> Lucide.Copy
  }
  OutlinedButton(
    onClick = onAction,
    enabled = available,
    shape = RoundedCornerShape(4.dp),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(
      horizontal = 11.dp,
      vertical = 7.dp,
    ),
  ) {
    Icon(icon, contentDescription = null, modifier = Modifier.size(15.dp))
    Spacer(Modifier.width(7.dp))
    Text(label, maxLines = 1)
  }
}

@Composable
private fun SetupScreen(
  title: String,
  subtitle: String,
  onConfigure: (String) -> Unit,
  onBack: (() -> Unit)? = null,
  subscriberPublicKey: String? = null,
  onCopyText: (String) -> Unit = {},
  onScanPairing: (() -> Unit)? = null,
) {
  var publisherKey by rememberSaveable { mutableStateOf("") }
  Column(
    modifier = Modifier
      .fillMaxSize()
      .statusBarsPadding()
      .padding(horizontal = 28.dp, vertical = 20.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      if (onBack != null) {
        IconButton(onClick = onBack) {
          Icon(Lucide.ArrowLeft, contentDescription = "Back")
        }
      } else {
        PortalMark()
      }
      Spacer(Modifier.width(12.dp))
      Text(
        "KEPOS",
        fontFamily = KeposMono,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 3.2.sp,
      )
    }
    Spacer(Modifier.height(86.dp))
    Text(title, style = MaterialTheme.typography.displayLarge)
    Text(
      subtitle,
      modifier = Modifier.padding(top = 18.dp),
      color = KeposPalette.Muted,
      style = MaterialTheme.typography.bodyLarge,
    )
    subscriberPublicKey?.let { key ->
      Spacer(Modifier.height(36.dp))
      Text(
        "THIS PHONE'S SUBSCRIBER KEY",
        color = KeposPalette.Lime,
        style = MaterialTheme.typography.labelMedium,
      )
      Text(
        fingerprint(key),
        modifier = Modifier.padding(top = 8.dp),
        color = KeposPalette.Cream,
        fontFamily = KeposMono,
        fontSize = 15.sp,
      )
      OutlinedButton(
        onClick = { onCopyText(key) },
        modifier = Modifier.padding(top = 8.dp),
        shape = RoundedCornerShape(4.dp),
      ) {
        Icon(Lucide.Copy, contentDescription = null, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text("Copy subscriber key")
      }
    }
    Spacer(Modifier.height(36.dp))
    if (onScanPairing != null) {
      Button(
        onClick = onScanPairing,
        modifier = Modifier
          .fillMaxWidth()
          .height(54.dp),
        shape = RoundedCornerShape(4.dp),
        colors = ButtonDefaults.buttonColors(
          containerColor = KeposPalette.Lime,
          contentColor = KeposPalette.Ink,
        ),
      ) {
        Text("Scan invitation")
      }
      Spacer(Modifier.height(28.dp))
    }
    Text(
      "OR ENTER PUBLISHER PUBLIC KEY",
      color = KeposPalette.Lime,
      style = MaterialTheme.typography.labelMedium,
    )
    OutlinedTextField(
      value = publisherKey,
      onValueChange = { value ->
        publisherKey = value
          .lowercase()
          .filter { character -> character.isDigit() || character in 'a'..'f' }
          .take(PUBLISHER_KEY_LENGTH)
      },
      modifier = Modifier
        .fillMaxWidth()
        .padding(top = 12.dp),
      placeholder = { Text("64-character key") },
      textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = KeposMono),
      keyboardOptions = KeyboardOptions(
        autoCorrectEnabled = false,
        keyboardType = KeyboardType.Ascii,
      ),
      singleLine = true,
    )
    Button(
      onClick = { onConfigure(publisherKey) },
      enabled = PUBLISHER_KEY.matches(publisherKey),
      modifier = Modifier
        .fillMaxWidth()
        .padding(top = 18.dp)
        .height(54.dp),
      shape = RoundedCornerShape(4.dp),
      colors = ButtonDefaults.buttonColors(
        containerColor = KeposPalette.PanelHigh,
        contentColor = KeposPalette.Cream,
      ),
    ) {
      Text("Connect")
    }
    Spacer(Modifier.weight(1f))
    Text(
      "One publisher. No account. No virtual subnet.",
      color = KeposPalette.Muted,
      style = MaterialTheme.typography.labelMedium,
    )
  }
}

@Composable
private fun ConnectionScreen(
  title: String,
  detail: String,
  action: String?,
  onAction: () -> Unit,
  secondaryAction: String? = null,
  onSecondaryAction: () -> Unit = {},
) {
  Column(
    modifier = Modifier
      .fillMaxSize()
      .statusBarsPadding()
      .padding(28.dp),
    verticalArrangement = Arrangement.Center,
  ) {
    PortalMark()
    Spacer(Modifier.height(42.dp))
    CircularProgressIndicator(
      modifier = Modifier.size(26.dp),
      color = KeposPalette.Lime,
      strokeWidth = 2.dp,
    )
    Spacer(Modifier.height(30.dp))
    Text(title, style = MaterialTheme.typography.headlineLarge)
    Text(
      detail,
      modifier = Modifier.padding(top = 14.dp),
      color = KeposPalette.Muted,
      style = MaterialTheme.typography.bodyLarge,
    )
    if (action != null) {
      Button(
        onClick = onAction,
        modifier = Modifier.padding(top = 28.dp),
        shape = RoundedCornerShape(4.dp),
      ) {
        Icon(Lucide.RefreshCw, contentDescription = null, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(action)
      }
    }
    if (secondaryAction != null) {
      OutlinedButton(
        onClick = onSecondaryAction,
        modifier = Modifier.padding(top = 12.dp),
        shape = RoundedCornerShape(4.dp),
      ) {
        Icon(Lucide.Settings, contentDescription = null, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(secondaryAction)
      }
    }
  }
}

@Composable
private fun SettingsScreen(
  snapshot: RuntimeSnapshot,
  onBack: () -> Unit,
  onChangePublisher: () -> Unit,
  onCopyText: (String) -> Unit,
  onStop: () -> Unit,
) {
  LazyColumn(
    modifier = Modifier
      .fillMaxSize()
      .statusBarsPadding(),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
  ) {
    item {
      Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) {
          Icon(Lucide.ArrowLeft, contentDescription = "Back")
        }
        Spacer(Modifier.width(8.dp))
        Text("Settings", style = MaterialTheme.typography.headlineLarge)
      }
      Spacer(Modifier.height(44.dp))
      SettingsSection("Publisher") {
        snapshot.publisher?.let { publisher ->
          SettingValue("Name", publisher.displayName)
          SettingValue("Key", fingerprint(publisher.publisherKey), mono = true)
          SettingsAction("Copy publisher key", Lucide.Copy) {
            onCopyText(publisher.publisherKey)
          }
        } ?: SettingValue("Status", "Not verified yet")
        if (snapshot.state == RuntimeState.RUNNING) {
          SettingsAction("Change publisher", Lucide.RefreshCw, onClick = onChangePublisher)
        }
      }
      Spacer(Modifier.height(30.dp))
      SettingsSection("Diagnostics") {
        SettingValue("Runtime", snapshot.state.name.lowercase())
        SettingValue("Connection", snapshot.connection ?: "unknown")
        snapshot.subscriberPublicKey?.let { key ->
          SettingValue("Subscriber", fingerprint(key), mono = true)
          SettingsAction("Copy subscriber key", Lucide.Copy) { onCopyText(key) }
        }
      }
      Spacer(Modifier.height(30.dp))
      SettingsSection("Runtime") {
        SettingsAction(
          "Stop service",
          Lucide.Unplug,
          destructive = true,
          onClick = onStop,
        )
      }
    }
  }
}

@Composable
private fun SettingsSection(title: String, content: @Composable () -> Unit) {
  Text(
    title.uppercase(),
    color = KeposPalette.Lime,
    style = MaterialTheme.typography.labelMedium,
  )
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(top = 12.dp)
      .border(1.dp, KeposPalette.Line, RoundedCornerShape(5.dp))
      .background(KeposPalette.Panel, RoundedCornerShape(5.dp))
      .padding(18.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    content()
  }
}

@Composable
private fun SettingValue(label: String, value: String, mono: Boolean = false) {
  Column {
    Text(label, color = KeposPalette.Muted, style = MaterialTheme.typography.bodyMedium)
    Text(
      value,
      modifier = Modifier.padding(top = 3.dp),
      fontFamily = if (mono) KeposMono else KeposBody,
      color = KeposPalette.Cream,
      fontSize = 15.sp,
    )
  }
}

@Composable
private fun SettingsAction(
  label: String,
  icon: ImageVector,
  destructive: Boolean = false,
  onClick: () -> Unit,
) {
  OutlinedButton(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(4.dp),
    colors = ButtonDefaults.outlinedButtonColors(
      contentColor = if (destructive) KeposPalette.Error else KeposPalette.Cream,
    ),
  ) {
    Icon(icon, contentDescription = null, modifier = Modifier.size(17.dp))
    Spacer(Modifier.width(9.dp))
    Text(label)
  }
}

private fun serviceIcon(icon: ServiceIcon): ImageVector = when (icon) {
  ServiceIcon.BOOK -> Lucide.BookOpen
  ServiceIcon.MUSIC -> Lucide.AudioLines
  ServiceIcon.TERMINAL -> Lucide.SquareTerminal
  ServiceIcon.GIT -> Lucide.GitBranch
  ServiceIcon.BUILD -> Lucide.Hammer
  ServiceIcon.PHOTOS -> Lucide.Images
  ServiceIcon.STORAGE -> Lucide.DatabaseBackup
  ServiceIcon.PROXY -> Lucide.Network
  ServiceIcon.DASHBOARD -> Lucide.Gauge
  ServiceIcon.WEB -> Lucide.ExternalLink
  ServiceIcon.PORT -> Lucide.BoxIcon
}

private fun statusLabel(connection: String?): String = when (connection) {
  "connected" -> "Connected"
  "reconnecting" -> "Reconnecting…"
  "connecting" -> "Connecting…"
  else -> "Offline"
}

internal fun connectionTitle(connection: String?): String = when (connection) {
  "pairing-connecting" -> "Sending pairing request"
  "awaiting-approval" -> "Waiting for approval"
  else -> "Finding your publisher"
}

internal fun connectionDetail(connection: String?): String = when (connection) {
  "pairing-connecting" ->
    "Kepos is finding and authenticating the publisher from the invitation."
  "awaiting-approval" ->
    "The request reached your publisher. Choose Allow on that device."
  "reconnecting" -> "The previous path closed. Kepos is opening a new one."
  "offline" -> "The publisher is not reachable yet. Kepos will keep trying."
  else -> "Kepos is discovering and authenticating the publisher."
}

private fun fingerprint(key: String): String = if (key.length <= 16) key
else "${key.take(8)}…${key.takeLast(8)}"

private const val PUBLISHER_KEY_LENGTH = 64
private val PUBLISHER_KEY = Regex("^[0-9a-f]{$PUBLISHER_KEY_LENGTH}$")
