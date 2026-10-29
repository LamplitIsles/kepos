# Architecture

Each Linux peer has a seed-only persistent identity and a strict configuration that binds trusted public keys to connection directions, VPN IPv4 addresses and inbound TCP grants. A HyperDHT Noise connection authenticates the remote key. The VPN protocol frames IP packets over that connection; the packet policy checks the authenticated peer's source and destination addresses and tracks TCP flows for permitted inbound connections and replies.

The Linux helper owns a nonpersistent TUN interface and per-peer host routes. The CLI holds an identity lock and restarts the runtime when configuration changes, clearing the old flow state. Shutdown closes connections and the helper, removing the interface and routes. Details and limits are documented in [Linux peer VPN](peer-vpn.md).
