package io.github.ttalab.kepos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingInvitationViewModelTest {
  @Test
  fun pendingInvitationIsKeptUntilTheRuntimeConsumesIt() {
    val model = PairingInvitationViewModel()

    model.queue("kepos://pair?token=secret")

    assertEquals("kepos://pair?token=secret", model.peek())
    assertEquals("kepos://pair?token=secret", model.take())
    assertNull(model.peek())
  }
}
