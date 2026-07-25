package io.github.ttalab.barekit.host.protocol

import kotlinx.serialization.json.JsonElement

class RequestTracker {
  private var nextId = 1L
  private val pending = mutableSetOf<Long>()

  fun request(method: String, params: JsonElement? = null): RequestEnvelope {
    require(
      method == "ping" ||
        method == "status" ||
        method == "stop" ||
        method == "configure" ||
        method == "pair"
    ) {
      "unsupported control request method"
    }
    check(nextId <= 9_007_199_254_740_991) {
      "control request id space is exhausted"
    }
    val request = RequestEnvelope(PROTOCOL_VERSION, "request", nextId++, method, params)
    pending += request.id
    return request
  }

  fun accept(envelope: HostEnvelope): HostEnvelope {
    require(envelope is ResponseEnvelope || envelope is ErrorEnvelope) {
      "only response and error envelopes complete requests"
    }
    val id = when (envelope) {
      is ResponseEnvelope -> envelope.id
      is ErrorEnvelope -> envelope.id
      else -> error("unreachable")
    }
    require(pending.remove(id)) { "unknown response id: $id" }
    return envelope
  }
}
