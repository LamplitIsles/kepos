package io.lamplitisles.kepos.vpn

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Largest IPv4 packet the peer VPN carries; see src/vpn/packet-policy.ts. */
internal const val VPN_MTU = 1400

/**
 * Provider/worklet IPC is a local byte stream: a two-byte big-endian length
 * followed by a one-byte kind and a bounded payload. This is not the peer VPN
 * protocol and must stay compatible with src/vpn/worklet-framing.ts.
 */
internal object IpcFrames {
  const val CONTROL = 1
  const val PACKET = 2
  const val MAX_FRAME = 32_768

  fun encode(kind: Int, payload: ByteArray): ByteArray {
    val length = payload.size + 1
    require((kind == CONTROL || kind == PACKET) && length <= MAX_FRAME) { "invalid IPC frame" }
    val frame = ByteArray(length + 2)
    frame[0] = (length ushr 8).toByte()
    frame[1] = length.toByte()
    frame[2] = kind.toByte()
    payload.copyInto(frame, 3)
    return frame
  }
}

internal class IpcFramingException(message: String) : Exception(message)

/**
 * Incremental decoder with the same bounds as every other Kepos host. A
 * malformed or truncated stream raises [IpcFramingException] instead of
 * resynchronising.
 */
internal class FrameDecoder {
  private val header = ByteArray(2)
  private var headerBytes = 0
  private var frame: ByteArray? = null
  private var frameBytes = 0

  fun append(bytes: ByteArray, deliver: (kind: Int, payload: ByteArray) -> Unit) {
    var offset = 0
    while (offset < bytes.size) {
      var current = frame
      if (current == null) {
        val count = minOf(2 - headerBytes, bytes.size - offset)
        bytes.copyInto(header, headerBytes, offset, offset + count)
        offset += count
        headerBytes += count
        if (headerBytes < 2) continue
        val length = ((header[0].toInt() and 0xff) shl 8) or (header[1].toInt() and 0xff)
        if (length < 1 || length > IpcFrames.MAX_FRAME) throw IpcFramingException("invalid frame length")
        headerBytes = 0
        current = ByteArray(length)
        frame = current
        frameBytes = 0
      }
      val count = minOf(current.size - frameBytes, bytes.size - offset)
      bytes.copyInto(current, frameBytes, offset, offset + count)
      frameBytes += count
      offset += count
      if (frameBytes == current.size) {
        frame = null
        val kind = current[0].toInt() and 0xff
        if (kind != IpcFrames.CONTROL && kind != IpcFrames.PACKET) throw IpcFramingException("unknown frame kind")
        deliver(kind, current.copyOfRange(1, current.size))
      }
    }
  }

  fun finish() {
    if (headerBytes != 0 || frame != null) throw IpcFramingException("truncated frame")
  }
}

@Serializable
internal data class WorkletPeer(
  val publicKey: String,
  val label: String,
  val address: String = "",
  val connected: Boolean = false,
)

/** One decoded control message; fields are validated per message type. */
@Serializable
internal data class WorkletMessage(
  val type: String,
  val address: String? = null,
  val peers: List<WorkletPeer>? = null,
  val publicKey: String? = null,
  val connected: Boolean? = null,
  val receiverAddress: String? = null,
  val receiverKey: String? = null,
  val reason: String? = null,
)

internal object WorkletCodec {
  private val json = Json { ignoreUnknownKeys = true; isLenient = false }

  fun decode(payload: ByteArray): WorkletMessage = json.decodeFromString(payload.decodeToString())

  fun encode(message: kotlinx.serialization.json.JsonObject): ByteArray = message.toString().toByteArray()

  fun pair(invitation: String, seedHex: String): ByteArray = encode(
    buildJsonObject {
      put("type", "pair")
      put("invitation", invitation)
      put("seed", seedHex)
    },
  )

  fun start(config: String, seedHex: String): ByteArray = encode(
    buildJsonObject {
      put("type", "start")
      put("config", config)
      put("seed", seedHex)
    },
  )

  fun ready(): ByteArray = encode(buildJsonObject { put("type", "ready") })

  fun stop(): ByteArray = encode(buildJsonObject { put("type", "stop") })
}
