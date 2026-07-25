package io.github.ttalab.kepos.ui

import io.github.ttalab.barekit.host.PublisherSnapshot
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.barekit.host.ServiceSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class KeposUiModelTest {
  @Test
  fun stoppedRuntimeOffersAnExplicitStartState() {
    val model = KeposUiModel.from(RuntimeSnapshot(RuntimeState.STOPPED))

    assertEquals(KeposDestination.STOPPED, model.destination)
  }

  @Test
  fun unconfiguredRuntimeShowsSetupInsteadOfAnEmptyServiceHome() {
    val model = KeposUiModel.from(
      RuntimeSnapshot(RuntimeState.RUNNING, configured = false),
    )

    assertEquals(KeposDestination.SETUP, model.destination)
  }

  @Test
  fun configuredRuntimeWaitsForARealPublisherRegistry() {
    val model = KeposUiModel.from(
      RuntimeSnapshot(
        RuntimeState.RUNNING,
        configured = true,
        connection = "connecting",
      ),
    )

    assertEquals(KeposDestination.CONNECTING, model.destination)
    assertEquals(emptyList<ServiceUiModel>(), model.services)
  }

  @Test
  fun serviceHomeUsesPublisherNameAndPreservesRegistryOrder() {
    val model = KeposUiModel.from(connectedSnapshot())

    assertEquals(KeposDestination.SERVICES, model.destination)
    assertEquals("kosmos", model.publisherName)
    assertEquals(listOf("forgejo", "navidrome"), model.services.map { it.id })
  }

  @Test
  fun serviceActionsAndIconsFollowTheRealAccessSurface() {
    val services = KeposUiModel.from(connectedSnapshot()).services

    assertEquals(ServiceAction.OPEN, services[0].action)
    assertEquals(ServiceIcon.GIT, services[0].icon)
    assertEquals(ServiceAction.COPY_URL, services[1].action)
    assertEquals(ServiceIcon.MUSIC, services[1].icon)
  }

  @Test
  fun servicesWithoutAnActionAreOmitted() {
    val snapshot = connectedSnapshot().copy(
      services = listOf(
        ServiceSnapshot(
          id = "photos",
          name = "Photos",
          access = "http",
          url = "http://photos.localhost:17480/",
        ),
        ServiceSnapshot(id = "database", name = "Database", access = "tcp"),
      ),
    )

    val services = KeposUiModel.from(snapshot).services

    assertEquals(emptyList<ServiceUiModel>(), services)
  }

  @Test
  fun entePhotosAndStorageBothCopyTheirUrls() {
    val snapshot = connectedSnapshot().copy(
      services = listOf(
        ServiceSnapshot(
          id = "ente",
          name = "Ente Photos",
          access = "http",
          action = "copy-url",
          icon = "photos",
          url = "http://ente.localhost:17480",
          copyText = "http://ente.localhost:17480",
        ),
        ServiceSnapshot(
          id = "ente-storage",
          name = "Ente Storage",
          access = "http",
          action = "copy-url",
          icon = "storage",
          url = "http://ente-storage.localhost:17480",
          copyText = "http://ente-storage.localhost:17480",
        ),
      ),
    )

    val services = KeposUiModel.from(snapshot).services

    assertEquals(ServiceAction.COPY_URL, services[0].action)
    assertEquals(ServiceIcon.PHOTOS, services[0].icon)
    assertEquals("http://ente.localhost:17480", services[0].url)
    assertEquals(ServiceAction.COPY_URL, services[1].action)
    assertEquals(ServiceIcon.STORAGE, services[1].icon)
    assertEquals("http://ente-storage.localhost:17480", services[1].url)
  }

  private fun connectedSnapshot() = RuntimeSnapshot(
    state = RuntimeState.RUNNING,
    configured = true,
    connection = "connected",
    publisher = PublisherSnapshot("kosmos", "ab".repeat(32)),
    services = listOf(
      ServiceSnapshot(
        id = "forgejo",
        name = "Forgejo",
        access = "http",
        action = "open",
        icon = "git",
        url = "http://forgejo.localhost:17480/",
      ),
      ServiceSnapshot(
        id = "navidrome",
        name = "Navidrome",
        access = "http",
        action = "copy-url",
        icon = "music",
        url = "http://navidrome.localhost:17480",
        copyText = "http://navidrome.localhost:17480",
      ),
    ),
  )
}
