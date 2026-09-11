# Kepos

Kepos connects trusted peers so either end of an established connection can
consume named services explicitly made available by the other.

## Language

**Peer**:
A Kepos participant with one persistent identity that can provide and consume
authorized services over its connections to other peers.

**Peer Identity**:
The persistent cryptographic identity used both to establish and to accept
connections. Different identities are not equivalent merely because the same
device owns them.
_Avoid_: Publisher identity, subscriber identity (for the new peer model)

**Dialing Peer**:
The peer that initiates a particular connection. This role does not determine
which peer provides services over that connection.

**Accepting Peer**:
The peer that accepts a particular connection. The same peer may dial other
peers using the same identity.

**Peer Label**:
An operator's local, human-readable name for a peer. It identifies the peer in
configuration, management, and observability surfaces, not a person.
_Avoid_: Person name, account name

**Service Provider**:
The peer that makes a named service available and owns its source and access
policy, independently of which peer established the connection.

**Service Consumer**:
The peer authorized to open a service channel or UDP flow to a service provider.

**Published Service**:
A named service intentionally made available through Kepos. Its identity is
the providing peer together with the service name.

**Service Source**:
The fixed local endpoint or authorized upstream published service that supplies
a published service.

**Service Binding**:
A locally owned entry point for consuming one named service from one peer.
Creating a binding does not publish that service to other peers.

**Upstream Service Provider**:
A peer whose service another service provider consumes as a service source.
Upstream and downstream describe a service relationship between devices.

**Service Republication**:
A service provider's intentional publication of an authorized upstream service
under its own service name and downstream access policy. Its upstream and
downstream connections need not have opposite establishment directions.
_Avoid_: Blind relay, automatic service discovery

**Service Availability**:
The advisory, current ability of a configured service source to accept new
traffic. An unavailable upstream-backed service remains configured and may
recover; availability does not replace authorization or promise continuity for
existing streams and datagram flows.

**UDP Service**:
A published service that exchanges individual datagrams with one fixed
service source, without guaranteeing delivery or ordering.
_Avoid_: Virtual LAN, reliable UDP tunnel

**UDP Flow**:
One local application's datagram exchange with a UDP service through a
service consumer. Separate local senders have separate flows and replies.
_Avoid_: Active Service Channel

**Active Service Channel**:
One live byte stream opened by a service consumer to a published service.
Multiple active service channels may use the same published service.
_Avoid_: Active service

**Reverse Service Channel**:
An active service channel initiated by the accepting peer over a connection
established by the dialing peer. It does not require a new reverse connection.
