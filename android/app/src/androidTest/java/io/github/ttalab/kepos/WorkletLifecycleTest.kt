package io.github.ttalab.kepos

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.IBinder
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleCallback
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkletLifecycleTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private lateinit var connection: TestServiceConnection

  @Before
  fun startCleanService() {
    InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(
      context.packageName,
      Manifest.permission.POST_NOTIFICATIONS,
    )
    context.stopService(Intent(context, KeposForegroundService::class.java))
    KeposForegroundService.start(context)
    connection = TestServiceConnection(context)
  }

  @After
  fun stopService() {
    if (::connection.isInitialized) connection.close()
    context.stopService(Intent(context, KeposForegroundService::class.java))
  }

  @Test
  fun workletAndListenerSurviveActivityRecreationUntilExplicitStop() {
    val binder = connection.awaitBinder()
    val first = binder.awaitState(RuntimeState.RUNNING)
    assertEquals(first.runtimeId, binder.ping().get(10, TimeUnit.SECONDS).runtimeId)
    assertNotNull(first.subscriberPublicKey)
    assertTrue(checkNotNull(first.subscriberPublicKey).matches(Regex("^[0-9a-f]{64}$")))
    assertEquals("http://navidrome.localhost:${BuildConfig.GATEWAY_PORT}/", first.echoUrl)
    val configured = binder.configurePublisher("ab".repeat(32)).get(10, TimeUnit.SECONDS)
    assertTrue(configured.configured)
    assertLoopbackListener(BuildConfig.GATEWAY_PORT)
    assertLoopbackListener(BuildConfig.MIHOMO_PORT)
    assertLoopbackListener(BuildConfig.DSH_PORT)

    ActivityScenario.launch(MainActivity::class.java).use { activity ->
      activity.recreate()
      val afterRecreate = binder.awaitState(RuntimeState.RUNNING)
      assertEquals(first.runtimeId, afterRecreate.runtimeId)
      assertEquals(first.subscriberPublicKey, afterRecreate.subscriberPublicKey)
      assertEquals(configured.configured, afterRecreate.configured)
      assertEquals(first.echoUrl, afterRecreate.echoUrl)
    }

    val afterActivityClosed = binder.awaitState(RuntimeState.RUNNING)
    assertEquals(first.runtimeId, afterActivityClosed.runtimeId)
    assertEquals(first.subscriberPublicKey, afterActivityClosed.subscriberPublicKey)
    assertEquals(first.runtimeId, binder.ping().get(10, TimeUnit.SECONDS).runtimeId)

    KeposForegroundService.stop(context)
    binder.awaitState(RuntimeState.STOPPED)
  }

  @Test
  fun deepLinkIsConsumedBeforeActivityRecreation() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val launch = Intent(context, MainActivity::class.java).apply {
      data = Uri.parse("kepos://pair?v=1&publisher=${"ab".repeat(32)}")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val first = instrumentation.startActivitySync(launch) as MainActivity
    val recreated = AtomicReference<MainActivity>()
    val resumed = CountDownLatch(1)
    val monitor = ActivityLifecycleMonitorRegistry.getInstance()
    val callback = ActivityLifecycleCallback { activity, stage ->
      if (stage != Stage.RESUMED || activity !is MainActivity || activity === first) return@ActivityLifecycleCallback
      recreated.set(activity)
      resumed.countDown()
    }

    try {
      instrumentation.runOnMainSync {
        assertEquals(null, first.intent.data)
        monitor.addLifecycleCallback(callback)
        first.recreate()
      }
      assertTrue(
        "activity did not resume after recreation",
        resumed.await(10, TimeUnit.SECONDS),
      )
      instrumentation.runOnMainSync {
        assertEquals(null, checkNotNull(recreated.get()).intent.data)
      }
    } finally {
      instrumentation.runOnMainSync {
        monitor.removeLifecycleCallback(callback)
        (recreated.get() ?: first).finish()
      }
    }
  }

  private fun assertLoopbackListener(port: Int) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
    var lastError: Exception? = null
    while (System.nanoTime() < deadline) {
      try {
        Socket().use { socket ->
          socket.connect(InetSocketAddress("127.0.0.1", port), 500)
        }
        return
      } catch (error: Exception) {
        lastError = error
        Thread.sleep(50)
      }
    }
    throw AssertionError("loopback listener $port did not start", lastError)
  }

  private class TestServiceConnection(private val context: Context) : AutoCloseable {
    private val connected = CountDownLatch(1)
    private var binder: KeposForegroundService.LocalBinder? = null
    private val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, service: IBinder) {
        binder = service as KeposForegroundService.LocalBinder
        connected.countDown()
      }

      override fun onServiceDisconnected(name: ComponentName) {
        binder = null
      }
    }

    init {
      check(
        context.bindService(
          Intent(context, KeposForegroundService::class.java),
          connection,
          Context.BIND_AUTO_CREATE,
        ),
      ) { "failed to bind Kepos service" }
    }

    fun awaitBinder(): KeposForegroundService.LocalBinder {
      check(connected.await(10, TimeUnit.SECONDS)) { "service did not bind" }
      return checkNotNull(binder)
    }

    override fun close() {
      context.unbindService(connection)
    }
  }

  private fun KeposForegroundService.LocalBinder.awaitState(
    expected: RuntimeState,
  ): RuntimeSnapshot {
    val reached = CountDownLatch(1)
    var result: RuntimeSnapshot? = null
    val observer = observe { snapshot ->
      if (snapshot.state == expected) {
        result = snapshot
        reached.countDown()
      }
    }
    try {
      check(reached.await(10, TimeUnit.SECONDS)) { "runtime did not reach $expected" }
      return checkNotNull(result)
    } finally {
      observer.close()
    }
  }
}
