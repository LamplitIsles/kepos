package io.github.ttalab.barekit.host.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement

const val PROTOCOL_VERSION = 1
const val MAX_CONTROL_FRAME_BYTES = 64 * 1024

sealed interface HostEnvelope {
  val version: Int
  val kind: String
}

@Serializable
data class RequestEnvelope(
  override val version: Int,
  override val kind: String,
  val id: Long,
  val method: String,
  val params: JsonElement? = null,
) : HostEnvelope

@Serializable
data class ResponseEnvelope(
  override val version: Int,
  override val kind: String,
  val id: Long,
  val result: JsonElement,
) : HostEnvelope

@Serializable
data class ErrorBody(val code: String, val message: String)

@Serializable
data class ErrorEnvelope(
  override val version: Int,
  override val kind: String,
  val id: Long,
  val error: ErrorBody,
) : HostEnvelope

@Serializable
data class EventEnvelope(
  override val version: Int,
  override val kind: String,
  val event: String,
  val data: JsonElement,
) : HostEnvelope

private val protocolJson = Json {
  ignoreUnknownKeys = false
}

internal fun encodeEnvelope(envelope: HostEnvelope): String {
  validateEnvelope(envelope)
  return when (envelope) {
    is RequestEnvelope -> protocolJson.encodeToString(envelope)
    is ResponseEnvelope -> protocolJson.encodeToString(envelope)
    is ErrorEnvelope -> protocolJson.encodeToString(envelope)
    is EventEnvelope -> protocolJson.encodeToString(envelope)
  }
}

internal fun decodeEnvelope(encoded: String): HostEnvelope {
  val element = try {
    protocolJson.parseToJsonElement(encoded)
  } catch (error: Exception) {
    throw IllegalArgumentException("control frame payload is not valid JSON", error)
  }
  val objectValue = element as? kotlinx.serialization.json.JsonObject
    ?: throw IllegalArgumentException("control envelope must be an object")
  val kind = objectValue["kind"]?.let {
    (it as? kotlinx.serialization.json.JsonPrimitive)?.content
  } ?: throw IllegalArgumentException("control envelope kind is missing")
  val envelope = try {
    when (kind) {
      "request" -> protocolJson.decodeFromJsonElement<RequestEnvelope>(element)
      "response" -> protocolJson.decodeFromJsonElement<ResponseEnvelope>(element)
      "error" -> protocolJson.decodeFromJsonElement<ErrorEnvelope>(element)
      "event" -> protocolJson.decodeFromJsonElement<EventEnvelope>(element)
      else -> throw IllegalArgumentException("unsupported control envelope kind")
    }
  } catch (error: IllegalArgumentException) {
    throw error
  } catch (error: Exception) {
    throw IllegalArgumentException("control envelope is malformed", error)
  }
  validateEnvelope(envelope)
  return envelope
}

private fun validateEnvelope(envelope: HostEnvelope) {
  require(envelope.version == PROTOCOL_VERSION) {
    "unsupported control protocol version"
  }
  when (envelope) {
    is RequestEnvelope -> {
      require(envelope.kind == "request") { "invalid control request kind" }
      requireRequestId(envelope.id)
      require(
        envelope.method == "ping" ||
          envelope.method == "status" ||
          envelope.method == "stop" ||
          envelope.method == "configure" ||
          envelope.method == "pair"
      ) {
        "unsupported control request method"
      }
    }
    is ResponseEnvelope -> {
      require(envelope.kind == "response") { "invalid control response kind" }
      requireRequestId(envelope.id)
    }
    is ErrorEnvelope -> {
      require(envelope.kind == "error") { "invalid control error kind" }
      requireRequestId(envelope.id)
      require(envelope.error.code.isNotEmpty()) { "control error code must not be empty" }
      require(envelope.error.message.isNotEmpty()) { "control error message must not be empty" }
    }
    is EventEnvelope -> {
      require(envelope.kind == "event") { "invalid control event kind" }
      require(envelope.event == "runtime.stateChanged") { "unsupported control event" }
    }
  }
}

private fun requireRequestId(id: Long) {
  require(id in 1..9_007_199_254_740_991) {
    "control request id must be a positive safe integer"
  }
}
