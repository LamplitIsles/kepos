# Kepos

Kepos connects authenticated peers over a VPN so they can reach authorized
network services using their existing addresses and application authentication.

## Language

**Peer**:
A Kepos participant with one persistent identity that can connect to other
peers for authorized VPN access.

**Peer Identity**:
The persistent cryptographic identity used to establish or accept a connection.
Different identities remain distinct even when owned by the same person.

**Peer Label**:
An operator's local name for a peer in configuration and diagnostics.
_Avoid_: Person name, account name

**Dialing Peer**:
The peer that initiates a particular connection.

**Accepting Peer**:
The peer that accepts a particular connection.

**Peer VPN**:
An authenticated IP connection between peers, governed by the receiving
peer's network access policy.

**VPN Address**:
The configured IP address associated with a peer identity in a peer VPN. Each
peer enforces the mapping for traffic received from that identity.

**VPN Port Grant**:
A receiving peer's permission for another peer to initiate TCP connections to
specified local ports or all supported TCP ports. An absent grant denies new
inbound connections.

## Implemented contract

The current VPN runs on Linux with IPv4 host routes and TCP port grants.
DNS and application authentication are managed separately. See the
[VPN guide](docs/peer-vpn.md) for operational and platform boundaries.
