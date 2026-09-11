package io.github.ttalab.kepos

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import io.github.ttalab.barekit.host.BindingSnapshot
import io.github.ttalab.barekit.host.PeerConnectionSnapshot
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.barekit.host.ServiceSnapshot
import io.github.ttalab.kepos.ui.KeposScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class KeposScreenTest {
  @get:Rule
  val compose = createAndroidComposeRule<ComponentActivity>()

  @Test
  fun peerHomeUsesTheCanonicalSnapshotAndCopiesOnlyThePeerKey() {
    var copied: String? = null
    compose.setContent {
      KeposScreen(
        snapshot = connectedSnapshot(),
        onStart = {},
        onStop = {},
        onCopyText = { copied = it },
        onOpenUrl = {},
      )
    }

    compose.onNodeWithText("Peer services").assertIsDisplayed()
    compose.onNodeWithText("Peer: desktop").assertIsDisplayed()
    compose.onNodeWithText("1 connected · 1 configured").assertIsDisplayed()
    compose.onNodeWithText("SSH").assertIsDisplayed()
    compose.onNodeWithText("Photos").assertIsDisplayed()
    compose.onNodeWithText("Available").assertIsDisplayed()
    compose.onNodeWithText("Unavailable").assertIsDisplayed()
    compose.onNodeWithText("Copy key").performClick()
    assertEquals("ab".repeat(32), copied)
  }

  @Test
  fun stoppedAndFailedPeersOfferTheAppropriateRecoveryAction() {
    compose.setContent {
      KeposScreen(
        snapshot = RuntimeSnapshot(RuntimeState.STOPPED),
        onStart = {},
        onStop = {},
        onCopyText = {},
        onOpenUrl = {},
      )
    }
    compose.onNodeWithText("Kepos is off").assertIsDisplayed()
    compose.onNodeWithText("Start").assertIsDisplayed()

    compose.setContent {
      KeposScreen(
        snapshot = RuntimeSnapshot(RuntimeState.FAILED, error = "peer stopped"),
        onStart = {},
        onStop = {},
        onCopyText = {},
        onOpenUrl = {},
      )
    }
    compose.onNodeWithText("Kepos stopped").assertIsDisplayed()
    compose.onNodeWithText("peer stopped").assertIsDisplayed()
    compose.onNodeWithText("Retry").assertIsDisplayed()
  }

  @Test
  fun peerHomeDispatchesCanonicalOpenActionsToTheHost() {
    var opened: String? = null
    compose.setContent {
      KeposScreen(
        snapshot = connectedSnapshot(),
        onStart = {},
        onStop = {},
        onCopyText = {},
        onOpenUrl = { opened = it },
      )
    }

    compose.onNodeWithText("Open").performClick()

    assertEquals("http://web.localhost:17480/", opened)
  }

  private fun connectedSnapshot() = RuntimeSnapshot(
    state = RuntimeState.RUNNING,
    peerKey = "ab".repeat(32),
    configured = true,
    connection = "connected",
    connections = listOf(
      PeerConnectionSnapshot(
        label = "desktop",
        publicKey = "cd".repeat(32),
        connection = "dial",
        status = "connected",
        generation = 1,
        capability = "ready",
        services = 3,
      ),
    ),
    services = listOf(
      ServiceSnapshot("ssh", "SSH", "tcp", true),
      ServiceSnapshot("photos", "Photos", "http", false, "offline"),
      ServiceSnapshot(
        "web",
        "Web",
        "http",
        true,
        action = "open",
        url = "http://web.localhost:17480/",
      ),
    ),
    bindings = listOf(
      BindingSnapshot("desktop", "ssh", "127.0.0.1", 2200, true),
    ),
  )
}
