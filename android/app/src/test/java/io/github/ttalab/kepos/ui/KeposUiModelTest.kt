package io.github.ttalab.kepos.ui

import io.github.ttalab.barekit.host.BindingSnapshot
import io.github.ttalab.barekit.host.PeerConnectionSnapshot
import io.github.ttalab.barekit.host.PublisherSnapshot
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.barekit.host.ServiceSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeposUiModelTest {
  @Test
  fun stoppedRuntimeOffersAnExplicitStartState() {
    val model = KeposUiModel.from(RuntimeSnapshot(RuntimeState.STOPPED))

    assertEquals(KeposDestination.STOPPED, model.destination)
  }

  @Test
  fun startingRuntimeShowsTheCanonicalLoadingState() {
    val model = KeposUiModel.from(RuntimeSnapshot(RuntimeState.STARTING))

    assertEquals(KeposDestination.CONNECTING, model.destination)
    assertTrue(model.services.isEmpty())
  }

  @Test
  fun runningPeerExposesIdentityConnectionsServicesAndBindings() {
    val model = KeposUiModel.from(
      RuntimeSnapshot(
        state = RuntimeState.RUNNING,
        peerKey = "ab".repeat(32),
        configured = true,
        connection = "connected",
        publisher = PublisherSnapshot("desktop", "cd".repeat(32)),
        connections = listOf(
          PeerConnectionSnapshot(
            label = "desktop",
            publicKey = "cd".repeat(32),
            connection = "dial",
            status = "connected",
            generation = 1,
            capability = "ready",
            services = 2,
          ),
        ),
        services = listOf(
          ServiceSnapshot("ssh", "SSH", "tcp", true, action = "copy-command", copyText = "ssh"),
          ServiceSnapshot("photos", "Photos", "http", false, "offline", action = "open", url = "http://photos.localhost/"),
        ),
        bindings = listOf(
          BindingSnapshot("desktop", "ssh", "127.0.0.1", 2200, true),
        ),
      ),
    )

    assertEquals(KeposDestination.SERVICES, model.destination)
    assertEquals("ab".repeat(32), model.peerKey)
    assertEquals("connected", model.connection)
    assertEquals(listOf("ssh", "photos"), model.services.map { it.id })
    assertEquals(1, model.bindings)
    assertTrue(model.available)
    assertFalse(model.services[1].available)
    assertEquals("offline", model.services[1].error)
  }

  @Test
  fun failedRuntimeSurfacesItsError() {
    val model = KeposUiModel.from(
      RuntimeSnapshot(RuntimeState.FAILED, error = "peer stopped"),
    )

    assertEquals(KeposDestination.FAILED, model.destination)
    assertEquals("peer stopped", model.error)
  }

  @Test
  fun unsupportedAndroidUdpCatalogEntriesAreNotActionable() {
    val model = KeposUiModel.from(
      RuntimeSnapshot(
        state = RuntimeState.RUNNING,
        configured = true,
        connection = "connected",
        publisher = PublisherSnapshot("desktop", "cd".repeat(32)),
        services = listOf(
          ServiceSnapshot(
            "game",
            "Game",
            "udp",
            true,
            action = "copy-endpoint",
            copyText = "127.0.0.1:9000",
          ),
        ),
      ),
    )

    assertTrue(model.services.isEmpty())
  }
}
