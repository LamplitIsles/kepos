package io.lamplitisles.kepos.vpn

/**
 * Fixed internal reasons for a failed or aborted operation. Only these codes
 * cross into the UI model; raw exception and transport text never does, since
 * it can carry an invitation or key material.
 */
internal enum class TunnelFailure {
  Configuration,
  LocalState,
  Identity,
  WorkletUnavailable,
  Bridge,
  /** The TUN device stopped carrying packets while the tunnel was running. */
  TunnelDevice,
  Timeout,
  Invitation,
  /** The pair frame never entered the outbound queue, so nothing was sent. */
  PairingNotSubmitted,
  ReceiverUnavailable,
  PairingUnknown,
  Permission,
  IdentityInUse,
  Capacity,
  Pool,
  ReceiverRouteConflict,
  LocalAddressConflict,
  RouteInspectionUnavailable,
  PairingConflictUnknown,
  ExcludedAddress,
  RouteInspectionBeforePair,
}

internal class VpnFailure(val reason: TunnelFailure) : Exception(reason.name)

internal fun fail(reason: TunnelFailure): Nothing = throw VpnFailure(reason)
