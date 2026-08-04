# ADR 0001: Host-owned supervision and explicit local ports

Status: Accepted

Date: 2026-07-20

## Context

Kepos runs in two shapes:

- a resident desktop application on machines with a GUI;
- a CLI runtime on headless machines such as WSL and Linux servers.

Each platform already has its own process manager. Shipping a systemd unit in
the Kepos repository made this repository responsible for host paths, state
setup, service names, and deployment timing that belong to the host.

The publisher knows that an SSH service exists and where it connects on the
publisher machine. It does not know which local port each subscriber uses.
Only the subscriber knows its actual local binding.

## Decision

The host owns process supervision.

Kepos provides the stable CLI contracts:

```sh
npm run kepos -- publisher run --state <publisher-state>
npm run kepos -- subscriber run --state <subscriber-state> --service ssh:<local-port>
npm run kepos -- device run \
  --publisher-state <publisher-state> \
  --subscriber-state <subscriber-state> \
  --subscriber-service ssh:<local-port>
```

The device command is the preferred dual-role host shape. It shares one
HyperDHT transport while keeping role state, identity, and locking separate.
The standalone commands remain stable isolation and rollback boundaries.

The WSL or server configuration owns its systemd unit, paths, state setup, and
deployment. A future desktop application owns its own foreground and
background lifecycle. The Kepos repository does not ship platform-specific
service-manager units.

SSH uses an explicit local port in the current CLI. Port `2222` is a
convention, not a guarantee. If it conflicts, the operator chooses another
port explicitly. Automatic port scanning or incrementing is an optional
future improvement, not current behavior.

The subscriber knows the actual local port and is therefore responsible for
showing an SSH copy command. The publisher Home only describes published
services and must not guess a subscriber-local port.

## Consequences

- WSL and other headless hosts maintain their own service-manager config.
- A dual-role host may supervise one device process instead of two role
  processes.
- Kepos state setup remains separate from process supervision.
- SSH remains predictable and scriptable through an explicit port.
- Publisher Home can show that SSH is available, but cannot provide its local
  command.
- A subscriber CLI or desktop UI may add a copy button using the actual bound
  port.
- Automatic `2222`, then `2223`, then `2224` allocation remains optional.
