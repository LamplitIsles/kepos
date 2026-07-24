package io.github.ttalab.kepos.ui

import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.barekit.host.ServiceSnapshot

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
}

enum class ServiceIcon {
  MUSIC,
  TERMINAL,
  GIT,
  BUILD,
  PHOTOS,
  STORAGE,
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
)

data class KeposUiModel(
  val destination: KeposDestination,
  val publisherName: String? = null,
  val connection: String? = null,
  val services: List<ServiceUiModel> = emptyList(),
  val available: Boolean = false,
  val error: String? = null,
) {
  companion object {
    fun from(snapshot: RuntimeSnapshot): KeposUiModel {
      if (snapshot.state == RuntimeState.STOPPED) {
        return KeposUiModel(destination = KeposDestination.STOPPED)
      }
      if (snapshot.state == RuntimeState.FAILED) {
        return KeposUiModel(
          destination = KeposDestination.FAILED,
          error = snapshot.error,
        )
      }
      if (snapshot.state != RuntimeState.RUNNING) {
        return KeposUiModel(destination = KeposDestination.CONNECTING)
      }
      if (!snapshot.configured) {
        return KeposUiModel(destination = KeposDestination.SETUP)
      }
      val publisher = snapshot.publisher
        ?: return KeposUiModel(
          destination = KeposDestination.CONNECTING,
          connection = snapshot.connection,
        )
      return KeposUiModel(
        destination = KeposDestination.SERVICES,
        publisherName = publisher.displayName,
        connection = snapshot.connection,
        services = snapshot.services.mapNotNull(::serviceUiModel),
        available = snapshot.connection == "connected",
      )
    }

    private fun serviceUiModel(service: ServiceSnapshot): ServiceUiModel? {
      val action = when (service.action) {
        "open" -> ServiceAction.OPEN
        "copy-url" -> ServiceAction.COPY_URL
        "copy-command" -> ServiceAction.COPY_COMMAND
        else -> return null
      }
      val icon = when (service.icon) {
        "music" -> ServiceIcon.MUSIC
        "terminal" -> ServiceIcon.TERMINAL
        "git" -> ServiceIcon.GIT
        "build" -> ServiceIcon.BUILD
        "photos" -> ServiceIcon.PHOTOS
        "storage" -> ServiceIcon.STORAGE
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
      )
    }
  }
}
