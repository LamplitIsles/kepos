# ADR 0008: Share one HyperDHT node per device runtime

Status: Accepted

Date: 2026-08-04

## Context

A Kepos host may publish local services while subscribing to a remote
publisher. These are separate trust roles: each has its own identity, state,
runtime lock, and connection model.

ADR 0006 put both roles in one Desktop process but gave each role its own
HyperDHT node. A headless dual-role host similarly needs two role processes.
Each node owns a DHT candidate listener and its UDP socket pools, so two nodes
normally reserve two candidate listener ports and duplicate routing work. On
WSL, the publisher selected UDP 49737 while the subscriber selected 49738. That
made the extra listener visible, but it did not mean either role's encrypted
data path stayed on its selected listener port.

Separate DHT nodes are not required to preserve the two role identities.
HyperDHT accepts a key pair for each server listen and outbound connection. One
node can therefore listen with the publisher key pair while connecting with the
subscriber key pair. Both operations can use the node's shared UDP transport
without merging their authenticated identities.

## Decision

A Kepos device runtime that runs publisher and subscriber together owns one
HyperDHT node and lends it to both roles. The publisher listens with its
publisher key pair. The subscriber connects with its subscriber key pair. The
shared node owns bootstrap, one preferred DHT candidate listener, an ephemeral
DHT client socket, ephemeral UDX connection sockets, routing state, and final
shutdown.

The roles continue to own their protocol state, streams, gateways, listeners,
and role-specific cleanup. A role must not destroy a borrowed node. The device
runtime stops both roles before destroying the shared node once.

Publisher and subscriber identities, state directories, runtime locks,
allowlists, publisher pins, and wire protocols remain separate. Sharing a node
does not make the roles trust each other and does not make a device connect to
its own publisher implicitly.

Desktop keeps one process and moves from two role-owned nodes to one
device-owned node. A headless dual-role host gains one device command and one
service with the same ownership model. The existing standalone publisher and
subscriber commands remain available; a standalone role creates and owns its
own node.

Bootstrap and other transport settings are device-wide when roles share a
node. A role-only policy change may restart that role without replacing the
node. A transport-policy change replaces the shared node and therefore restarts
both roles. DHT transport counters are device-wide in shared mode; role-level
metrics must be recorded above the DHT layer.

Headless device startup is atomic: if either requested role cannot start, the
runtime cleans up every role that did start and exits so its supervisor can
retry. Desktop retains visible per-role failure isolation, but a shared-node
failure still affects both roles.

Hosts should continue to admit the HyperDHT candidate listener range rather
than only one preferred port. One shared node normally selects one preferred
DHT candidate listener, but it may select a later candidate when an earlier
port is occupied. The listener is not the whole transport: `dht-rpc` also uses
an ephemeral DHT client socket, and HyperDHT manages ephemeral UDX connection
sockets for encrypted peer streams.

Kepos observations deliberately allowlist connection flags, truncated peer
keys, UDX counters, and aggregate DHT punch and relay counters. They do not
classify a connection's LAN, public, or relay path. The public failed holepunch
callback does not expose the connection socket's local port or per-datagram
results, and aggregate relay counters do not distinguish an unavailable relay
from a rejected relay. Those questions need a narrower upstream hook or an
external packet capture rather than inference from incomplete observations.

This ADR supersedes only ADR 0006's decision that Desktop roles do not share a
DHT instance. ADR 0006's decisions about separate identities, per-state locks,
no implicit self-connection, role failure reporting, and native UI lifecycle
remain in force.

## Consequences

- A dual-role device normally reserves one preferred DHT candidate listener
  instead of two. It still uses an ephemeral DHT client socket and ephemeral
  UDX connection sockets, with their corresponding NAT and firewall behavior.
- The roles share bootstrap and routing work and use fewer local resources.
- A sibling role no longer pushes the other role from UDP 49737 to 49738 merely
  because both started on the same device runtime.
- Node failure, transport saturation, and transport reconfiguration affect both
  roles. Implementations need explicit lifecycle ownership and load tests.
- Independent nodes remain possible through the standalone commands when roles
  need different network policy, fault isolation, or deployment lifecycles.
- Operators still allow UDP 49737-49741 where HyperDHT uses its default
  candidate listener range. That range does not cover every UDX connection
  socket and does not by itself guarantee the encrypted data path.

## Alternatives considered

### Two DHT nodes in one process

This is valid and was the ADR 0006 Desktop design. It preserves independent
transport configuration and failure boundaries, but still creates two
candidate listeners, routing tables, and independent socket pools. Kepos keeps
it available through independent role runtimes but does not use it as the
default dual-role device shape.

### One device identity for both roles

This could reduce the number of keys but would change allowlist meaning,
publisher addressing, rotation, recovery, and trust boundaries. It is not
required to share a transport and is outside this decision.
