package io.lamplitisles.kepos.vpn

import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.DirectoryIteratorException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters

/** A seed-only peer identity is unusable for any operation. */
internal class IdentityException : Exception()

internal object Hex {
  private const val DIGITS = "0123456789abcdef"

  fun encode(bytes: ByteArray): String {
    val text = StringBuilder(bytes.size * 2)
    for (byte in bytes) {
      val value = byte.toInt() and 0xff
      text.append(DIGITS[value ushr 4]).append(DIGITS[value and 0x0f])
    }
    return text.toString()
  }

  fun decode(text: String): ByteArray? {
    if (text.length % 2 != 0) return null
    val bytes = ByteArray(text.length / 2)
    for (index in bytes.indices) {
      val high = DIGITS.indexOf(text[index * 2])
      val low = DIGITS.indexOf(text[index * 2 + 1])
      if (high < 0 || low < 0) return null
      bytes[index] = ((high shl 4) or low).toByte()
    }
    return bytes
  }

  fun isPublicKey(value: String): Boolean = value.length == 64 && decode(value) != null
}

/**
 * Seed to Ed25519 public key, the same RFC 8032 expansion libsodium performs
 * inside the worklet (`crypto_sign_seed_keypair`). Only the lightweight
 * Bouncy Castle API is used; no global JCA provider is installed and no
 * signature is produced.
 */
internal object PublicKey {
  fun derive(seed: ByteArray): ByteArray {
    require(seed.size == 32) { "a peer seed is 32 bytes" }
    val encoded = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
    check(encoded.size == 32) { "invalid Ed25519 public key" }
    return encoded
  }

  fun deriveHex(seed: ByteArray): String = Hex.encode(derive(seed))
}

/** A bearer secret. It must never appear in an error, log or crash report. */
internal data class Invitation(val receiverKey: String, val secret: String) {
  companion object {
    private val pattern = Regex("^kepos1:([0-9a-f]{64}):([0-9a-f]{64})$")

    fun parse(value: String): Invitation? {
      if (value.length > 256) return null
      val match = pattern.matchEntire(value) ?: return null
      return Invitation(match.groupValues[1], match.groupValues[2])
    }
  }
}

/**
 * Seed-only identity with the same on-disk contract as the Mac and iPhone
 * clients: a 0700 directory holding exactly one 0600 `peer.json` with
 * `{"seed": "<64 lowercase hex>"}`. Existing identities are never replaced,
 * rewritten or followed through a symlink.
 */
internal class IdentityStore(private val root: File, private val sync: DirectorySync = DirectorySync.None) {
  val directory: File = File(root, "peer")

  /** Reads an existing identity; never creates files. */
  fun existingPublicKey(): String = PublicKey.deriveHex(readSeed())

  fun readSeed(): ByteArray {
    // Every failure below is a local state fault: a filesystem error must reach
    // the UI as an identity failure, never as a crash on the caller's thread.
    try {
      validateDirectory(directory.toPath())
      // DirectoryStream is a plain Iterable: java.util.stream is avoided here
      // because Stream.toList is API 34 and this device floor is 29.
      val entries =
        Files.newDirectoryStream(directory.toPath()).use { entries -> entries.map { it.fileName.toString() } }
      if (entries.size != 1 || entries[0] != "peer.json") throw IdentityException()
      return readSeedFile(File(directory, "peer.json").toPath())
    } catch (_: IOException) {
      throw IdentityException()
    } catch (_: DirectoryIteratorException) {
      // A listing error arrives already wrapped in this unchecked exception.
      throw IdentityException()
    }
  }

  /**
   * Creates an identity only when none exists. A concurrent creator wins and
   * its identity is preserved.
   */
  fun prepare(): String {
    prepareRoot()
    if (Files.exists(directory.toPath(), LinkOption.NOFOLLOW_LINKS)) return existingPublicKey()
    val temporary = File(root, ".kepos-identity-${UUID.randomUUID()}")
    val temporaryPath = temporary.toPath()
    try {
      Files.createDirectory(temporaryPath, PosixFilePermissions.asFileAttribute(DIRECTORY_PERMISSIONS))
      writeSeedFile(File(temporary, "peer.json").toPath())
      sync.sync(temporary)
      try {
        Files.move(temporaryPath, directory.toPath())
      } catch (error: java.nio.file.FileAlreadyExistsException) {
        // Another creator won the race; never replace its identity.
        return existingPublicKey()
      } catch (error: java.nio.file.DirectoryNotEmptyException) {
        return existingPublicKey()
      }
      sync.sync(root)
      return existingPublicKey()
    } catch (error: IdentityException) {
      throw error
    } catch (error: IOException) {
      throw IdentityException()
    } finally {
      // Leftovers of a failed creation belong to this call only.
      if (Files.exists(temporaryPath, LinkOption.NOFOLLOW_LINKS)) {
        try {
          Files.deleteIfExists(File(temporary, "peer.json").toPath())
          Files.deleteIfExists(temporaryPath)
        } catch (_: IOException) {
          // A leftover temporary directory is inert; it is never read as an identity.
        }
      }
    }
  }

  private fun writeSeedFile(path: Path) {
    val seed = ByteArray(32)
    SecureRandom().nextBytes(seed)
    Files.createFile(path, PosixFilePermissions.asFileAttribute(FILE_PERMISSIONS))
    val payload = "{\n  \"seed\": \"${Hex.encode(seed)}\"\n}\n".toByteArray()
    FileChannel.open(path, StandardOpenOption.WRITE).use { channel ->
      val buffer = java.nio.ByteBuffer.wrap(payload)
      while (buffer.hasRemaining()) channel.write(buffer)
      channel.force(true)
    }
    seed.fill(0)
  }

  private fun readSeedFile(path: Path): ByteArray {
    val attributes = Files.readAttributes(path, java.nio.file.attribute.PosixFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    if (!attributes.isRegularFile || Files.isSymbolicLink(path)) throw IdentityException()
    if (attributes.permissions() != FILE_PERMISSIONS) throw IdentityException()
    if (attributes.size() < 1 || attributes.size() > 4096) throw IdentityException()
    val contents = Files.readAllBytes(path)
    if (contents.size > 4096) throw IdentityException()
    val value = try {
      Json.parseToJsonElement(contents.decodeToString())
    } catch (_: Exception) {
      throw IdentityException()
    }
    if (value !is JsonObject || value.keys != setOf("seed")) throw IdentityException()
    val text = try {
      value["seed"]?.jsonPrimitive?.content ?: throw IdentityException()
    } catch (_: Exception) {
      throw IdentityException()
    }
    return Hex.decode(text)?.takeIf { it.size == 32 } ?: throw IdentityException()
  }

  private fun validateDirectory(path: Path) {
    if (Files.isSymbolicLink(path)) throw IdentityException()
    val attributes = try {
      Files.readAttributes(path, java.nio.file.attribute.PosixFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (_: IOException) {
      throw IdentityException()
    }
    if (!attributes.isDirectory || attributes.permissions() != DIRECTORY_PERMISSIONS) throw IdentityException()
  }

  private fun prepareRoot() {
    try {
      if (!Files.exists(root.toPath(), LinkOption.NOFOLLOW_LINKS)) {
        Files.createDirectory(root.toPath(), PosixFilePermissions.asFileAttribute(DIRECTORY_PERMISSIONS))
      }
    } catch (error: IOException) {
      throw IdentityException()
    }
  }

  companion object {
    val DIRECTORY_PERMISSIONS: Set<PosixFilePermission> = PosixFilePermissions.fromString("rwx------")
    val FILE_PERMISSIONS: Set<PosixFilePermission> = PosixFilePermissions.fromString("rw-------")
  }
}
