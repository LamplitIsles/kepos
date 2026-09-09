# Kepos

Kepos connects trusted devices directly so one device can consume named
services published by another.

## Language

**Publisher**:
A Kepos device that makes its named services available to trusted subscriber
devices.

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

**UDP Service**:
A published service that exchanges individual datagrams with one fixed
publisher-side destination, without guaranteeing delivery or ordering.
_Avoid_: Virtual LAN, reliable UDP tunnel

**UDP Flow**:
One local application's datagram exchange with a UDP service through a
subscriber device. Separate local senders have separate flows and replies.
_Avoid_: Active Service Channel

**Active Service Channel**:
One live byte stream opened by a subscriber device to a published service.
Multiple active service channels may use the same published service.
_Avoid_: Active service
