package io.github.ttalab.barekit.host

import io.github.ttalab.barekit.host.protocol.EventEnvelope
import io.github.ttalab.barekit.host.protocol.HostEnvelope
import io.github.ttalab.barekit.host.protocol.IpcFrameCodec
import io.github.ttalab.barekit.host.protocol.RequestEnvelope
import io.github.ttalab.barekit.host.protocol.ResponseEnvelope
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BareRuntimeTest {
  @Test
  fun startPassesAppPrivateArgumentsAfterTheRuntimeId() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    val startWithArguments = BareRuntime::class.java.methods.singleOrNull {
      it.name == "start" && it.parameterTypes.size == 3
    }

    assertNotNull(startWithArguments)
    if (startWithArguments == null) return
    startWithArguments.invoke(
      runtime,
      ByteArrayInputStream("bundle".encodeToByteArray()),
      "/kepos.bundle",
      arrayOf("/data/user/0/io.github.ttalab.kepos/files/subscriber"),
    )

    assertArrayEquals(
      arrayOf(
        "runtime-1",
        "/data/user/0/io.github.ttalab.kepos/files/subscriber",
      ),
      session.arguments,
    )
  }

  @Test
  fun duplicateStartOwnsOneSessionAndAcknowledgedStopClosesIt() {
    val session = FakeRuntimeSession()
    val scheduler = FakeScheduler()
    val runtime = BareRuntime({ session }, { "runtime-1" }, scheduler)
    val observed = mutableListOf<RuntimeState>()
    runtime.observe { observed += it.state }

    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    runtime.start(ByteArrayInputStream("unused".encodeToByteArray()))
    session.emit(
      EventEnvelope(
        1,
        "event",
        "runtime.stateChanged",
        buildJsonObject {
          put("state", "running")
          put("runtimeId", "runtime-1")
          put("echoUrl", "http://127.0.0.1:17482/")
          put("subscriberPublicKey", "cd".repeat(32))
          put("configured", true)
          put("connection", "connected")
          putJsonObject("publisher") {
            put("displayName", "kosmos")
            put("publisherKey", "ab".repeat(32))
          }
          putJsonArray("services") {
            add(buildJsonObject {
              put("id", "navidrome")
              put("name", "Navidrome")
              put("access", "http")
              put("url", "http://navidrome.localhost:17480/")
            })
            add(buildJsonObject {
              put("id", "ssh")
              put("name", "SSH")
              put("access", "tcp")
            })
          }
        },
      ),
    )

    assertEquals(1, session.starts)
    assertTrue(runtime.snapshot().toString().contains("subscriberPublicKey=${"cd".repeat(32)}"))
    assertEquals(
      RuntimeSnapshot(
        RuntimeState.RUNNING,
        "runtime-1",
        "http://127.0.0.1:17482/",
        subscriberPublicKey = "cd".repeat(32),
        configured = true,
        connection = "connected",
        publisher = PublisherSnapshot("kosmos", "ab".repeat(32)),
        services = listOf(
          ServiceSnapshot(
            id = "navidrome",
            name = "Navidrome",
            access = "http",
            url = "http://navidrome.localhost:17480/",
          ),
          ServiceSnapshot(id = "ssh", name = "SSH", access = "tcp"),
        ),
      ),
      runtime.snapshot(),
    )

    val stopped = runtime.stop()
    val stopRequest = session.writes.single() as RequestEnvelope
    assertEquals("stop", stopRequest.method)
    assertFalse(stopped.isDone)
    session.emit(
      ResponseEnvelope(
        1,
        "response",
        stopRequest.id,
        buildJsonObject { put("stopped", true) },
      ),
    )

    assertEquals(RuntimeState.STOPPED, stopped.get(1, TimeUnit.SECONDS).state)
    assertEquals(1, session.closes)
    assertTrue(scheduler.cancelled)
    assertEquals(
      listOf(
        RuntimeState.STOPPED,
        RuntimeState.STARTING,
        RuntimeState.RUNNING,
        RuntimeState.STOPPING,
        RuntimeState.STOPPED,
      ),
      observed,
    )
  }

  @Test
  fun stopTimeoutStillClosesTheSession() {
    val session = FakeRuntimeSession()
    val scheduler = FakeScheduler()
    val runtime = BareRuntime({ session }, { "runtime-1" }, scheduler)
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))

    val stopped = runtime.stop(10)
    scheduler.run()

    assertEquals(RuntimeState.STOPPED, stopped.get(1, TimeUnit.SECONDS).state)
    assertEquals(1, session.closes)
  }

  @Test
  fun pingCompletesOnlyAfterTheCurrentWorkletResponds() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    session.emit(
      EventEnvelope(
        1,
        "event",
        "runtime.stateChanged",
        buildJsonObject {
          put("state", "running")
          put("runtimeId", "runtime-1")
          put("echoUrl", "http://127.0.0.1:17482/")
        },
      ),
    )

    val ping = runtime.ping()
    val request = session.writes.single() as RequestEnvelope
    assertEquals("ping", request.method)
    assertFalse(ping.isDone)

    session.emit(
      ResponseEnvelope(
        1,
        "response",
        request.id,
        buildJsonObject {
          put("pong", true)
          put("runtimeId", "runtime-1")
        },
      ),
    )

    assertEquals("runtime-1", ping.get(1, TimeUnit.SECONDS).runtimeId)
  }

  @Test
  fun configurePublisherCompletesWithTheUpdatedRuntimeState() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    session.emit(runningEvent(configured = false, connection = "offline"))

    val configured = runtime.configurePublisher("ab".repeat(32))
    val request = session.writes.single() as RequestEnvelope
    assertEquals("configure", request.method)
    assertEquals("ab".repeat(32), request.params?.jsonObject?.get("publisherKey")?.jsonPrimitive?.content)
    assertFalse(configured.isDone)

    session.emit(runningEvent(configured = true, connection = "connecting"))
    session.emit(
      ResponseEnvelope(
        1,
        "response",
        request.id,
        buildJsonObject { put("connection", "connecting") },
      ),
    )

    val snapshot = configured.get(1, TimeUnit.SECONDS)
    assertTrue(snapshot.configured)
    assertEquals("connecting", snapshot.connection)
  }

  @Test
  fun pairPublisherCarriesTheInvitationAndCompletesAfterApproval() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    session.emit(runningEvent(configured = false, connection = "offline"))

    val pairing = runtime.pairPublisher(
      "kepos://pair?v=1&token=one-time",
      "Neil's Pixel",
      "android",
    )
    val request = session.writes.single() as RequestEnvelope
    assertEquals("pair", request.method)
    assertEquals(
      "kepos://pair?v=1&token=one-time",
      request.params?.jsonObject?.get("invitation")?.jsonPrimitive?.content,
    )
    assertFalse(pairing.isDone)

    session.emit(runningEvent(configured = true, connection = "connected"))
    session.emit(
      ResponseEnvelope(
        1,
        "response",
        request.id,
        buildJsonObject { put("connection", "connected") },
      ),
    )

    assertEquals("connected", pairing.get(1, TimeUnit.SECONDS).connection)
  }

  @Test
  fun pairingExpiryReturnsToSetupWithoutFailingTheWorklet() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))

    session.emit(
      runningEvent(
        configured = false,
        connection = "offline",
        error = "Pairing invitation has expired",
      ),
    )

    assertEquals(RuntimeState.RUNNING, runtime.snapshot().state)
    assertFalse(runtime.snapshot().configured)
    assertEquals("Pairing invitation has expired", runtime.snapshot().error)
  }

  @Test
  fun failedRuntimeCanBeStoppedIdempotently() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    session.fail(IllegalStateException("worklet exited"))

    val stopped = runtime.stop().get(1, TimeUnit.SECONDS)
    val duplicate = runtime.stop().get(1, TimeUnit.SECONDS)

    assertEquals(RuntimeSnapshot(RuntimeState.STOPPED), stopped)
    assertEquals(stopped, duplicate)
  }

  @Test
  fun cleanStopRejectsAnUnansweredPing() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    session.emit(
      EventEnvelope(
        1,
        "event",
        "runtime.stateChanged",
        buildJsonObject {
          put("state", "running")
          put("runtimeId", "runtime-1")
          put("echoUrl", "http://127.0.0.1:17482/")
        },
      ),
    )

    val ping = runtime.ping()
    val stopped = runtime.stop()
    val stopRequest = session.writes.last() as RequestEnvelope
    session.emit(
      ResponseEnvelope(
        1,
        "response",
        stopRequest.id,
        buildJsonObject { put("stopped", true) },
      ),
    )

    assertEquals(RuntimeState.STOPPED, stopped.get(1, TimeUnit.SECONDS).state)
    assertTrue(ping.isCompletedExceptionally)
    assertThrows(CancellationException::class.java) {
      ping.get(1, TimeUnit.SECONDS)
    }
  }

  @Test
  fun sessionConstructorFailureEntersFailedAndAllowsRetry() {
    val session = FakeRuntimeSession()
    var creations = 0
    var runtimeIds = 0
    val runtime = BareRuntime(
      createSession = {
        creations++
        if (creations == 1) throw IllegalStateException("native constructor failed")
        session
      },
      createRuntimeId = { "runtime-${++runtimeIds}" },
      scheduler = FakeScheduler(),
    )
    val observed = mutableListOf<RuntimeState>()
    runtime.observe { observed += it.state }
    val failedSource = TrackingInputStream()

    assertThrows(IllegalStateException::class.java) {
      runtime.start(failedSource)
    }

    assertEquals(
      RuntimeSnapshot(
        RuntimeState.FAILED,
        runtimeId = "runtime-1",
        error = "native constructor failed",
      ),
      runtime.snapshot(),
    )
    assertTrue(failedSource.closed)
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    assertEquals(RuntimeState.STARTING, runtime.snapshot().state)
    assertEquals("runtime-2", runtime.snapshot().runtimeId)
    assertEquals(1, session.starts)
    assertEquals(
      listOf(
        RuntimeState.STOPPED,
        RuntimeState.STARTING,
        RuntimeState.FAILED,
        RuntimeState.STARTING,
      ),
      observed,
    )
  }

  @Test
  fun synchronousSessionFailureEmitsFailedOnlyOnce() {
    val error = IllegalStateException("native start failed")
    val session = object : RuntimeSession {
      override fun start(
        filename: String,
        source: InputStream,
        arguments: Array<String>,
        onData: (ByteArray) -> Unit,
        onFailure: (Throwable) -> Unit,
      ) {
        onFailure(error)
        throw error
      }

      override fun write(data: ByteArray, onFailure: (Throwable) -> Unit) = Unit

      override fun close() = Unit
    }
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    val observed = mutableListOf<RuntimeState>()
    runtime.observe { observed += it.state }

    assertThrows(IllegalStateException::class.java) {
      runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    }

    assertEquals(
      listOf(RuntimeState.STOPPED, RuntimeState.STARTING, RuntimeState.FAILED),
      observed,
    )
  }

  private class FakeRuntimeSession : RuntimeSession {
    private val codec = IpcFrameCodec()
    private lateinit var onData: (ByteArray) -> Unit
    private lateinit var onFailure: (Throwable) -> Unit
    var starts = 0
    var closes = 0
    var arguments = emptyArray<String>()
    val writes = mutableListOf<HostEnvelope>()

    override fun start(
      filename: String,
      source: InputStream,
      arguments: Array<String>,
      onData: (ByteArray) -> Unit,
      onFailure: (Throwable) -> Unit,
    ) {
      starts++
      this.arguments = arguments
      this.onData = onData
      this.onFailure = onFailure
    }

    override fun write(data: ByteArray, onFailure: (Throwable) -> Unit) {
      writes += codec.push(data)
    }

    fun emit(envelope: HostEnvelope) {
      onData(codec.encode(envelope))
    }

    fun fail(error: Throwable) {
      onFailure(error)
    }

    override fun close() {
      closes++
    }
  }

  private fun runningEvent(
    configured: Boolean,
    connection: String,
    error: String? = null,
  ) = EventEnvelope(
    1,
    "event",
    "runtime.stateChanged",
    buildJsonObject {
      put("state", "running")
      put("runtimeId", "runtime-1")
      put("echoUrl", "http://navidrome.localhost:17480/")
      put("subscriberPublicKey", "cd".repeat(32))
      put("configured", configured)
      put("connection", connection)
      error?.let { put("error", it) }
    },
  )

  private class FakeScheduler : RuntimeTimeoutScheduler {
    private var task: (() -> Unit)? = null
    var cancelled = false

    override fun schedule(delayMillis: Long, task: () -> Unit): AutoCloseable {
      this.task = task
      return AutoCloseable {
        cancelled = true
        this.task = null
      }
    }

    fun run() {
      task?.invoke()
    }
  }

  private class TrackingInputStream : ByteArrayInputStream("bundle".encodeToByteArray()) {
    var closed = false

    override fun close() {
      closed = true
      super.close()
    }
  }
}
