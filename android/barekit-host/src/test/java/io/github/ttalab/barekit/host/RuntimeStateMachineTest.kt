package io.github.ttalab.barekit.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeStateMachineTest {
  private val peerKey = "11".repeat(32)

  @Test
  fun duplicateStartReusesOneRuntime() {
    var nextId = 0
    val machine = RuntimeStateMachine { "runtime-${++nextId}" }

    val first = machine.start()
    val duplicateWhileStarting = machine.start()
    machine.running(first.runtimeId, "http://127.0.0.1:17482/", peerKey = peerKey)
    val duplicateWhileRunning = machine.start()

    assertTrue(first.shouldCreate)
    assertEquals("runtime-1", first.runtimeId)
    assertFalse(duplicateWhileStarting.shouldCreate)
    assertEquals(first.runtimeId, duplicateWhileStarting.runtimeId)
    assertFalse(duplicateWhileRunning.shouldCreate)
    assertEquals(first.runtimeId, duplicateWhileRunning.runtimeId)
    assertEquals(
      RuntimeSnapshot(
        RuntimeState.RUNNING,
        runtimeId = first.runtimeId,
        echoUrl = "http://127.0.0.1:17482/",
        peerKey = peerKey,
      ),
      machine.snapshot(),
    )
  }

  @Test
  fun stopIsBoundToTheCurrentRuntime() {
    val machine = RuntimeStateMachine { "runtime-1" }
    val runtime = machine.start()
    machine.running(runtime.runtimeId, "http://127.0.0.1:17482/", peerKey = peerKey)

    machine.stopping(runtime.runtimeId)
    assertEquals(RuntimeState.STOPPING, machine.snapshot().state)
    assertThrows(IllegalStateException::class.java) { machine.start() }
    machine.stopped(runtime.runtimeId)

    assertEquals(RuntimeSnapshot(RuntimeState.STOPPED), machine.snapshot())
  }

  @Test
  fun staleCallbacksCannotReplaceCurrentState() {
    val machine = RuntimeStateMachine { "runtime-1" }
    val runtime = machine.start()

    assertThrows(IllegalArgumentException::class.java) {
      machine.running("stale-runtime", "http://127.0.0.1:17482/", peerKey = peerKey)
    }
    machine.failed(runtime.runtimeId, "boom")

    assertEquals(
      RuntimeSnapshot(RuntimeState.FAILED, runtime.runtimeId, error = "boom"),
      machine.snapshot(),
    )
  }
}
