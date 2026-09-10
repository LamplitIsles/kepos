# ADR 0012: Explicit service republication

Status: Accepted and implemented

A publisher may publish local services and explicitly selected services from
authorized upstream publishers. The republishing publisher owns this selection,
its downstream service names, and its downstream access policy; this preserves
the existing publisher/subscriber responsibilities while allowing a headless
device to provide access to services hosted elsewhere.

Authorization is applied separately at each relationship: the upstream grants
access to the republishing publisher's public key, and that publisher grants
access to its own subscribers. The republishing device is trusted with plaintext traffic
and responsibility for downstream access; this decision adds neither a separate
upstream permission to republish nor end-consumer identity delegation. This
service model differs from a blind transport relay, which would preserve an
end-to-end encrypted connection between the original publisher and subscriber.

Service sources use one model across TCP, HTTP, and UDP services. A publisher
may explicitly select services from different authorized upstream publishers.

Each upstream service is consumed through its immediate publisher's contract;
its internal source need not be disclosed. Republication can therefore compose
across multiple hops. The first acceptance topology covers one republishing
publisher between the original publisher and final subscriber. This is a test
scope, not an enforced hop limit or a claim that arbitrary chains have been
verified. No provenance or hop-count protocol is introduced solely to prohibit
additional republication.

Operators are responsible for keeping service-source relationships acyclic.
This design adds no cycle or self-reference detection. Normal forwarding
resource limits remain applicable; they do not establish that a configuration
is cycle-free.

The existing dual-role model in ADR 0006 supports the role composition. The
publisher runtime owns one shared outbound connection per configured upstream,
using the publisher identity and the existing connection recovery and UDP
carrier machinery. Local and upstream sources share the same downstream
service protocol and status surfaces. The implementation does not add a second
subscriber gateway, a per-flow outer connection, or a durable upstream state
directory.

Upstream connections belong to the publisher runtime and use its existing
publisher identity. They do not read or alter the separately enabled subscriber
role's identity or pinned publisher. This extends the publisher's responsibility
while retaining ADR 0006's independent role-state ownership.
