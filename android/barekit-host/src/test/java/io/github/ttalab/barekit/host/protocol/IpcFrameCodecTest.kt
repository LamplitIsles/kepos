package io.github.ttalab.barekit.host.protocol

import java.nio.ByteBuffer
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class IpcFrameCodecTest {
  @Test
  fun encodingMatchesSharedWireFixture() {
    val expected = checkNotNull(
      javaClass.classLoader?.getResource("request-ping-v1.hex"),
    ).readText().trim()
    val actual = IpcFrameCodec()
      .encode(RequestEnvelope(1, "request", 7, "ping"))
      .joinToString("") { "%02x".format(it) }

    assertEquals(expected, actual)
  }

  @Test
  fun roundTripsRequestFrame() {
    val request = RequestEnvelope(1, "request", 7, "ping")
    val codec = IpcFrameCodec()

    val frame = codec.encode(request)

    assertEquals(frame.size - 4, ByteBuffer.wrap(frame, 0, 4).int)
    assertEquals(listOf(request), codec.push(frame))
  }

  @Test
  fun acceptsFragmentedAndCoalescedFrames() {
    val first = IpcFrameCodec().encode(RequestEnvelope(1, "request", 1, "ping"))
    val second = IpcFrameCodec().encode(RequestEnvelope(1, "request", 2, "status"))
    val decoder = IpcFrameCodec()

    assertEquals(emptyList<HostEnvelope>(), decoder.push(first.copyOfRange(0, 2)))
    assertEquals(emptyList<HostEnvelope>(), decoder.push(first.copyOfRange(2, 9)))
    assertEquals(
      listOf(RequestEnvelope(1, "request", 1, "ping")),
      decoder.push(first.copyOfRange(9, first.size)),
    )
    assertEquals(
      listOf(
        RequestEnvelope(1, "request", 1, "ping"),
        RequestEnvelope(1, "request", 2, "status"),
      ),
      IpcFrameCodec().push(first + second),
    )
  }

  @Test
  fun rejectsInvalidLengthsJsonVersionAndRequest() {
    val zeroLength = ByteArray(4)
    val oversized = ByteBuffer.allocate(4).putInt(MAX_CONTROL_FRAME_BYTES + 1).array()
    val invalidUtf8 = rawFrame(byteArrayOf(0xff.toByte()))
    val invalidJson = rawFrame("{".encodeToByteArray())
    val invalidVersion = rawFrame(
      """{"version":2,"kind":"request","id":1,"method":"ping"}""".encodeToByteArray(),
    )
    val invalidMethod = rawFrame(
      """{"version":1,"kind":"request","id":1,"method":"eval"}""".encodeToByteArray(),
    )

    assertThrows(IllegalArgumentException::class.java) { IpcFrameCodec().push(zeroLength) }
    assertThrows(IllegalArgumentException::class.java) { IpcFrameCodec().push(oversized) }
    assertThrows(IllegalArgumentException::class.java) { IpcFrameCodec().push(invalidUtf8) }
    assertThrows(IllegalArgumentException::class.java) { IpcFrameCodec().push(invalidJson) }
    assertThrows(IllegalArgumentException::class.java) { IpcFrameCodec().push(invalidVersion) }
    assertThrows(IllegalArgumentException::class.java) { IpcFrameCodec().push(invalidMethod) }
  }

  @Test
  fun roundTripsOtherEnvelopeKinds() {
    val envelopes = listOf(
      ResponseEnvelope(1, "response", 1, JsonPrimitive("pong")),
      ErrorEnvelope(1, "error", 2, ErrorBody("stopped", "runtime stopped")),
      EventEnvelope(1, "event", "runtime.stateChanged", JsonPrimitive("running")),
    )

    for (envelope in envelopes) {
      assertEquals(listOf(envelope), IpcFrameCodec().push(IpcFrameCodec().encode(envelope)))
    }
  }

  @Test
  fun rejectsObsoleteRoleConfigurationRequests() {
    val publisherKey = "ab".repeat(32)
    val frame = rawFrame(
      """{"version":1,"kind":"request","id":4,"method":"configure","params":{"publisherKey":"$publisherKey"}}"""
        .encodeToByteArray(),
    )
    assertThrows(IllegalArgumentException::class.java) { IpcFrameCodec().push(frame) }
  }

  @Test
  fun trackerRejectsUnknownResponseId() {
    val tracker = RequestTracker()
    val first = tracker.request("ping")
    val second = tracker.request("status")
    val response = ResponseEnvelope(1, "response", first.id, JsonPrimitive("pong"))

    assertEquals(1, first.id)
    assertEquals(2, second.id)
    assertEquals(response, tracker.accept(response))
    assertThrows(IllegalArgumentException::class.java) {
      tracker.accept(ResponseEnvelope(1, "response", 99, JsonPrimitive("unknown")))
    }
  }

  private fun rawFrame(payload: ByteArray): ByteArray =
    ByteBuffer.allocate(4 + payload.size).putInt(payload.size).put(payload).array()
}
