package io.github.ttalab.kepos

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.github.ttalab.barekit.host.PublisherSnapshot
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.barekit.host.ServiceSnapshot
import io.github.ttalab.kepos.ui.KeposScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class KeposScreenTest {
  @get:Rule
  val compose = createComposeRule()

  @Test
  fun serviceHomeUsesRealRegistryAndServiceActions() {
    var copied: String? = null
    var opened: String? = null
    compose.setContent {
      KeposScreen(
        snapshot = connectedSnapshot(),
        onStart = {},
        onStop = {},
        onConfigure = {},
        onCopyText = { copied = it },
        onOpenUrl = { opened = it },
      )
    }

    compose.onNodeWithText("kosmos").assertIsDisplayed()
    compose.onNodeWithText("Your services").assertIsDisplayed()
    compose.onNodeWithText("Woodpecker").assertIsDisplayed()
    compose.onNodeWithText("http://woodpecker.localhost:17480/").assertIsDisplayed()
    compose.onAllNodesWithText("Home").assertCountEquals(0)
    compose.onNodeWithText("Copy URL").performClick()
    assertEquals("http://navidrome.localhost:17480", copied)
    compose.onAllNodesWithText("Open")[0].performClick()
    assertEquals("http://forgejo.localhost:17480/", opened)
    compose.onNodeWithContentDescription("More actions for Forgejo").performClick()
    compose.onNodeWithText("Copy address").performClick()
    assertEquals("http://forgejo.localhost:17480/", copied)
  }

  @Test
  fun publisherAndRuntimeControlsLiveInSettings() {
    compose.setContent {
      KeposScreen(
        snapshot = connectedSnapshot(),
        onStart = {},
        onStop = {},
        onConfigure = {},
        onCopyText = {},
        onOpenUrl = {},
      )
    }

    compose.onAllNodesWithText("Stop service").assertCountEquals(0)
    compose.onNodeWithContentDescription("Settings").performClick()
    compose.onNodeWithText("PUBLISHER").assertIsDisplayed()
    compose.onNodeWithText("Change publisher").assertIsDisplayed()
    compose.onNodeWithText("DIAGNOSTICS").performScrollTo().assertIsDisplayed()
    compose.onNodeWithText("Stop service").performScrollTo().assertIsDisplayed()
  }

  @Test
  fun failedRuntimeCanOpenDiagnostics() {
    compose.setContent {
      KeposScreen(
        snapshot = RuntimeSnapshot(
          state = RuntimeState.FAILED,
          subscriberPublicKey = "cd".repeat(32),
          configured = true,
          connection = "offline",
          error = "Worklet stopped",
        ),
        onStart = {},
        onStop = {},
        onConfigure = {},
        onCopyText = {},
        onOpenUrl = {},
      )
    }

    compose.onNodeWithText("Diagnostics").performClick()
    compose.onNodeWithText("DIAGNOSTICS").assertIsDisplayed()
    compose.onNodeWithText("failed").assertIsDisplayed()
    compose.onAllNodesWithText("Change publisher").assertCountEquals(0)
  }

  @Test
  fun setupExposesTheSubscriberKeyForPublisherAllowlisting() {
    var copied: String? = null
    val subscriberKey = "cd".repeat(32)
    compose.setContent {
      KeposScreen(
        snapshot = RuntimeSnapshot(
          state = RuntimeState.RUNNING,
          subscriberPublicKey = subscriberKey,
          configured = false,
        ),
        onStart = {},
        onStop = {},
        onConfigure = {},
        onCopyText = { copied = it },
        onOpenUrl = {},
      )
    }

    compose.onNodeWithText("Copy subscriber key").performClick()
    assertEquals(subscriberKey, copied)
  }

  @Test
  fun connectingScreenKeepsSettingsReachable() {
    compose.setContent {
      KeposScreen(
        snapshot = RuntimeSnapshot(
          state = RuntimeState.RUNNING,
          subscriberPublicKey = "cd".repeat(32),
          configured = true,
          connection = "connecting",
        ),
        onStart = {},
        onStop = {},
        onConfigure = {},
        onCopyText = {},
        onOpenUrl = {},
      )
    }

    compose.onNodeWithText("Settings").performClick()
    compose.onNodeWithText("DIAGNOSTICS").assertIsDisplayed()
    compose.onNodeWithText("Change publisher").assertIsDisplayed()
  }

  @Test
  fun reconnectKeepsKnownServicesVisibleButDisablesActions() {
    compose.setContent {
      KeposScreen(
        snapshot = connectedSnapshot().copy(connection = "reconnecting"),
        onStart = {},
        onStop = {},
        onConfigure = {},
        onCopyText = {},
        onOpenUrl = {},
      )
    }

    compose.onNodeWithText("RECONNECTING…").assertIsDisplayed()
    compose.onNodeWithText("Navidrome").assertIsDisplayed()
    compose.onNodeWithText("Copy URL").assertIsNotEnabled()
  }

  private fun connectedSnapshot() = RuntimeSnapshot(
    state = RuntimeState.RUNNING,
    subscriberPublicKey = "cd".repeat(32),
    configured = true,
    connection = "connected",
    publisher = PublisherSnapshot("kosmos", "ab".repeat(32)),
    services = listOf(
      ServiceSnapshot(
        id = "navidrome",
        name = "Navidrome",
        access = "http",
        action = "copy-url",
        icon = "music",
        url = "http://navidrome.localhost:17480",
        copyText = "http://navidrome.localhost:17480",
      ),
      ServiceSnapshot(
        id = "forgejo",
        name = "Forgejo",
        access = "http",
        action = "open",
        icon = "git",
        url = "http://forgejo.localhost:17480/",
      ),
      ServiceSnapshot(
        id = "ssh",
        name = "SSH",
        access = "ssh",
        action = "info",
        icon = "terminal",
      ),
      ServiceSnapshot(
        id = "woodpecker",
        name = "Woodpecker",
        access = "http",
        action = "open",
        icon = "build",
        url = "http://woodpecker.localhost:17480/",
      ),
    ),
  )
}
