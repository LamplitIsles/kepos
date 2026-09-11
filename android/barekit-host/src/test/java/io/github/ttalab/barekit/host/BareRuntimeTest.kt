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
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BareRuntimeTest {
  @Test
  fun startPassesCanonicalAppPrivateArgumentsAfterTheRuntimeId() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())

    runtime.start(
      ByteArrayInputStream("bundle".encodeToByteArray()),
      arguments = arrayOf(
        "/data/user/0/io.github.ttalab.kepos/files/peer",
        "/data/user/0/io.github.ttalab.kepos/files/config.toml",
        "null",
      ),
    )

    assertArrayEquals(
      arrayOf(
        "runtime-1",
        "/data/user/0/io.github.ttalab.kepos/files/peer",
        "/data/user/0/io.github.ttalab.kepos/files/config.toml",
        "null",
      ),
      session.arguments,
    )
  }

  @Test
  fun duplicateStartOwnsOneSessionAndStopClosesItAfterAcknowledgement() {
    val session = FakeRuntimeSession()
    val scheduler = FakeScheduler()
    val runtime = BareRuntime({ session }, { "runtime-1" }, scheduler)
    val observed = mutableListOf<RuntimeState>()
    runtime.observe { observed += it.state }

    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    runtime.start(ByteArrayInputStream("unused".encodeToByteArray()))
    session.emit(runningEvent())

    assertEquals(1, session.starts)
    assertEquals("cd".repeat(32), runtime.snapshot().peerKey)
    assertEquals(
      RuntimeSnapshot(
        state = RuntimeState.RUNNING,
        runtimeId = "runtime-1",
        echoUrl = "http://127.0.0.1:17482/",
        peerKey = "cd".repeat(32),
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
    session.emit(runningEvent())

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
    session.emit(runningEvent())

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

  private fun runningEvent() = EventEnvelope(
    1,
    "event",
    "runtime.stateChanged",
    buildJsonObject {
      put("state", "running")
      put("runtimeId", "runtime-1")
      put("echoUrl", "http://127.0.0.1:17482/")
      put("peerKey", "cd".repeat(32))
      putJsonArray("connections") {}
      putJsonArray("services") {}
      putJsonArray("bindings") {}
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
