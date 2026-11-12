package io.lamplitisles.kepos.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import io.lamplitisles.kepos.R
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import to.holepunch.bare.kit.Ipc
import to.holepunch.bare.kit.Worklet

/**
 * Directory fsync through the Android platform API; the JVM has no equivalent.
 *
 * A failure is reported, never swallowed: pairing and identity creation claim
 * durable state, and the Mac and iPhone clients treat a failed fsync as a local
 * state failure in the same way.
 */
internal object AndroidDirectorySync : DirectorySync {
  override fun sync(directory: File) {
    val descriptor =
      try {
        Os.open(directory.path, OsConstants.O_RDONLY, 0)
      } catch (error: ErrnoException) {
        throw IOException("cannot open ${directory.name} for fsync", error)
      }
    try {
      Os.fsync(descriptor)
    } catch (error: ErrnoException) {
      throw IOException("directory fsync failed for ${directory.name}", error)
    } finally {
      runCatching { Os.close(descriptor) }
    }
  }
}

/**
 * The official Bare Kit Kotlin binding around one worklet and its IPC.
 *
 * The worklet asset name and the IPC framing are shared with the Mac and iPhone
 * hosts; this class only adapts the suspending API.
 */
internal class BareWorkletSession(private val context: Context, private val scope: CoroutineScope) : WorkletSession {
  private val chunks = Channel<ByteArray>(CHUNK_LIMIT)
  private var worklet: Worklet? = null
  private var ipc: Ipc? = null
  private var reader: Job? = null

  /**
   * The host end of the IPC exists before the worklet starts, which is the
   * order bare-kit's C reference and this binding's own tests use. The worklet
   * touches `Bare.IPC` as soon as its module runs and may exit early, and
   * creating the host end only afterwards can then fail or miss its output.
   */
  override fun start() {
    val created = Worklet(context)
    worklet = created
    val channel = Ipc(created)
    ipc = channel
    reader = scope.launch {
      try {
        channel.data.collect { chunks.send(it) }
      } catch (_: Throwable) {
        // A closed or failed IPC is reported through receive() returning null.
      } finally {
        chunks.close()
      }
    }
    created.start(WORKLET_ASSET)
  }

  override suspend fun write(frame: ByteArray) {
    val channel = ipc ?: throw IllegalStateException("IPC is closed")
    channel.write(frame)
  }

  override suspend fun receive(): ByteArray? = chunks.receiveCatching().getOrNull()

  override fun endInput() {
    runCatching { ipc?.end() }
  }

  override suspend fun awaitExit(timeoutMillis: Long): Int? {
    val created = worklet ?: return 0
    return withTimeoutOrNull(timeoutMillis) { created.wait() }
  }

  override fun terminate() {
    runCatching { worklet?.terminate() }
  }

  override fun close() {
    runCatching { ipc?.close() }
    ipc = null
    runCatching { worklet?.close() }
    worklet = null
    reader?.cancel()
    reader = null
    chunks.close()
  }

  private companion object {
    const val WORKLET_ASSET = "kepos.bundle"

    /** Bounded chunks from the worklet; senders suspend instead of growing. */
    const val CHUNK_LIMIT = 64
  }
}

/** Blocking TUN device: one reader coroutine and a serialized writer. */
internal class AndroidTunSink(private val descriptor: ParcelFileDescriptor) : TunSink {
  private val input = FileInputStream(descriptor.fileDescriptor)
  private val output = FileOutputStream(descriptor.fileDescriptor)
  private val buffer = ByteArray(VPN_MTU)

  override suspend fun read(): ByteArray? = withContext(Dispatchers.IO) {
    try {
      val count = input.read(buffer)
      if (count <= 0) null else buffer.copyOf(count)
    } catch (_: IOException) {
      null
    }
  }

  override fun write(packet: ByteArray): Boolean =
    try {
      output.write(packet)
      true
    } catch (_: IOException) {
      false
    }

  override fun close() {
    runCatching { input.close() }
    runCatching { output.close() }
    runCatching { descriptor.close() }
  }
}

class KeposVpnService : VpnService() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var job: Job? = null
  private var session: TunnelSession? = null

  /** Attempt owning the running session, so a stale stop cannot stop a newer one. */
  @Volatile private var activeEpoch: Long? = null

  override fun onCreate() {
    super.onCreate()
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, getString(R.string.vpn_channel_name), NotificationManager.IMPORTANCE_LOW),
    )
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // startForegroundService requires a foreground promotion for every action,
    // including a stop request that arrives from the background.
    val action = intent?.action
    promoteToForeground(pairing = action == ACTION_PAIR)
    when (action) {
      ACTION_PAIR, ACTION_CONNECT -> {
        // A stale or unknown attempt must not attach to a newer operation.
        val operation = intent.getLongExtra(EXTRA_EPOCH, 0L).let(PeerVpnRuntime::adopt)
        val invitation = intent.getStringExtra(EXTRA_INVITATION)
        if (operation == null) {
          stopSelf()
        } else if (action == ACTION_PAIR && invitation == null) {
          PeerVpnRuntime.finished(operation, OperationOutcome.Failed(PeerVpnError.LocalState))
          stopSelf()
        } else {
          start(pairing = action == ACTION_PAIR, invitation = invitation, operation = operation)
        }
      }
      ACTION_STOP -> requestStop(intent.takeIf { it.hasExtra(EXTRA_EPOCH) }?.getLongExtra(EXTRA_EPOCH, 0L))
      else -> stopSelf()
    }
    // Never replay an operation the system restarted: an interrupted pairing or
    // connection has an unknown outcome at the receiver.
    return START_NOT_STICKY
  }

  override fun onRevoke() {
    PeerVpnRuntime.update { it.copy(phase = Phase.Disconnecting) }
    requestStop(epoch = null)
  }

  override fun onDestroy() {
    requestStop(epoch = null)
    if (job == null) scope.cancel()
    super.onDestroy()
  }

  private fun start(pairing: Boolean, invitation: String?, operation: Operation) {
    if (job != null) {
      PeerVpnRuntime.finished(operation, OperationOutcome.Failed(PeerVpnError.Busy))
      stopSelf()
      return
    }
    val session = TunnelSession(
      peerState = PeerState(keposRoot(this), AndroidDirectorySync),
      workletFactory = { BareWorkletSession(this, scope) },
      tunFactory = { request -> establishTun(request) },
      localIpv4 = NetworkInterfaceIpv4,
      onPeers = { peers -> PeerVpnRuntime.publishPeers(operation, peers) },
      onPairSubmitted = { PeerVpnRuntime.invitationSubmitted(operation) },
    )
    this.session = session
    activeEpoch = operation.epoch
    job = scope.launch {
      var outcome: OperationOutcome = OperationOutcome.Cancelled
      try {
        if (pairing) {
          PeerVpnRuntime.identity(operation, session.pair(invitation!!))
          outcome = OperationOutcome.Success
        } else {
          session.connect(onRunning = {
            // The waiting controller is released only here, and only for this
            // attempt; a stopped or failed tunnel reports its own outcome.
            PeerVpnRuntime.connected(operation)
            // A VPN configuration now exists, so the tunnel may declare the
            // systemExempted foreground type.
            promoteToForeground(pairing = false, established = true)
          })
        }
      } catch (error: VpnFailure) {
        outcome = OperationOutcome.Failed(error.reason.toError(pairing))
      } catch (_: kotlinx.coroutines.CancellationException) {
        outcome = OperationOutcome.Cancelled
      } catch (_: Throwable) {
        outcome = OperationOutcome.Failed(if (pairing) PeerVpnError.PairingOutcomeUnknown else PeerVpnError.ProviderUnavailable)
      } finally {
        val released = session.close()
        PeerVpnRuntime.finished(operation, outcome)
        activeEpoch = null
        job = null
        this@KeposVpnService.session = null
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
        if (!released) {
          // The worklet never exited, so the identity may still be held by it.
          // Never let this process start another runtime; end the process.
          android.os.Process.killProcess(android.os.Process.myPid())
        }
      }
    }
  }

  private fun requestStop(epoch: Long?) {
    val current = session
    if (current == null) {
      PeerVpnRuntime.idle()
      stopSelf()
      return
    }
    // A stop issued for an abandoned attempt must not close the current one.
    if (!stopTargetsAttempt(epoch, activeEpoch)) return
    promoteToForeground(pairing = false)
    scope.launch { runCatching { current.stop() } }
  }

  private fun promoteToForeground(pairing: Boolean, established: Boolean = false) {
    val notification = buildNotification(pairing)
    if (established) {
      try {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
        return
      } catch (_: Exception) {
        // Fall through: dataSync keeps the session alive, though the OS may
        // limit a long session started with it. Documented in docs/peer-vpn.md.
      }
    }
    startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
  }

  private fun buildNotification(pairing: Boolean): Notification {
    val text = if (pairing) getString(R.string.vpn_notification_pairing) else getString(R.string.vpn_notification_connected)
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_kepos)
      .setContentTitle(getString(R.string.app_name))
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
  }

  /**
   * IPv4 with a /32 address and one /32 route per receiver; DNS, IPv6 and UDP
   * stay on the physical network.
   */
  private fun establishTun(request: TunRequest): TunSink {
    val builder =
      Builder()
        .setSession(SESSION_NAME)
        .setMtu(VPN_MTU)
        .setBlocking(true)
        .addAddress(request.address, 32)
    for (peer in request.peerAddresses) builder.addRoute(peer, 32)
    try {
      // Kepos itself must reach the underlay outside this tunnel. The
      // TypeScript DHT facade exposes no socket descriptor, so per-socket
      // protect() is not available and is not claimed.
      builder.addDisallowedApplication(packageName)
    } catch (_: Exception) {
      fail(TunnelFailure.Permission)
    }
    val descriptor = builder.establish() ?: fail(TunnelFailure.Permission)
    return AndroidTunSink(descriptor)
  }

  internal companion object {
    const val ACTION_PAIR = "io.lamplitisles.kepos.action.PAIR"
    const val ACTION_CONNECT = "io.lamplitisles.kepos.action.CONNECT"
    const val ACTION_STOP = "io.lamplitisles.kepos.action.STOP"
    const val EXTRA_INVITATION = "io.lamplitisles.kepos.extra.INVITATION"
    const val EXTRA_EPOCH = "io.lamplitisles.kepos.extra.EPOCH"

    private const val CHANNEL_ID = "peer-vpn"
    private const val NOTIFICATION_ID = 1
    private const val SESSION_NAME = "Kepos peer VPN"

    fun pair(context: Context, invitation: String, epoch: Long): Boolean =
      dispatch(
        context,
        Intent(context, KeposVpnService::class.java)
          .setAction(ACTION_PAIR)
          .putExtra(EXTRA_INVITATION, invitation)
          .putExtra(EXTRA_EPOCH, epoch),
        foreground = true,
      )

    fun connect(context: Context, epoch: Long): Boolean =
      dispatch(
        context,
        Intent(context, KeposVpnService::class.java).setAction(ACTION_CONNECT).putExtra(EXTRA_EPOCH, epoch),
        foreground = true,
      )

    fun stop(context: Context, epoch: Long?): Boolean {
      val intent = Intent(context, KeposVpnService::class.java).setAction(ACTION_STOP)
      if (epoch != null) intent.putExtra(EXTRA_EPOCH, epoch)
      if (dispatch(context, intent, foreground = false)) return true
      return dispatch(context, intent, foreground = true)
    }

    private fun dispatch(context: Context, intent: Intent, foreground: Boolean): Boolean =
      try {
        if (foreground) context.startForegroundService(intent) else context.startService(intent)
        true
      } catch (_: Exception) {
        false
      }
  }
}
