package io.github.ttalab.kepos.ui

import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState

enum class KeposDestination {
  STOPPED,
  CONNECTING,
  SERVICES,
  FAILED,
}

data class ServiceUiModel(
  val id: String,
  val name: String,
  val kind: String,
  val available: Boolean,
  val error: String?,
)

data class KeposUiModel(
  val destination: KeposDestination,
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
      return KeposUiModel(
        destination = KeposDestination.SERVICES,
        peerKey = snapshot.peerKey,
        connection = snapshot.connections.firstOrNull { it.status == "connected" }?.status
          ?: snapshot.connections.firstOrNull()?.status,
        services = snapshot.services.map { service ->
          ServiceUiModel(
            id = service.id,
            name = service.name,
            kind = service.kind,
            available = service.available,
            error = service.error,
          )
        },
        bindings = snapshot.bindings.size,
        available = snapshot.services.any { it.available },
        error = snapshot.error,
      )
    }
  }
}
