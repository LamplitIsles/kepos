package io.github.ttalab.kepos.ui

import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState

enum class KeposDestination {
  SETUP,
  STOPPED,
  CONNECTING,
  SERVICES,
  FAILED,
}

enum class ServiceAction {
  OPEN,
  COPY_URL,
  COPY_COMMAND,
  COPY_ENDPOINT,
}

enum class ServiceIcon {
  BOOK,
  MUSIC,
  TERMINAL,
  GIT,
  BUILD,
  PHOTOS,
  STORAGE,
  PROXY,
  DASHBOARD,
  WEB,
  PORT,
}

data class ServiceUiModel(
  val id: String,
  val name: String,
  val access: String,
  val url: String?,
  val copyText: String?,
  val action: ServiceAction,
  val icon: ServiceIcon,
  val kind: String,
  val available: Boolean,
  val error: String?,
)

data class KeposUiModel(
  val destination: KeposDestination,
  val peerLabel: String? = null,
  val peerKey: String? = null,
  val connection: String? = null,
  val services: List<ServiceUiModel> = emptyList(),
  val bindings: Int = 0,
  val available: Boolean = false,
  val error: String? = null,
) {
  companion object {
    fun from(snapshot: RuntimeSnapshot): KeposUiModel {
      if (snapshot.state == RuntimeState.STOPPED) {
        return KeposUiModel(destination = KeposDestination.STOPPED)
      }
      if (snapshot.state == RuntimeState.FAILED) {
        return KeposUiModel(destination = KeposDestination.FAILED, error = snapshot.error)
      }
      if (snapshot.state != RuntimeState.RUNNING) {
        return KeposUiModel(destination = KeposDestination.CONNECTING)
      }
      if (snapshot.connection == "pairing-connecting" || snapshot.connection == "awaiting-approval") {
        return KeposUiModel(
          destination = KeposDestination.CONNECTING,
          peerKey = snapshot.peerKey,
          connection = snapshot.connection,
          error = snapshot.error,
        )
      }
      if (!snapshot.configured) {
        return KeposUiModel(
          destination = KeposDestination.SETUP,
          peerKey = snapshot.peerKey,
          error = snapshot.error,
        )
      }
      val connection = snapshot.connections.firstOrNull { it.status == "connected" }
        ?: snapshot.connections.firstOrNull()
      if (connection == null) {
        return KeposUiModel(
          destination = KeposDestination.CONNECTING,
          peerKey = snapshot.peerKey,
          connection = snapshot.connection,
          error = snapshot.error,
        )
      }
      val connectionStatus = snapshot.connection ?: connection.status
      return KeposUiModel(
        destination = KeposDestination.SERVICES,
        peerLabel = connection.label,
        peerKey = snapshot.peerKey,
        connection = connectionStatus,
        services = snapshot.services.mapNotNull(::serviceUiModel),
        bindings = snapshot.bindings.size,
        available = connectionStatus == "connected" && snapshot.services.any { it.available },
        error = snapshot.error,
      )
    }

    private fun serviceUiModel(service: io.github.ttalab.barekit.host.ServiceSnapshot): ServiceUiModel? {
      // Android has no local UDP operation, so a canonical UDP catalog entry
      // is not presented as an action the host cannot complete.
      if (service.kind == "udp") return null
      val action = when (service.action) {
        "open" -> ServiceAction.OPEN
        "copy-url" -> ServiceAction.COPY_URL
        "copy-command" -> ServiceAction.COPY_COMMAND
        "copy-endpoint" -> ServiceAction.COPY_ENDPOINT
        else -> return null
      }
      val icon = when (service.icon) {
        "book" -> ServiceIcon.BOOK
        "music" -> ServiceIcon.MUSIC
        "terminal" -> ServiceIcon.TERMINAL
        "git" -> ServiceIcon.GIT
        "build" -> ServiceIcon.BUILD
        "photos" -> ServiceIcon.PHOTOS
        "storage" -> ServiceIcon.STORAGE
        "proxy" -> ServiceIcon.PROXY
        "dashboard" -> ServiceIcon.DASHBOARD
        "web" -> ServiceIcon.WEB
        else -> ServiceIcon.PORT
      }
      return ServiceUiModel(
        id = service.id,
        name = service.name,
        access = service.access,
        url = service.url,
        copyText = service.copyText,
        action = action,
        icon = icon,
        kind = service.kind,
        available = service.available,
        error = service.error,
      )
    }
  }
}
