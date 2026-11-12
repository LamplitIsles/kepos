package io.lamplitisles.kepos.vpn

import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.SocketException

/**
 * This device's own unicast IPv4 interface addresses.
 *
 * Android can report routes for visible links through
 * `ConnectivityManager.getLinkProperties`, which needs `ACCESS_NETWORK_STATE`;
 * this client neither requests that permission nor scans routes. Even such a
 * snapshot would not establish an existing host route, route precedence, OEM
 * routing policy or later network changes, so conflict detection here stays at
 * interface addresses and `ip route` (root only) is not used.
 */
internal fun interface LocalIpv4Source {
  /** Addresses, or null when they cannot be read at all. */
  fun addresses(): List<String>?
}

internal object NetworkInterfaceIpv4 : LocalIpv4Source {
  override fun addresses(): List<String>? =
    try {
      NetworkInterface.getNetworkInterfaces()?.toList()?.flatMap { network ->
        if (!network.isUp) return@flatMap emptyList()
        network.inetAddresses.toList().mapNotNull { address ->
          if (address !is Inet4Address || address.isLoopbackAddress || address.isLinkLocalAddress) return@mapNotNull null
          address.hostAddress
        }
      }?.distinct()
    } catch (_: SocketException) {
      null
    } catch (_: SecurityException) {
      null
    }
}

internal enum class AddressConflict { LocalAddress, PeerAddress }

internal fun addressConflict(address: String, peers: List<String>, local: List<String>): AddressConflict? {
  if (address in local) return AddressConflict.LocalAddress
  if (peers.any { it in local }) return AddressConflict.PeerAddress
  return null
}
