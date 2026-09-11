package io.github.ttalab.barekit.host

import io.github.ttalab.barekit.host.protocol.ErrorEnvelope
import io.github.ttalab.barekit.host.protocol.EventEnvelope
import io.github.ttalab.barekit.host.protocol.IpcFrameCodec
import io.github.ttalab.barekit.host.protocol.RequestTracker
import io.github.ttalab.barekit.host.protocol.ResponseEnvelope
import java.io.InputStream
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

interface RuntimeSession : AutoCloseable {
  fun start(
    filename: String,
    source: InputStream,
    arguments: Array<String>,
    onData: (ByteArray) -> Unit,
    onFailure: (Throwable) -> Unit,
  )

  fun write(data: ByteArray, onFailure: (Throwable) -> Unit)
}

fun interface RuntimeTimeoutScheduler {
  fun schedule(delayMillis: Long, task: () -> Unit): AutoCloseable
}

class BareRuntime(
  private val createSession: () -> RuntimeSession,
  createRuntimeId: () -> String,
  private val scheduler: RuntimeTimeoutScheduler,
) : AutoCloseable {
  private val state = RuntimeStateMachine(createRuntimeId)
  private var session: RuntimeSession? = null
  private var codec = IpcFrameCodec()
  private var requests = RequestTracker()
  private var stopRequestId: Long? = null
  private var stopFuture: CompletableFuture<RuntimeSnapshot>? = null
  private var stopTimeout: AutoCloseable? = null
  private val pingFutures = mutableMapOf<Long, CompletableFuture<RuntimeSnapshot>>()
  private val actionFutures = mutableMapOf<Long, CompletableFuture<RuntimeSnapshot>>()
  private val observers = linkedSetOf<(RuntimeSnapshot) -> Unit>()

  fun snapshot(): RuntimeSnapshot = state.snapshot()

  @Synchronized
  fun observe(observer: (RuntimeSnapshot) -> Unit): AutoCloseable {
    observers += observer
    observer(state.snapshot())
    return AutoCloseable { synchronized(this) { observers -= observer } }
  }

  @Synchronized
  fun start(
    source: InputStream,
    filename: String = "/kepos.bundle",
    arguments: Array<String> = emptyArray(),
  ): RuntimeSnapshot {
    val decision = state.start()
    if (!decision.shouldCreate) {
      source.close()
      return state.snapshot()
    }
    codec = IpcFrameCodec()
    requests = RequestTracker()
    notifyObservers()
    try {
      val created = createSession()
      session = created
      created.start(
        filename,
        source,
        arrayOf(decision.runtimeId, *arguments),
        { data -> receive(decision.runtimeId, data) },
        { error -> fail(decision.runtimeId, error) },
      )
    } catch (error: Throwable) {
      if (state.snapshot().state != RuntimeState.FAILED) fail(decision.runtimeId, error)
      try {
        source.close()
      } catch (closeError: Throwable) {
        error.addSuppressed(closeError)
      }
      throw error
    }
    return state.snapshot()
  }

  @Synchronized
  fun ping(): CompletableFuture<RuntimeSnapshot> {
    val current = state.snapshot()
    check(current.state == RuntimeState.RUNNING) { "cannot ping a runtime from ${current.state}" }
    val runtimeId = checkNotNull(current.runtimeId)
    val request = requests.request("ping")
    val future = CompletableFuture<RuntimeSnapshot>()
    pingFutures[request.id] = future
    checkNotNull(session).write(codec.encode(request)) { error -> fail(runtimeId, error) }
    return future
  }

  @Synchronized
  fun configurePeer(
    publicKey: String,
    label: String,
    connection: String = "dial",
  ): CompletableFuture<RuntimeSnapshot> = requestSnapshotAction(
    "configure",
    buildJsonObject {
      put("publicKey", publicKey)
      put("label", label)
      put("connection", connection)
    },
  )

  @Synchronized
  fun pairPeer(
    invitation: String,
    deviceLabel: String,
    platform: String,
  ): CompletableFuture<RuntimeSnapshot> = requestSnapshotAction(
    "pair",
    buildJsonObject {
      put("invitation", invitation)
      put("deviceLabel", deviceLabel)
      put("platform", platform)
    },
  )

  @Synchronized
  fun stop(timeoutMillis: Long = 2_000): CompletableFuture<RuntimeSnapshot> {
    require(timeoutMillis >= 0) { "stop timeout must not be negative" }
    stopFuture?.let { return it }
    val current = state.snapshot()
    if (current.state == RuntimeState.STOPPED) return CompletableFuture.completedFuture(current)
    if (current.state == RuntimeState.FAILED) {
      val runtimeId = checkNotNull(current.runtimeId)
      cancelRequests()
      state.stopped(runtimeId)
      notifyObservers()
      return CompletableFuture.completedFuture(state.snapshot())
    }
    check(current.state == RuntimeState.STARTING || current.state == RuntimeState.RUNNING) {
      "cannot stop a runtime from ${current.state}"
    }
    val runtimeId = checkNotNull(current.runtimeId)
    state.stopping(runtimeId)
    notifyObservers()
    val future = CompletableFuture<RuntimeSnapshot>()
    stopFuture = future
    val request = requests.request("stop")
    stopRequestId = request.id
    stopTimeout = scheduler.schedule(timeoutMillis) { finishStop(runtimeId) }
    session?.write(codec.encode(request)) { error -> fail(runtimeId, error) }
    return future
  }

  @Synchronized
  override fun close() {
    val current = state.snapshot()
    if (current.state == RuntimeState.STOPPED) return
    if (current.state == RuntimeState.STARTING || current.state == RuntimeState.RUNNING) {
      state.stopping(checkNotNull(current.runtimeId))
    }
    if (state.snapshot().state == RuntimeState.STOPPING) {
      finishStop(checkNotNull(state.snapshot().runtimeId))
      return
    }
    closeSession()
  }

  @Synchronized
  private fun receive(runtimeId: String, data: ByteArray) {
    if (state.snapshot().runtimeId != runtimeId) return
    try {
      for (envelope in codec.push(data)) {
        when (envelope) {
          is EventEnvelope -> receiveEvent(runtimeId, envelope)
          is ResponseEnvelope -> receiveResponse(runtimeId, envelope)
          is ErrorEnvelope -> receiveError(runtimeId, envelope)
          else -> throw IllegalArgumentException("runtime sent a request to its host")
        }
      }
    } catch (error: Throwable) {
      fail(runtimeId, error)
    }
  }

  private fun receiveEvent(runtimeId: String, event: EventEnvelope) {
    val data = event.data as? JsonObject
      ?: throw IllegalArgumentException("runtime state event data must be an object")
    if (data["runtimeId"]?.jsonPrimitive?.content != runtimeId) {
      throw IllegalArgumentException("runtime state event has the wrong runtime id")
    }
    if (data["state"]?.jsonPrimitive?.content != "running") return
    val echoUrl = data["echoUrl"]?.jsonPrimitive?.content
      ?: throw IllegalArgumentException("running runtime has no echo URL")
    state.running(
      runtimeId = runtimeId,
      echoUrl = echoUrl,
      peerKey = data["peerKey"]?.jsonPrimitive?.content,
      connections = data["connections"]?.jsonArray?.map { parseConnection(it.jsonObject) } ?: emptyList(),
      services = data["services"]?.jsonArray?.map { parseService(it.jsonObject) } ?: emptyList(),
      bindings = data["bindings"]?.jsonArray?.map { parseBinding(it.jsonObject) } ?: emptyList(),
      error = data["error"]?.jsonPrimitive?.content,
      configured = data["configured"]?.jsonPrimitive?.booleanOrNull ?: false,
      connection = data["connection"]?.jsonPrimitive?.content,
    )
    notifyObservers()
  }

  private fun parseConnection(data: JsonObject): PeerConnectionSnapshot = PeerConnectionSnapshot(
    label = data.getValue("label").jsonPrimitive.content,
    publicKey = data.getValue("publicKey").jsonPrimitive.content,
    connection = data.getValue("connection").jsonPrimitive.content,
    status = data.getValue("status").jsonPrimitive.content,
    generation = data["generation"]?.jsonPrimitive?.longOrNull ?: 0,
    capability = data["capability"]?.jsonPrimitive?.content ?: "unknown",
    services = data["services"]?.jsonPrimitive?.intOrNull ?: 0,
    error = data["error"]?.jsonPrimitive?.content,
  )

  private fun parseService(data: JsonObject): ServiceSnapshot = ServiceSnapshot(
    id = data.getValue("id").jsonPrimitive.content,
    name = data.getValue("name").jsonPrimitive.content,
    kind = data.getValue("kind").jsonPrimitive.content,
    available = data["available"]?.jsonPrimitive?.booleanOrNull ?: false,
    error = data["error"]?.jsonPrimitive?.content,
    access = data["access"]?.jsonPrimitive?.content ?: data.getValue("kind").jsonPrimitive.content,
    action = data["action"]?.jsonPrimitive?.content ?: "copy-endpoint",
    icon = data["icon"]?.jsonPrimitive?.content ?: "port",
    url = data["url"]?.jsonPrimitive?.content,
    copyText = data["copyText"]?.jsonPrimitive?.content,
  )

  private fun parseBinding(data: JsonObject): BindingSnapshot = BindingSnapshot(
    peer = data.getValue("peer").jsonPrimitive.content,
    service = data.getValue("service").jsonPrimitive.content,
    listen = data["listen"]?.jsonObject?.let { listen ->
      listen["localPort"]?.jsonPrimitive?.content
        ?: listen["unixSocket"]?.jsonPrimitive?.content
        ?: "unknown"
    } ?: "unknown",
    port = data["port"]?.jsonPrimitive?.intOrNull,
    available = data["available"]?.jsonPrimitive?.booleanOrNull ?: false,
    error = data["error"]?.jsonPrimitive?.content,
    kind = data["kind"]?.jsonPrimitive?.content ?: "tcp",
  )

  @Synchronized
  private fun receiveResponse(runtimeId: String, response: ResponseEnvelope) {
    requests.accept(response)
    pingFutures.remove(response.id)?.complete(state.snapshot())
    actionFutures.remove(response.id)?.complete(state.snapshot())
    if (response.id == stopRequestId) finishStop(runtimeId)
  }

  @Synchronized
  private fun receiveError(runtimeId: String, error: ErrorEnvelope) {
    requests.accept(error)
    val failure = IllegalStateException("${error.error.code}: ${error.error.message}")
    if (pingFutures.remove(error.id)?.let { it.completeExceptionally(failure); true } == true) return
    if (actionFutures.remove(error.id)?.let { it.completeExceptionally(failure); true } == true) return
    fail(runtimeId, failure)
  }

  @Synchronized
  private fun finishStop(runtimeId: String) {
    if (state.snapshot().state != RuntimeState.STOPPING) return
    stopTimeout?.close()
    stopTimeout = null
    closeSession()
    cancelRequests()
    state.stopped(runtimeId)
    val stopped = state.snapshot()
    notifyObservers()
    stopRequestId = null
    stopFuture?.complete(stopped)
    stopFuture = null
  }

  @Synchronized
  private fun fail(runtimeId: String, error: Throwable) {
    if (state.snapshot().runtimeId != runtimeId) return
    stopTimeout?.close()
    stopTimeout = null
    closeSession()
    state.failed(runtimeId, error.message ?: error::class.java.simpleName)
    notifyObservers()
    stopFuture?.completeExceptionally(error)
    stopFuture = null
    stopRequestId = null
    rejectPings(error)
  }

  private fun rejectPings(error: Throwable) {
    pingFutures.values.forEach { it.completeExceptionally(error) }
    pingFutures.clear()
    actionFutures.values.forEach { it.completeExceptionally(error) }
    actionFutures.clear()
  }

  @Synchronized
  private fun requestSnapshotAction(
    method: String,
    params: JsonObject,
  ): CompletableFuture<RuntimeSnapshot> {
    val current = state.snapshot()
    check(current.state == RuntimeState.RUNNING) {
      "cannot request $method from ${current.state}"
    }
    val runtimeId = checkNotNull(current.runtimeId)
    val request = requests.request(method, params)
    val future = CompletableFuture<RuntimeSnapshot>()
    actionFutures[request.id] = future
    checkNotNull(session).write(codec.encode(request)) { error ->
      actionFutures.remove(request.id)?.completeExceptionally(error)
      fail(runtimeId, error)
    }
    return future
  }

  private fun cancelRequests() {
    rejectPings(CancellationException("runtime stopped before ping completed"))
  }

  private fun closeSession() {
    session?.close()
    session = null
  }

  private fun notifyObservers() {
    val snapshot = state.snapshot()
    observers.toList().forEach { it(snapshot) }
  }
}
