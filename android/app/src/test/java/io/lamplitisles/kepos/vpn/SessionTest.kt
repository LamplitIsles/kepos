package io.lamplitisles.kepos.vpn

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private val RECEIVER_KEY = "c".repeat(64)
private val SECRET = "d".repeat(64)
private const val OUR_ADDRESS = "198.18.20.5"
private const val RECEIVER_ADDRESS = "198.18.20.1"

private class FakeWorklet(
  private val onControl: (FakeWorklet, String, JsonObject) -> Unit = { worklet, type, _ ->
    if (type == "stop") worklet.send("""{"type":"stopped"}""")
  },
) : WorkletSession {
  private val incoming = Channel<ByteArray>(Channel.UNLIMITED)
  private val decoder = FrameDecoder()
  private val exit = CompletableDeferred<Int>()
  val controls = mutableListOf<String>()
  var started = false
  var ended = false
  var terminated = false
  var closed = false
  var exitsOnEnd = true
  var exitsOnTerminate = true

  override fun start() {
    started = true
  }

  override suspend fun write(frame: ByteArray) {
    decoder.append(frame) { kind, payload ->
      check(kind == IpcFrames.CONTROL) { "unexpected frame kind" }
      val element = Json.parseToJsonElement(payload.decodeToString()).jsonObject
      val type = element["type"]!!.jsonPrimitive.content
      controls += type
      onControl(this, type, element)
    }
  }

  override suspend fun receive(): ByteArray? = incoming.receiveCatching().getOrNull()

  override fun endInput() {
    ended = true
    if (exitsOnEnd) {
      incoming.close()
      exit.complete(0)
    }
  }

  override suspend fun awaitExit(timeoutMillis: Long): Int? = withTimeoutOrNull(timeoutMillis) { exit.await() }

  override fun terminate() {
    terminated = true
    if (exitsOnTerminate) {
      incoming.close()
      exit.complete(1)
    }
  }

  override fun close() {
    closed = true
    incoming.close()
    if (!exit.isCompleted) exit.complete(0)
  }

  fun send(json: String) {
    incoming.trySend(IpcFrames.encode(IpcFrames.CONTROL, json.toByteArray()))
  }

  fun sendPacket(bytes: ByteArray) {
    incoming.trySend(IpcFrames.encode(IpcFrames.PACKET, bytes))
  }

  /** One IPC chunk holding a control frame followed by a packet frame. */
  fun sendChunk(control: String, packet: ByteArray) {
    incoming.trySend(
      IpcFrames.encode(IpcFrames.CONTROL, control.toByteArray()) + IpcFrames.encode(IpcFrames.PACKET, packet),
    )
  }
}

private class FakeTun : TunSink {
  val written = mutableListOf<ByteArray>()
  private val packets = Channel<ByteArray>(Channel.UNLIMITED)
  var closed = false

  override suspend fun read(): ByteArray? = packets.receiveCatching().getOrNull()

  override fun write(packet: ByteArray): Boolean {
    written += packet
    return true
  }

  override fun close() {
    closed = true
    packets.close()
  }

  fun feed(packet: ByteArray) {
    packets.trySend(packet)
  }
}

class SessionTest {
  private val root = TempRoot()
  private var tunRequest: TunRequest? = null

  private val invitation = "kepos1:$RECEIVER_KEY:$SECRET"

  @After
  fun cleanUp() = root.close()

  private fun newSession(
    worklet: WorkletSession,
    tun: FakeTun = FakeTun(),
    local: List<String>? = listOf("192.168.1.5"),
    onPeers: (List<PeerStatus>) -> Unit = {},
    onPairSubmitted: () -> Unit = {},
    timeouts: TunnelSession.Timeouts = TunnelSession.Timeouts(startupMillis = 2_000, stopMillis = 500, exitMillis = 500),
  ) = TunnelSession(
    peerState = PeerState(root.directory),
    workletFactory = { worklet },
    tunFactory = { request ->
      tunRequest = request
      tun
    },
    localIpv4 = { local },
    onPeers = onPeers,
    onPairSubmitted = onPairSubmitted,
    timeouts = timeouts,
  )

  private fun createIdentity(): String {
    val state = PeerState(root.directory)
    return state.identity.prepare()
  }

  private fun pairedState(): String {
    val publicKey = createIdentity()
    PeerState(root.directory).store.save(ManagedConfig(OUR_ADDRESS, RECEIVER_ADDRESS, RECEIVER_KEY))
    return publicKey
  }

  private fun settings(publicKey: String, peerAddress: String = RECEIVER_ADDRESS) =
    """{"type":"settings","publicKey":"$publicKey","address":"$OUR_ADDRESS","peers":[{"publicKey":"$RECEIVER_KEY","label":"receiver","address":"$peerAddress","connected":false}]}"""

  private fun assertLockRelease() {
    PeerState(root.directory).acquireLock().close()
  }

  private suspend fun failureOf(block: suspend () -> Unit): TunnelFailure =
    try {
      block()
      fail("expected a failure")
      error("unreachable")
    } catch (error: VpnFailure) {
      error.reason
    }

  @Test
  fun `pairing stores a durable configuration and releases the identity`() = runTest {
    val publicKey = createIdentity()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"paired","address":"198.18.20.6","receiverAddress":"$RECEIVER_ADDRESS","receiverKey":"$RECEIVER_KEY"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }

    val managed = newSession(worklet).pair(invitation)

    assertTrue(managed.paired)
    assertEquals(publicKey, managed.publicKey)
    assertEquals("198.18.20.6", PeerState(root.directory).store.read()!!.address)
    assertEquals(listOf("pair", "stop"), worklet.controls)
    assertTrue(worklet.ended)
    assertTrue(worklet.closed)
    assertLockRelease()
  }

  @Test
  fun `a new pairing is refused while an earlier outcome is unconfirmed`() = runTest {
    createIdentity()
    PeerState(root.directory).markPairingPending()
    var submitted = 0
    val worklet = FakeWorklet()
    val session = newSession(worklet, onPairSubmitted = { submitted += 1 })

    assertEquals(TunnelFailure.PairingUnknown, failureOf { session.pair(invitation) })
    assertEquals(0, submitted)
    assertTrue(worklet.controls.isEmpty())
    assertTrue(PeerState(root.directory).pairingPending())
  }

  @Test
  fun `a definite pairing error clears the pending marker`() = runTest {
    createIdentity()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"pair-error","reason":"unusable"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }

    assertEquals(TunnelFailure.Invitation, failureOf { newSession(worklet).pair(invitation) })
    assertFalse(PeerState(root.directory).pairingPending())
  }

  @Test
  fun `an unknown pairing error keeps the pending marker`() = runTest {
    createIdentity()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"pair-error","reason":"other"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }

    assertEquals(TunnelFailure.PairingUnknown, failureOf { newSession(worklet).pair(invitation) })
    assertTrue(PeerState(root.directory).pairingPending())
  }

  @Test
  fun `a successful pairing leaves no pending marker`() = runTest {
    createIdentity()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"paired","address":"198.18.20.6","receiverAddress":"$RECEIVER_ADDRESS","receiverKey":"$RECEIVER_KEY"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }

    assertTrue(newSession(worklet).pair(invitation).paired)
    assertFalse(PeerState(root.directory).pairingPending())
  }

  @Test
  fun `a stopped pairing leaves the pending marker`() = runTest {
    createIdentity()
    val worklet = FakeWorklet()
    val session = newSession(worklet)
    val failure = CompletableDeferred<TunnelFailure>()
    val job = launch { failure.complete(failureOf { session.pair(invitation) }) }
    withTimeout(2_000) {
      while (!worklet.controls.contains("pair")) yield()
    }

    session.stop()
    assertEquals(TunnelFailure.PairingUnknown, withTimeout(2_000) { failure.await() })
    job.join()
    assertTrue(PeerState(root.directory).pairingPending())
  }

  @Test
  fun `pairing reports the submitted invitation and connecting does not`() = runTest {
    createIdentity()
    var submitted = 0
    val pairWorklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"paired","address":"198.18.20.6","receiverAddress":"$RECEIVER_ADDRESS","receiverKey":"$RECEIVER_KEY"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    newSession(pairWorklet, onPairSubmitted = { submitted += 1 }).pair(invitation)
    assertEquals(1, submitted)

    root.close()
    val fresh = TempRoot()
    try {
      val publicKey = run {
        val state = PeerState(fresh.directory)
        val key = state.identity.prepare()
        state.store.save(ManagedConfig(OUR_ADDRESS, RECEIVER_ADDRESS, RECEIVER_KEY))
        key
      }
      var connectSubmitted = 0
      val connectWorklet =
        FakeWorklet { fake, type, _ ->
          when (type) {
            "start" -> fake.send(settings(publicKey))
            "ready" -> fake.send("""{"type":"running"}""")
            "stop" -> fake.send("""{"type":"stopped"}""")
          }
        }
      val session =
        TunnelSession(
          peerState = PeerState(fresh.directory),
          workletFactory = { connectWorklet },
          tunFactory = { FakeTun() },
          localIpv4 = { listOf("192.168.1.5") },
          onPeers = {},
          onPairSubmitted = { connectSubmitted += 1 },
          timeouts = TunnelSession.Timeouts(startupMillis = 2_000, stopMillis = 200, exitMillis = 200),
        )
      val connected = CompletableDeferred<Unit>()
      val job = launch { session.connect { connected.complete(Unit) } }
      connected.await()
      session.stop()
      job.join()
      assertEquals(0, connectSubmitted)
    } finally {
      fresh.close()
    }
  }

  @Test
  fun `a marker that cannot be cleared after a durable configuration is reported and recovered`() = runTest {
    createIdentity()
    // Create the configuration template with a working sync first, so the
    // counted syncs below are the marker, the configuration and the removal.
    PeerState(root.directory).store.read()
    var syncs = 0
    val refusing =
      PeerState(
        root.directory,
        DirectorySync {
          syncs += 1
          if (syncs == 3) throw IOException("directory fsync refused")
        },
      )
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"paired","address":"198.18.20.6","receiverAddress":"$RECEIVER_ADDRESS","receiverKey":"$RECEIVER_KEY"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val session =
      TunnelSession(
        peerState = refusing,
        workletFactory = { worklet },
        tunFactory = { FakeTun() },
        localIpv4 = { listOf("192.168.1.5") },
        onPeers = {},
        timeouts = TunnelSession.Timeouts(startupMillis = 2_000, stopMillis = 200, exitMillis = 200),
      )

    // The receiver accepted and the configuration is durable, but the marker
    // removal is not proven: the attempt reports a local failure, not success.
    assertEquals(TunnelFailure.LocalState, failureOf { session.pair(invitation) })
    assertEquals(PeerVpnError.LocalState, TunnelFailure.LocalState.toError(pairing = true))
    assertEquals(listOf("pair", "stop"), worklet.controls)

    // The configuration survived, so the device is paired even though the
    // attempt reported a local failure.
    val afterFailure = PeerState(root.directory).prepare()
    assertTrue(afterFailure.paired)
    assertEquals("198.18.20.6", PeerState(root.directory).store.read()!!.address)
    // The entry left the live tree without a durable removal, so it reads as
    // absent here and a crash is what could restore it.
    assertFalse(File(root.directory, PeerState.PENDING_NAME).exists())
    assertFalse(afterFailure.pairingPending)

    // Recreate what that crash would restore: the paired configuration plus an
    // unconfirmed marker must report the unknown outcome again.
    PeerState(root.directory).markPairingPending()
    val restored = PeerState(root.directory).prepare()
    assertTrue(restored.paired)
    assertTrue(restored.pairingPending)

    // Sync recovers: a recheck clears the marker without another invitation and
    // nothing was replayed.
    assertTrue(PeerState(root.directory).clearPairingPending())
    val rechecked = PeerState(root.directory).prepare()
    assertTrue(rechecked.paired)
    assertFalse(rechecked.pairingPending)
    assertEquals(1, worklet.controls.count { control -> control == "pair" })
  }

  @Test
  fun `pairing failure reasons are fixed`() = runTest {
    val expectations =
      mapOf(
        "unusable" to TunnelFailure.Invitation,
        "unavailable" to TunnelFailure.ReceiverUnavailable,
        "capacity" to TunnelFailure.Capacity,
        "pool" to TunnelFailure.Pool,
        "route" to TunnelFailure.ReceiverRouteConflict,
        "excluded" to TunnelFailure.ExcludedAddress,
        "other" to TunnelFailure.PairingUnknown,
      )
    for ((reason, expected) in expectations) {
      root.close()
      val fresh = TempRoot()
      try {
        val identity = IdentityStore(fresh.directory).prepare()
        assertTrue(identity.isNotEmpty())
        val worklet =
          FakeWorklet { fake, type, _ ->
            if (type == "pair") fake.send("""{"type":"pair-error","reason":"$reason"}""")
            if (type == "stop") fake.send("""{"type":"stopped"}""")
          }
        val session =
          TunnelSession(
            peerState = PeerState(fresh.directory),
            workletFactory = { worklet },
            tunFactory = { FakeTun() },
            localIpv4 = { listOf("192.168.1.5") },
            onPeers = {},
            timeouts = TunnelSession.Timeouts(startupMillis = 2_000, stopMillis = 200, exitMillis = 200),
          )
        assertEquals(expected, failureOf { session.pair(invitation) })
      } finally {
        fresh.close()
      }
    }
  }

  @Test
  fun `a silent receiver times out without saving configuration`() = runTest {
    createIdentity()
    val worklet =
      FakeWorklet { fake, type, _ ->
        if (type == "stop") fake.send("""{"type":"stopped"}""")
      }
    val session =
      newSession(worklet, timeouts = TunnelSession.Timeouts(startupMillis = 100, stopMillis = 100, exitMillis = 100))
    assertEquals(TunnelFailure.Timeout, failureOf { session.pair(invitation) })
    assertNull(PeerState(root.directory).store.read())
  }

  @Test
  fun `an unreadable underlay fails before the invitation is sent`() = runTest {
    createIdentity()
    val worklet = FakeWorklet()
    assertEquals(TunnelFailure.RouteInspectionBeforePair, failureOf { newSession(worklet, local = null).pair(invitation) })
    assertTrue(worklet.controls.isEmpty())
    assertFalse(worklet.started)
  }

  @Test
  fun `an assigned address already on this device reports an unknown pairing outcome`() = runTest {
    createIdentity()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"paired","address":"198.18.20.6","receiverAddress":"$RECEIVER_ADDRESS","receiverKey":"$RECEIVER_KEY"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val reason = failureOf { newSession(worklet, local = listOf("198.18.20.6")).pair(invitation) }
    assertEquals(TunnelFailure.PairingConflictUnknown, reason)
    assertNull(PeerState(root.directory).store.read())
  }

  @Test
  fun `an illegal invitation never starts a worklet`() = runTest {
    val worklet = FakeWorklet()
    assertEquals(TunnelFailure.Invitation, failureOf { newSession(worklet).pair("kepos1:bad") })
    assertFalse(worklet.started)
  }

  @Test
  fun `connecting opens the TUN, reports status and stops cleanly`() = runTest {
    val publicKey = pairedState()
    val published = mutableListOf<List<PeerStatus>>()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "start" -> fake.send(settings(publicKey))
          "ready" -> fake.send("""{"type":"running"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val tun = FakeTun()
    val session = newSession(worklet, tun = tun, onPeers = { published += it })
    val connected = CompletableDeferred<Unit>()
    val job = launch { session.connect { connected.complete(Unit) } }
    connected.await()

    assertEquals(OUR_ADDRESS, tunRequest?.address)
    assertEquals(listOf(RECEIVER_ADDRESS), tunRequest?.peerAddresses)
    assertEquals(listOf("start", "ready"), worklet.controls)
    assertEquals(listOf(PeerStatus(RECEIVER_KEY, "receiver", false)), published.last())

    worklet.send("""{"type":"peer","publicKey":"$RECEIVER_KEY","label":"receiver","connected":true}""")
    withTimeout(2_000) {
      while (published.last().single().connected != true) yield()
    }

    session.stop()
    job.join()
    assertTrue(tun.closed)
    assertTrue(worklet.ended)
    assertTrue(worklet.closed)
    assertTrue(worklet.controls.contains("stop"))
    assertLockRelease()
  }

  @Test
  fun `a stopped connection is not an error`() = runTest {
    pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        if (type == "stop") fake.send("""{"type":"stopped"}""")
      }
    val session = newSession(worklet)
    val job = launch { session.connect { } }
    session.stop()
    job.join()
    assertTrue(worklet.controls.contains("stop"))
  }

  @Test
  fun `a tunnel device that closes under a running session ends it`() = runTest {
    val publicKey = pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "start" -> fake.send(settings(publicKey))
          "ready" -> fake.send("""{"type":"running"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val tun = FakeTun()
    val session = newSession(worklet, tun = tun)
    val connected = CompletableDeferred<Unit>()
    val outcome = CompletableDeferred<TunnelFailure?>()
    val job = launch {
      val failure =
        try {
          session.connect { connected.complete(Unit) }
          null
        } catch (error: VpnFailure) {
          error.reason
        }
      outcome.complete(failure)
    }
    connected.await()

    // The interface disappears while the session still reports itself running.
    tun.close()

    assertEquals(TunnelFailure.TunnelDevice, withTimeout(2_000) { outcome.await() })
    job.join()
    assertTrue(tun.closed)
    assertTrue(worklet.ended)
    assertTrue(worklet.controls.contains("stop"))
    assertLockRelease()
  }

  @Test
  fun `settings that contradict the derived identity fail the connection`() = runTest {
    pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        if (type == "start") fake.send(settings("e".repeat(64)))
        if (type == "stop") fake.send("""{"type":"stopped"}""")
      }
    assertEquals(TunnelFailure.Bridge, failureOf { newSession(worklet).connect { } })
    assertTrue(worklet.ended)
  }

  @Test
  fun `a peer sharing this device address fails the connection`() = runTest {
    val publicKey = pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        if (type == "start") fake.send(settings(publicKey, peerAddress = OUR_ADDRESS))
        if (type == "stop") fake.send("""{"type":"stopped"}""")
      }
    assertEquals(TunnelFailure.Bridge, failureOf { newSession(worklet).connect { } })
    assertNull(tunRequest)
  }

  @Test
  fun `an unreadable underlay stops the connection before the TUN opens`() = runTest {
    val publicKey = pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        if (type == "start") fake.send(settings(publicKey))
        if (type == "stop") fake.send("""{"type":"stopped"}""")
      }
    assertEquals(TunnelFailure.RouteInspectionUnavailable, failureOf { newSession(worklet, local = null).connect { } })
    assertNull(tunRequest)
  }

  @Test
  fun `an address already on this device fails the connection`() = runTest {
    val publicKey = pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        if (type == "start") fake.send(settings(publicKey))
        if (type == "stop") fake.send("""{"type":"stopped"}""")
      }
    val reason = failureOf { newSession(worklet, local = listOf(OUR_ADDRESS)).connect { } }
    assertEquals(TunnelFailure.LocalAddressConflict, reason)
    assertNull(tunRequest)
  }

  @Test
  fun `an oversized packet frame fails the connection`() = runTest {
    val publicKey = pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "start" -> fake.send(settings(publicKey))
          "ready" -> fake.send("""{"type":"running"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val session = newSession(worklet)
    val failed = CompletableDeferred<TunnelFailure>()
    val job =
      launch {
        failed.complete(failureOf { session.connect { } })
      }
    withTimeout(2_000) {
      while (!worklet.controls.contains("ready")) yield()
    }
    worklet.sendPacket(ByteArray(VPN_MTU + 1))
    assertEquals(TunnelFailure.Bridge, failed.await())
    job.join()
  }

  @Test
  fun `a packet from the worklet is written to the TUN`() = runTest {
    val publicKey = pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "start" -> fake.send(settings(publicKey))
          "ready" -> fake.send("""{"type":"running"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val tun = FakeTun()
    val session = newSession(worklet, tun = tun)
    val connected = CompletableDeferred<Unit>()
    val job = launch { session.connect { connected.complete(Unit) } }
    connected.await()
    worklet.sendPacket(ByteArray(40) { 0x45 })
    withTimeout(2_000) {
      while (tun.written.isEmpty()) yield()
    }
    assertEquals(40, tun.written.single().size)
    session.stop()
    job.join()
  }

  @Test
  fun `the invitation is marked submitted before the pair frame can be written`() =
    // Unconfined resumption lets the writer consume the queue inside the send
    // call, which is exactly the interleaving this order must survive.
    runTest(UnconfinedTestDispatcher()) {
    createIdentity()
    var marked = false
    var markedWhenPairWritten: Boolean? = null
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> {
            markedWhenPairWritten = marked
            fake.send("""{"type":"paired","address":"198.18.20.6","receiverAddress":"$RECEIVER_ADDRESS","receiverKey":"$RECEIVER_KEY"}""")
          }
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    newSession(worklet, onPairSubmitted = { marked = true }).pair(invitation)
    assertEquals(true, markedWhenPairWritten)
  }

  @Test
  fun `a peer status before the running message does not fail the connection`() = runTest {
    val publicKey = pairedState()
    val published = mutableListOf<List<PeerStatus>>()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "start" -> fake.send(settings(publicKey))
          "ready" -> {
            // The engine starts its dial peers without awaiting them, so a
            // status can arrive before the running message.
            fake.send("""{"type":"peer","publicKey":"$RECEIVER_KEY","label":"receiver","connected":true}""")
            fake.send("""{"type":"running"}""")
          }
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val session = newSession(worklet, onPeers = { published += it })
    val connected = CompletableDeferred<Unit>()
    val job = launch { session.connect { connected.complete(Unit) } }
    connected.await()
    withTimeout(2_000) {
      while (published.lastOrNull()?.single()?.connected != true) yield()
    }
    assertEquals(true, published.last().single().connected)
    session.stop()
    job.join()
  }

  @Test
  fun `a configuration that cannot be made durable reports an unknown pairing`() = runTest {
    val state = PeerState(root.directory)
    state.identity.prepare()
    state.store.read() // Create the template with a working sync first.
    // The pending marker is written durably first; only the configuration save
    // is refused here, which is what makes the outcome unknown.
    var syncs = 0
    val refusing =
      PeerState(
        root.directory,
        DirectorySync {
          syncs += 1
          if (syncs > 1) throw IOException("directory fsync refused")
        },
      )
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"paired","address":"198.18.20.6","receiverAddress":"$RECEIVER_ADDRESS","receiverKey":"$RECEIVER_KEY"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val session =
      TunnelSession(
        peerState = refusing,
        workletFactory = { worklet },
        tunFactory = { FakeTun() },
        localIpv4 = { listOf("192.168.1.5") },
        onPeers = {},
        timeouts = TunnelSession.Timeouts(startupMillis = 2_000, stopMillis = 200, exitMillis = 200),
      )
    assertEquals(TunnelFailure.PairingUnknown, failureOf { session.pair(invitation) })
    // The configuration may have reached the disk, which is why the outcome is
    // unknown instead of a clean failure.
    assertEquals("198.18.20.6", PeerState(root.directory).store.read()!!.address)
  }

  @Test
  fun `a packet in the same chunk as the running message is delivered`() = runTest {
    val publicKey = pairedState()
    val packet = ByteArray(40) { 0x45 }
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "start" -> fake.send(settings(publicKey))
          // The engine may report a packet immediately after starting, and both
          // frames can share one chunk read from the IPC.
          "ready" -> fake.sendChunk("""{"type":"running"}""", packet)
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    val tun = FakeTun()
    val session = newSession(worklet, tun = tun)
    val connected = CompletableDeferred<Unit>()
    val job = launch { session.connect { connected.complete(Unit) } }
    connected.await()
    withTimeout(2_000) {
      while (tun.written.isEmpty()) yield()
    }
    assertArrayEquals(packet, tun.written.single())
    session.stop()
    job.join()
  }

  @Test
  // Standard dispatcher on purpose: the main coroutine must not run inline, so
  // the packet is decoded while the ready frame has not been queued yet.
  fun `a packet before the ready frame fails the connection`() = runTest {
    val publicKey = pairedState()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "start" -> {
            fake.send(settings(publicKey))
            // No engine can exist before the ready frame, so this is a
            // protocol violation rather than a legal early packet.
            fake.sendPacket(ByteArray(40) { 0x45 })
          }
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    assertEquals(TunnelFailure.Bridge, failureOf { newSession(worklet).connect { } })
  }

  @Test
  fun `the packet gate opens before the ready frame can be written`() {
    // Scheduling cannot be forced to interleave the writer inside the send in
    // this environment, so the ordering itself is pinned: the gate must already
    // be published when the frame is handed to the queue.
    var gateOpen = false
    var openWhenSent: Boolean? = null
    sendReadyFrame(openGate = { gateOpen = true }, send = { openWhenSent = gateOpen })
    assertEquals(true, openWhenSent)
    assertEquals(true, gateOpen)
  }

  @Test
  fun `a refused ready frame fails the attempt instead of running ungated`() {
    val failure = assertThrows(VpnFailure::class.java) {
      sendReadyFrame(openGate = { }, send = { fail(TunnelFailure.Bridge) })
    }
    assertEquals(TunnelFailure.Bridge, failure.reason)
  }

  @Test
  fun `a worklet that never exits keeps the identity locked`() = runTest {
    createIdentity()
    val worklet =
      FakeWorklet { fake, type, _ ->
        when (type) {
          "pair" -> fake.send("""{"type":"paired","address":"198.18.20.6","receiverAddress":"$RECEIVER_ADDRESS","receiverKey":"$RECEIVER_KEY"}""")
          "stop" -> fake.send("""{"type":"stopped"}""")
        }
      }
    worklet.exitsOnEnd = false
    worklet.exitsOnTerminate = false
    val session =
      newSession(worklet, timeouts = TunnelSession.Timeouts(startupMillis = 2_000, stopMillis = 200, exitMillis = 200))
    assertTrue(session.pair(invitation).paired)
    assertFalse(session.close())
    assertEquals(TunnelFailure.IdentityInUse, failureOf { PeerState(root.directory).acquireLock() })
  }
}
