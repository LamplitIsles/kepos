package io.lamplitisles.kepos.vpn

import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Makes a directory entry durable. Implementations must throw when the entry
 * may not survive a crash, so no caller reports durable state it cannot prove.
 * The JVM has no directory fsync, so tests substitute their own.
 */
internal fun interface DirectorySync {
  fun sync(directory: File)

  companion object {
    val None = DirectorySync { }
  }
}

/**
 * The paired receiver for this device: the address allocated to this device,
 * the receiver's overlay address and its public key. Nothing else is stored.
 */
internal data class ManagedConfig(
  val address: String,
  val receiverAddress: String,
  val receiverKey: String,
) {
  /** The engine configuration handed to the worklet; identical shape to iOS. */
  val tunnelConfig: String
    get() = """
      peers = [{ label = "receiver", public_key = "$receiverKey", connection = "dial" }]
      [vpn]
      address = "$address"
      peers = [{ peer = "receiver", address = "$receiverAddress", allow_tcp = [] }]
    """.trimIndent()

  val value: Map<String, String>
    get() = mapOf("address" to address, "receiverAddress" to receiverAddress, "receiverKey" to receiverKey)

  companion object {
    fun parse(element: JsonObject): ManagedConfig? {
      if (element.keys != setOf("address", "receiverAddress", "receiverKey")) return null
      val address = (element["address"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      val receiverAddress = (element["receiverAddress"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      val receiverKey = (element["receiverKey"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      if (!validAddress(address) || !validAddress(receiverAddress) || address == receiverAddress) return null
      if (!Hex.isPublicKey(receiverKey)) return null
      return ManagedConfig(address, receiverAddress, receiverKey)
    }

    /** The overlay uses unicast IPv4 only; DNS and IPv6 stay outside it. */
    fun validAddress(value: String): Boolean {
      val parts = value.split('.', limit = 5)
      if (parts.size != 4) return false
      val bytes = IntArray(4)
      for (index in 0 until 4) {
        val part = parts[index]
        if (part.isEmpty() || part.length > 3) return false
        if (part.length > 1 && part[0] == '0') return false
        if (part.any { it !in '0'..'9' }) return false
        val number = part.toIntOrNull() ?: return false
        if (number > 255) return false
        bytes[index] = number
      }
      return bytes[0] != 0 && bytes[0] != 127 && bytes[0] < 224 && !(bytes[0] == 169 && bytes[1] == 254)
    }
  }
}

/**
 * `config.json` in the app-managed directory. An empty object is the unpaired
 * template; any other shape fails instead of being partially accepted.
 */
internal class ManagedConfigStore(private val root: File, private val sync: DirectorySync = DirectorySync.None) {
  private val file = File(root, "config.json")

  fun prepareDirectory() {
    try {
      if (!Files.exists(root.toPath(), LinkOption.NOFOLLOW_LINKS)) {
        Files.createDirectory(root.toPath(), PosixFilePermissions.asFileAttribute(IdentityStore.DIRECTORY_PERMISSIONS))
      }
    } catch (error: IOException) {
      fail(TunnelFailure.LocalState)
    }
    if (Files.isSymbolicLink(root.toPath())) fail(TunnelFailure.LocalState)
    val attributes = try {
      Files.readAttributes(root.toPath(), java.nio.file.attribute.PosixFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (_: IOException) {
      fail(TunnelFailure.LocalState)
    }
    if (!attributes.isDirectory || attributes.permissions() != IdentityStore.DIRECTORY_PERMISSIONS) fail(TunnelFailure.LocalState)
  }

  fun read(): ManagedConfig? {
    prepareDirectory()
    val path = file.toPath()
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
      createTemplate(path)
    }
    val attributes = try {
      Files.readAttributes(path, java.nio.file.attribute.PosixFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (_: IOException) {
      fail(TunnelFailure.LocalState)
    }
    if (Files.isSymbolicLink(path) || !attributes.isRegularFile) fail(TunnelFailure.LocalState)
    if (attributes.permissions() != IdentityStore.FILE_PERMISSIONS) fail(TunnelFailure.LocalState)
    if (attributes.size() < 1 || attributes.size() > 4096) fail(TunnelFailure.LocalState)
    val contents = try {
      Files.readAllBytes(path)
    } catch (_: IOException) {
      fail(TunnelFailure.LocalState)
    }
    if (contents.size > 4096) fail(TunnelFailure.LocalState)
    val element = try {
      Json.parseToJsonElement(contents.decodeToString())
    } catch (_: Exception) {
      fail(TunnelFailure.LocalState)
    }
    val object_ = element as? JsonObject ?: fail(TunnelFailure.LocalState)
    if (object_.isEmpty()) return null
    return ManagedConfig.parse(object_) ?: fail(TunnelFailure.LocalState)
  }

  /** Durable before it returns: the caller may report pairing success after it. */
  fun save(config: ManagedConfig) {
    read() // Validate the current template or configuration before replacing it.
    val directory = root.toPath()
    val temporary = directory.resolve(".config-${UUID.randomUUID()}")
    try {
      Files.createFile(temporary, PosixFilePermissions.asFileAttribute(IdentityStore.FILE_PERMISSIONS))
      val payload = buildJsonObject {
        put("address", config.address)
        put("receiverAddress", config.receiverAddress)
        put("receiverKey", config.receiverKey)
      }.toString().toByteArray()
      FileChannel.open(temporary, StandardOpenOption.WRITE).use { channel ->
        val buffer = java.nio.ByteBuffer.wrap(payload)
        while (buffer.hasRemaining()) channel.write(buffer)
        channel.force(true)
      }
      Files.move(temporary, file.toPath(), StandardCopyOption.ATOMIC_MOVE)
      sync.sync(root)
    } catch (_: IOException) {
      fail(TunnelFailure.LocalState)
    } finally {
      try {
        Files.deleteIfExists(temporary)
      } catch (_: IOException) {
        // A leftover temporary file is inert and is never read as configuration.
      }
    }
  }

  private fun createTemplate(path: java.nio.file.Path) {
    try {
      Files.createFile(path, PosixFilePermissions.asFileAttribute(IdentityStore.FILE_PERMISSIONS))
      FileChannel.open(path, StandardOpenOption.WRITE).use { channel ->
        val buffer = java.nio.ByteBuffer.wrap("{}\n".toByteArray())
        while (buffer.hasRemaining()) channel.write(buffer)
        channel.force(true)
      }
      sync.sync(root)
    } catch (error: java.nio.file.FileAlreadyExistsException) {
      // Another writer created it; read() validates what is there.
    } catch (_: IOException) {
      fail(TunnelFailure.LocalState)
    }
  }
}

/** Public managed state; it never contains the seed, lock or invitation. */
internal data class ManagedState(
  val publicKey: String,
  val paired: Boolean,
  /**
   * True when an earlier invitation may have been admitted by the receiver and
   * no definite outcome is known. Only an explicit acknowledgement clears it.
   */
  val pairingPending: Boolean = false,
)

/**
 * Sole owner of the app identity, configuration and runtime lock. A lock is
 * advisory, per-process and released by the kernel if the process dies.
 */
internal class PeerState(val root: File, private val sync: DirectorySync = DirectorySync.None) {
  val identity = IdentityStore(root, sync)
  val store = ManagedConfigStore(root, sync)

  fun acquireLock(): IdentityLock {
    store.prepareDirectory()
    val path = File(root, LOCK_NAME).toPath()
    // Create with O_CREAT|O_EXCL and a 0600 attribute, then open without
    // following links. Permissions are never changed by path afterwards, so a
    // link planted at this path cannot make the app chmod another file.
    try {
      Files.createFile(path, PosixFilePermissions.asFileAttribute(IdentityStore.FILE_PERMISSIONS))
    } catch (_: java.nio.file.FileAlreadyExistsException) {
      // An existing lock file is validated below; it is never replaced.
    } catch (_: IOException) {
      fail(TunnelFailure.LocalState)
    }
    val channel = try {
      FileChannel.open(path, StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)
    } catch (_: IOException) {
      fail(TunnelFailure.LocalState)
    }
    try {
      val attributes = Files.readAttributes(path, java.nio.file.attribute.PosixFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
      if (Files.isSymbolicLink(path) || !attributes.isRegularFile ||
        attributes.permissions() != IdentityStore.FILE_PERMISSIONS
      ) {
        channel.close()
        fail(TunnelFailure.LocalState)
      }
    } catch (_: IOException) {
      runCatching { channel.close() }
      fail(TunnelFailure.LocalState)
    }
    val lock = try {
      channel.tryLock()
    } catch (_: OverlappingFileLockException) {
      null
    } catch (_: IOException) {
      runCatching { channel.close() }
      fail(TunnelFailure.LocalState)
    }
    if (lock == null) {
      runCatching { channel.close() }
      fail(TunnelFailure.IdentityInUse)
    }
    return IdentityLock(channel, lock)
  }

  /**
   * Reads public managed state. An existing identity and an existing
   * configuration are never created or replaced by a passive read.
   */
  fun prepare(holdingLock: Boolean = false): ManagedState {
    val lock = if (holdingLock) null else acquireLock()
    try {
      val config = store.read()
      val publicKey = if (config == null && !holdingLock) identity.prepare() else identity.existingPublicKey()
      return ManagedState(publicKey, config != null, pairingPending = readPairingPending())
    } catch (error: IdentityException) {
      fail(TunnelFailure.Identity)
    } finally {
      lock?.close()
    }
  }

  /**
   * Reads the pending marker under the same lock as the identity. Any file at
   * that path means an invitation may have left this device; its contents are
   * never used to decide otherwise, and it carries no secret.
   */
  fun pairingPending(holdingLock: Boolean = false): Boolean {
    val lock = if (holdingLock) null else acquireLock()
    try {
      return readPairingPending()
    } finally {
      lock?.close()
    }
  }

  /**
   * Makes the pending marker durable before an invitation can be submitted.
   * An unconfirmed attempt is never overwritten by a newer one.
   */
  fun markPairingPending(holdingLock: Boolean = false) {
    val lock = if (holdingLock) null else acquireLock()
    try {
      store.prepareDirectory()
      val path = pending.toPath()
      try {
        val channel =
          FileChannel.open(
            path,
            setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
            PosixFilePermissions.asFileAttribute(IdentityStore.FILE_PERMISSIONS),
          )
        channel.use { open ->
          open.write(ByteBuffer.wrap(PENDING_CONTENT))
          open.force(true)
        }
      } catch (_: java.nio.file.FileAlreadyExistsException) {
        // The earlier invitation may already be admitted; it is never replaced.
        fail(TunnelFailure.PairingUnknown)
      } catch (_: IOException) {
        fail(TunnelFailure.LocalState)
      }
      try {
        sync.sync(root)
      } catch (_: IOException) {
        fail(TunnelFailure.LocalState)
      }
    } finally {
      lock?.close()
    }
  }

  /**
   * Durable removal: true only when the entry removal is proven to survive a
   * crash. The directory is synced even when the entry is already gone, because
   * an earlier removal may never have reached the disk.
   */
  fun clearPairingPending(holdingLock: Boolean = false): Boolean {
    val lock = if (holdingLock) null else acquireLock()
    try {
      return try {
        Files.deleteIfExists(pending.toPath())
        sync.sync(root)
        true
      } catch (_: IOException) {
        false
      }
    } finally {
      lock?.close()
    }
  }

  private fun readPairingPending(): Boolean {
    val path = pending.toPath()
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return false
    val attributes =
      try {
        Files.readAttributes(
          path,
          java.nio.file.attribute.PosixFileAttributes::class.java,
          LinkOption.NOFOLLOW_LINKS,
        )
      } catch (_: IOException) {
        fail(TunnelFailure.LocalState)
      }
    if (Files.isSymbolicLink(path) || !attributes.isRegularFile) fail(TunnelFailure.LocalState)
    return true
  }

  /** A pairing reply may be returned only after its configuration is durable. */
  fun commitPair(config: ManagedConfig, publicKey: String): ManagedState {
    store.save(config)
    return ManagedState(publicKey, paired = true)
  }

  companion object {
    const val LOCK_NAME = ".peer.peer.runtime.lock"

    /** Constant content, so the marker can never carry an invitation or seed. */
    private val PENDING_CONTENT = "pending\n".toByteArray()

    const val PENDING_NAME = "pairing-pending"
  }

  private val pending = File(root, PENDING_NAME)
}

internal class IdentityLock(private val channel: FileChannel, private val lock: java.nio.channels.FileLock) : AutoCloseable {
  override fun close() {
    runCatching { lock.release() }
    runCatching { channel.close() }
  }
}
