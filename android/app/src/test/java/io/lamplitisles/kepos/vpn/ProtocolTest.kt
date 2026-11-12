package io.lamplitisles.kepos.vpn

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProtocolTest {
  @Test
  fun `frames round trip across chunk boundaries`() {
    val control = WorkletCodec.ready()
    val packet = ByteArray(64) { it.toByte() }
    val stream = IpcFrames.encode(IpcFrames.CONTROL, control) + IpcFrames.encode(IpcFrames.PACKET, packet)

    val delivered = mutableListOf<Pair<Int, ByteArray>>()
    val decoder = FrameDecoder()
    for (byte in stream) decoder.append(byteArrayOf(byte)) { kind, payload -> delivered += kind to payload }
    decoder.finish()

    assertEquals(2, delivered.size)
    assertEquals(IpcFrames.CONTROL, delivered[0].first)
    assertArrayEquals(control, delivered[0].second)
    assertEquals(IpcFrames.PACKET, delivered[1].first)
    assertArrayEquals(packet, delivered[1].second)
  }

  @Test
  fun `encode rejects an oversized payload and unknown kind`() {
    assertThrows(IllegalArgumentException::class.java) {
      IpcFrames.encode(IpcFrames.CONTROL, ByteArray(IpcFrames.MAX_FRAME))
    }
    assertThrows(IllegalArgumentException::class.java) { IpcFrames.encode(7, ByteArray(1)) }
  }

  @Test
  fun `decoder rejects zero length, oversized length and unknown kind`() {
    val decoder = FrameDecoder()
    assertThrows(IpcFramingException::class.java) { decoder.append(byteArrayOf(0, 0, 1)) { _, _ -> } }
    assertThrows(IpcFramingException::class.java) { decoder.append(byteArrayOf(0x80.toByte(), 1, 1)) { _, _ -> } }
    assertThrows(IpcFramingException::class.java) { decoder.append(byteArrayOf(0, 2, 9, 1)) { _, _ -> } }
  }

  @Test
  fun `decoder reports a truncated frame`() {
    val decoder = FrameDecoder()
    decoder.append(byteArrayOf(0, 3, 1, 65)) { _, _ -> }
    assertThrows(IpcFramingException::class.java) { decoder.finish() }
  }

  @Test
  fun `control messages decode with bounded optional fields`() {
    val key = "a".repeat(64)
    val message = WorkletCodec.decode("""{"type":"settings","address":"198.18.20.5","publicKey":"$key","peers":[]}""".toByteArray())
    assertEquals("settings", message.type)
    assertEquals("198.18.20.5", message.address)
    assertEquals(emptyList<WorkletPeer>(), message.peers)

    val peer = WorkletCodec.decode("""{"type":"peer","publicKey":"${"b".repeat(64)}","label":"receiver","connected":true}""".toByteArray())
    assertEquals("peer", peer.type)
    assertEquals(true, peer.connected)
    assertEquals("${"b".repeat(64)}", peer.publicKey)
  }

  @Test
  fun `outgoing control messages carry the expected shape`() {
    val seed = "00".repeat(32)
    val start = Json.parseToJsonElement(WorkletCodec.start("[vpn]", seed).decodeToString()).jsonObject
    assertEquals(setOf("type", "config", "seed"), start.keys)
    assertEquals("start", start["type"]!!.jsonPrimitive.content)

    val pair = Json.parseToJsonElement(WorkletCodec.pair("kepos1:x:y", seed).decodeToString()).jsonObject
    assertEquals(setOf("type", "invitation", "seed"), pair.keys)

    assertEquals(setOf("type"), Json.parseToJsonElement(WorkletCodec.ready().decodeToString()).jsonObject.keys)
    assertEquals(setOf("type"), Json.parseToJsonElement(WorkletCodec.stop().decodeToString()).jsonObject.keys)
  }
}
