# Kepos

Kepos connects trusted devices so one device can consume named services
published by another.

## Language

**Publisher**:
A Kepos device that makes named services available to trusted subscriber
devices, with service sources on that device or at an authorized upstream
publisher.

**Subscriber Device**:
A persistently identified Kepos device that a publisher may trust to consume
its services.
_Avoid_: Sub, client

**Subscriber Device Label**:
A publisher operator's local, human-readable name for a subscriber device. It
identifies the device in management and observability surfaces, not a person.
_Avoid_: Person name, account name

**Published Service**:
A named service that a publisher intentionally makes available through Kepos.

**Service Source**:
The local service or upstream published service that supplies a published
service. It is exactly one of a fixed local loopback port, or a pair of an
upstream publisher public key and its named service ID.

**Upstream Publisher**:
A publisher whose service another publisher consumes as a service source.
Upstream and downstream describe a service relationship between devices.

**Service Republication**:
A publisher's intentional publication of an authorized upstream service under
its own service name and downstream access policy.
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
subscriber device. Separate local senders have separate flows and replies.
_Avoid_: Active Service Channel

**Active Service Channel**:
One live byte stream opened by a subscriber device to a published service.
Multiple active service channels may use the same published service.
_Avoid_: Active service
