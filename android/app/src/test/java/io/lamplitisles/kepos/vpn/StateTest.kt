package io.lamplitisles.kepos.vpn

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.PosixFilePermissions
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** A root owned by one test; it never touches app or user state. */
internal class TempRoot : AutoCloseable {
  val directory: File = Files.createTempDirectory("kepos-android-test-").toFile()

  init {
    Files.setPosixFilePermissions(directory.toPath(), PosixFilePermissions.fromString("rwx------"))
  }

  override fun close() {
    directory.deleteRecursively()
  }
}

class IdentityTest {
  private val root = TempRoot()

  @After
  fun cleanUp() = root.close()

  @Test
  fun `prepare creates a seed-only identity with restrictive permissions`() {
    val store = IdentityStore(root.directory)
    val publicKey = store.prepare()

    assertEquals(64, publicKey.length)
    assertTrue(publicKey.all { it in '0'..'9' || it in 'a'..'f' })
    assertEquals(
      PosixFilePermissions.fromString("rwx------"),
      Files.getPosixFilePermissions(store.directory.toPath()),
    )
    val file = File(store.directory, "peer.json")
    assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(file.toPath()))
    val text = file.readText()
    assertTrue(Regex("""^\{\s*"seed": "[0-9a-f]{64}"\s*}\s*$""").matches(text))
    assertEquals(publicKey, store.existingPublicKey())
  }

  @Test
  fun `prepare never replaces an existing identity`() {
    val store = IdentityStore(root.directory)
    val first = store.prepare()
    val second = store.prepare()
    assertEquals(first, second)
    assertEquals(listOf("peer.json"), store.directory.list()!!.toList())
  }

  @Test
  fun `existing identity is not created by a read`() {
    val store = IdentityStore(root.directory)
    assertThrows(IdentityException::class.java) { store.existingPublicKey() }
    assertFalse(File(root.directory, "peer").exists())
  }

  @Test
  fun `unexpected entries, permissions and contents are rejected`() {
    val store = IdentityStore(root.directory)
    store.prepare()
    File(store.directory, "extra").writeText("x")
    assertThrows(IdentityException::class.java) { store.readSeed() }
    File(store.directory, "extra").delete()

    val file = File(store.directory, "peer.json")
    Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rw-r--r--"))
    assertThrows(IdentityException::class.java) { store.readSeed() }
    Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rw-------"))

    file.writeText("""{"seed":"00"}""")
    assertThrows(IdentityException::class.java) { store.readSeed() }
    file.writeText("""{"seed":"${"g".repeat(64)}"}""")
    assertThrows(IdentityException::class.java) { store.readSeed() }
    file.writeText("""{"seed":"${"a".repeat(64)}","extra":"x"}""")
    assertThrows(IdentityException::class.java) { store.readSeed() }
  }

  @Test
  fun `directory permissions are enforced`() {
    val store = IdentityStore(root.directory)
    store.prepare()
    Files.setPosixFilePermissions(store.directory.toPath(), PosixFilePermissions.fromString("rwxr-xr-x"))
    assertThrows(IdentityException::class.java) { store.readSeed() }
  }

  @Test
  fun `seed derives the RFC 8032 public key`() {
    // RFC 8032 section 7.1, first test vector.
    val seed = Hex.decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")!!
    assertEquals("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", PublicKey.deriveHex(seed))
  }

  @Test
  fun `seed derives the same public key as the worklet keypair`() {
    // Cross-checked against hypercore-crypto (libsodium) for this fixed seed.
    val seed = Hex.decode("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")!!
    assertEquals("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8", PublicKey.deriveHex(seed))
  }

  @Test
  fun `a directory sync failure never claims a durable identity`() {
    val refusing = IdentityStore(root.directory, DirectorySync { throw IOException("directory fsync refused") })
    assertThrows(IdentityException::class.java) { refusing.prepare() }
    assertFalse(File(root.directory, "peer").exists())

    // A later attempt with a working sync still creates a usable identity.
    assertEquals(64, IdentityStore(root.directory).prepare().length)
  }

  @Test
  fun `an existing identity survives a failing directory sync`() {
    val key = IdentityStore(root.directory).prepare()
    val refusing = IdentityStore(root.directory, DirectorySync { throw IOException("directory fsync refused") })
    assertEquals(key, refusing.prepare())
    assertEquals(key, IdentityStore(root.directory).existingPublicKey())
    assertEquals(listOf("peer.json"), File(root.directory, "peer").list()!!.toList())
  }

  @Test
  fun `invalid invitations are rejected`() {
    val key = "a".repeat(64)
    assertNull(Invitation.parse("kepos1:$key"))
    assertNull(Invitation.parse("KEPOS1:$key:$key"))
    assertNull(Invitation.parse("kepos1:${"A".repeat(64)}:$key"))
    assertNull(Invitation.parse("kepos1:$key:$key:extra"))
    assertEquals(Invitation(key, key), Invitation.parse("kepos1:$key:$key"))
  }
}

class ManagedConfigTest {
  private val root = TempRoot()
  private val receiverKey = "b".repeat(64)

  @After
  fun cleanUp() = root.close()

  @Test
  fun `addresses must be unicast IPv4 without leading zeros`() {
    assertTrue(ManagedConfig.validAddress("198.18.20.5"))
    assertFalse(ManagedConfig.validAddress("0.1.2.3"))
    assertFalse(ManagedConfig.validAddress("127.0.0.1"))
    assertFalse(ManagedConfig.validAddress("224.0.0.1"))
    assertFalse(ManagedConfig.validAddress("169.254.1.1"))
    assertFalse(ManagedConfig.validAddress("198.18.20"))
    assertFalse(ManagedConfig.validAddress("198.18.20.05"))
    assertFalse(ManagedConfig.validAddress("198.18.20.256"))
    assertFalse(ManagedConfig.validAddress("198.18.20.5.6"))
    assertFalse(ManagedConfig.validAddress(" 198.18.20.5"))
  }

  @Test
  fun `tunnel configuration matches the shared engine shape`() {
    val config = ManagedConfig("198.18.20.5", "198.18.20.1", receiverKey)
    val text = config.tunnelConfig
    assertTrue(text.contains("""label = "receiver""""))
    assertTrue(text.contains("""public_key = "$receiverKey""""))
    assertTrue(text.contains("""address = "198.18.20.5""""))
    assertTrue(text.contains("""allow_tcp = []"""))
    assertFalse(text.contains("seed"))
  }

  @Test
  fun `pairing configuration is rejected when self-addressed or malformed`() {
    val element = buildJsonObject {
      put("address", "198.18.20.5")
      put("receiverAddress", "198.18.20.5")
      put("receiverKey", receiverKey)
    }
    assertNull(ManagedConfig.parse(element))
  }

  @Test
  fun `store starts empty, round trips and stays private`() {
    val store = ManagedConfigStore(root.directory)
    assertNull(store.read())
    val file = File(root.directory, "config.json")
    assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(file.toPath()))
    assertEquals("{}\n", file.readText())

    val config = ManagedConfig("198.18.20.5", "198.18.20.1", receiverKey)
    store.save(config)
    assertEquals(config, store.read())
    assertFalse(file.readText().contains("seed"))
  }

  @Test
  fun `corrupt configuration fails instead of being replaced`() {
    val store = ManagedConfigStore(root.directory)
    store.read()
    val file = File(root.directory, "config.json")
    file.writeText("""{"address":"198.18.20.5"}""")
    assertThrows(VpnFailure::class.java) { store.read() }
    assertThrows(VpnFailure::class.java) { store.save(ManagedConfig("198.18.20.5", "198.18.20.1", receiverKey)) }
  }

  @Test
  fun `configuration file permissions are enforced`() {
    val store = ManagedConfigStore(root.directory)
    store.read()
    val file = File(root.directory, "config.json")
    Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rw-r--r--"))
    assertThrows(VpnFailure::class.java) { store.read() }
  }
}

class PeerStateTest {
  private val root = TempRoot()
  private val receiverKey = "c".repeat(64)

  @After
  fun cleanUp() = root.close()

  @Test
  fun `unpaired state creates an identity and reports no pairing`() {
    val state = PeerState(root.directory)
    val managed = state.prepare()
    assertFalse(managed.paired)
    assertEquals(state.identity.existingPublicKey(), managed.publicKey)
  }

  @Test
  fun `a paired state never creates a missing identity`() {
    val state = PeerState(root.directory)
    state.store.save(ManagedConfig("198.18.20.5", "198.18.20.1", receiverKey))
    val failure = assertThrows(VpnFailure::class.java) { state.prepare() }
    assertEquals(TunnelFailure.Identity, failure.reason)
    assertFalse(File(root.directory, "peer").exists())
  }

  @Test
  fun `paired state reports the stored configuration`() {
    val state = PeerState(root.directory)
    assertEquals(64, state.prepare().publicKey.length)
    state.store.save(ManagedConfig("198.18.20.5", "198.18.20.1", receiverKey))
    val managed = state.prepare()
    assertTrue(managed.paired)
    assertEquals(state.identity.existingPublicKey(), managed.publicKey)
  }

  @Test
  fun `a symlink at the lock path is refused and its target is untouched`() {
    val state = PeerState(root.directory)
    state.store.prepareDirectory()
    val target = File(root.directory, "unrelated.txt").apply { writeText("keep") }
    Files.setPosixFilePermissions(target.toPath(), PosixFilePermissions.fromString("rw-r--r--"))
    Files.createSymbolicLink(File(root.directory, PeerState.LOCK_NAME).toPath(), target.toPath())

    val failure = assertThrows(VpnFailure::class.java) { state.acquireLock() }
    assertEquals(TunnelFailure.LocalState, failure.reason)
    assertEquals(
      PosixFilePermissions.fromString("rw-r--r--"),
      Files.getPosixFilePermissions(target.toPath()),
    )
    assertEquals("keep", target.readText())
  }

  @Test
  fun `an unreadable identity file is an identity failure, never a raw exception`() {
    val state = PeerState(root.directory)
    state.prepare()
    val file = File(state.identity.directory, "peer.json")
    Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rw-r--r--"))

    val failure = assertThrows(VpnFailure::class.java) { state.prepare() }
    assertEquals(TunnelFailure.Identity, failure.reason)
  }

  @Test
  fun `a pending marker survives an older configuration until acknowledged`() {
    val state = PeerState(root.directory)
    state.prepare()
    state.store.save(ManagedConfig("198.18.20.5", "198.18.20.1", receiverKey))
    state.markPairingPending()

    // An older configuration cannot prove what this attempt's receiver decided.
    val managed = state.prepare()
    assertTrue(managed.paired)
    assertTrue(managed.pairingPending)
    assertTrue(state.pairingPending())
    assertTrue(state.clearPairingPending())
    assertFalse(state.pairingPending())
  }

  @Test
  fun `an unconfirmed marker is never replaced by a newer attempt`() {
    val state = PeerState(root.directory)
    state.prepare()
    state.markPairingPending()
    val marker = File(state.root, PeerState.PENDING_NAME)
    val before = marker.readBytes()

    val failure = assertThrows(VpnFailure::class.java) { state.markPairingPending() }
    assertEquals(TunnelFailure.PairingUnknown, failure.reason)
    assertArrayEquals(before, marker.readBytes())
  }

  @Test
  fun `a marker that cannot be made durable fails without claiming it`() {
    val state = PeerState(root.directory, DirectorySync { throw IOException("directory fsync refused") })
    val failure = assertThrows(VpnFailure::class.java) { state.markPairingPending() }
    assertEquals(TunnelFailure.LocalState, failure.reason)
  }

  @Test
  fun `a marker that cannot be removed stays and is reported`() {
    PeerState(root.directory).apply {
      prepare()
      markPairingPending()
    }
    val refusing = PeerState(root.directory, DirectorySync { throw IOException("directory fsync refused") })

    // The entry is gone from the live tree but its removal is not durable, so
    // the caller must still treat the marker as possibly present.
    assertFalse(refusing.clearPairingPending())
  }

  @Test
  fun `a removal is only proven durable when the directory sync succeeds`() {
    PeerState(root.directory).apply {
      prepare()
      markPairingPending()
    }
    val marker = File(root.directory, PeerState.PENDING_NAME)
    var refuse = true
    val state = PeerState(root.directory, DirectorySync { if (refuse) throw IOException("directory fsync refused") })

    // The entry disappears from the live tree, but the removal is not durable.
    assertFalse(state.clearPairingPending())
    assertFalse(Files.exists(marker.toPath(), LinkOption.NOFOLLOW_LINKS))
    // A retry must not report success while the sync still fails, even though
    // the entry is already gone.
    assertFalse(state.clearPairingPending())
    // Only a successful sync proves the earlier removal.
    refuse = false
    assertTrue(state.clearPairingPending())
  }

  @Test
  fun `a symlink at the marker path is refused`() {
    val state = PeerState(root.directory)
    state.prepare()
    state.store.prepareDirectory()
    val target = File(root.directory, "unrelated.txt").apply { writeText("keep") }
    Files.createSymbolicLink(File(root.directory, PeerState.PENDING_NAME).toPath(), target.toPath())

    val failure = assertThrows(VpnFailure::class.java) { state.pairingPending() }
    assertEquals(TunnelFailure.LocalState, failure.reason)
    assertEquals("keep", target.readText())
  }

  @Test
  fun `the identity lock is exclusive within the process`() {
    val state = PeerState(root.directory)
    val held = state.acquireLock()
    val failure = assertThrows(VpnFailure::class.java) { state.acquireLock() }
    assertEquals(TunnelFailure.IdentityInUse, failure.reason)
    held.close()
    state.acquireLock().close()
  }
}
