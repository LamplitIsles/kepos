package io.lamplitisles.kepos.vpn

import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Runs the real identity read in a child JVM with a small descriptor limit, so
 * a real "too many open files" error reaches the production code while the
 * machine-wide descriptor table stays untouched. Prints one line per read.
 */
object DescriptorLimitProbe {
  @JvmStatic
  fun main(args: Array<String>) {
    val root = File(args[0])
    val store = IdentityStore(root)
    store.prepare()
    val held = mutableListOf<FileInputStream>()
    try {
      val seed = File(store.directory, "peer.json")
      while (true) {
        try {
          held += FileInputStream(seed)
        } catch (_: IOException) {
          break
        }
      }
      println("readSeed=${outcome { store.readSeed() }}")
      println("prepare=${outcome { PeerState(root).prepare() }}")
    } finally {
      held.forEach { runCatching { it.close() } }
    }
  }

  private fun outcome(block: () -> Any?): String =
    try {
      block()
      "none"
    } catch (error: Throwable) {
      if (error is VpnFailure) "VpnFailure:${error.reason}" else error.javaClass.name
    }
}

class DescriptorLimitTest {
  private val root = TempRoot()

  @After
  fun cleanUp() = root.close()

  @Test
  fun `a descriptor limit failure is an identity failure, not an IOException`() {
    val java = File(System.getProperty("java.home"), "bin/java").path
    // The limit and the exec live in shell source; every path is passed as an
    // argument so no quoting can break it.
    val command = listOf(
      "bash",
      "-c",
      "ulimit -n 256; exec \"$@\"",
      "descriptor-probe",
      java,
      "-Xmx192m",
      "-cp",
      System.getProperty("java.class.path"),
      "io.lamplitisles.kepos.vpn.DescriptorLimitProbe",
      root.directory.path,
    )
    val process = ProcessBuilder(command).redirectErrorStream(true).start()
    if (!process.waitFor(120, TimeUnit.SECONDS)) {
      // The probe is still alive: kill it before touching its output, which
      // would otherwise wait for an end-of-stream that never comes.
      process.destroyForcibly()
      fail("the probe did not finish within 120s")
    }
    val output = process.inputStream.bufferedReader().readText()

    assertEquals(output, 0, process.exitValue())
    // A raw IOException here would reach the caller's thread and end the app.
    assertTrue(output, output.contains("readSeed=${IdentityException::class.java.name}"))
    assertTrue(output, output.contains("prepare=VpnFailure:${TunnelFailure.LocalState}"))
  }
}
