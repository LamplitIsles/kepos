# Nix, container, and Kubernetes deployment

Kepos deployment owns three things outside the package: the canonical peer
state directory, the canonical TOML policy, and process supervision. A
deployment must not place private identity material in the Nix store, image,
logs, or generated diagnostics.

## Home Manager

The exported Home Manager module is `services.kepos.peer`. It generates the
same strict peer-oriented TOML consumed by `peer run`, creates missing
canonical state with `setup peer`, and supervises one user service.

```nix
{
  inputs,
  ...
}: {
  imports = [inputs.kepos.homeManagerModules.default];

  services.kepos.peer = {
    enable = true;
    stateDir = "/var/lib/kepos/peer";
    bootstrap = ["bootstrap.example:49737"];

    peers = {
      mac = {
        publicKey = "<mac-peer-public-key>";
        connection = "accept";
      };
      phone = {
        publicKey = "<phone-peer-public-key>";
        connection = "accept";
      };
    };

    services = {
      cua = {
        name = "CUA driver";
        source.unixSocket = "/run/user/1000/cua-driver.sock";
        allow = ["<nuc-peer-public-key>"];
      };
      mac-cua = {
        name = "Mac CUA";
        source = {
          peer = "mac";
          service = "cua";
        };
        allow = ["<phone-peer-public-key>"];
      };
    };

    bindings = [
      {
        peer = "mac";
        service = "cua";
        unixSocket = "/run/user/1000/kepos-cua.sock";
      }
      {
        peer = "phone";
        service = "game";
        kind = "udp";
        localPort = 0;
      }
    ];

    gateway = {
      port = 17480;
      host = "127.0.0.1";
    };

    metrics = {
      enable = true;
      host = "127.0.0.1";
      port = 17481;
    };
  };
}
```

The `peers` attribute name becomes the local peer label. Each `publicKey` is a
64-character lowercase key and `connection` is exactly `dial` or `accept`.
Service sources select one of `localPort`, `unixSocket`, or a complete
`peer`/`service` pair. Service `allow` values are immediate peer public keys;
the default empty list denies access. Bindings select one `localPort` (zero is
ephemeral) or `unixSocket`; set `kind = "udp"` for a forward UDP binding,
which requires a local port. A binding consumes a remote service; it does not
publish it. `metrics.enable` adds the read-only Prometheus `/metrics` listener
with the configured host and port; port `0` is allowed for an ephemeral
listener.

The module's generated TOML is written into the Nix store, but `peer.json`
is created at `stateDir` by `ExecStartPre` with `0700/0600` permissions. The
systemd user unit runs:

```text
kepos peer run --state <stateDir> --config <generated-config> --observations ndjson
```

Changes to Home Manager options produce a new complete config and the running
peer reloads it. Changed grants, sources, directions, bindings, and metrics
settings close or restart only the affected canonical surfaces; they do not
replay old bytes. The unit uses
`Restart=always`, `KillMode=mixed`, `UMask=0077`, `NoNewPrivileges=true`, and
`PrivateTmp=true`. The package does not install firewall rules, DHT bootstrap
servers, or a public gateway.

Build or inspect the package without starting a runtime:

```sh
nix build .#packages.x86_64-linux.default
nix run github:LamplitIsles/kepos -- --help
```

The module's generated file should be checked by the repository's Nix test and
the actual `parseKeposConfig` parser. No private key is required to render or
evaluate it.

## Deliberate identity cutover

The intended migration is a key selection, not an automatic merge. Retain
NUC's existing publisher public key as NUC's canonical peer identity and
retain Mac's active subscriber public key as Mac's canonical peer identity.
If a host currently owns both old keys, choose one survivor and update every
peer reference and immediate service grant that should follow it. Do not make
the two keys aliases.

Use this order during a later operator-controlled cutover:

1. Record public keys and the intended peer/service ACL mapping. Do not copy
   private files into the record.
2. Stop the old supervisor and verify it no longer owns the selected identity.
3. Make a backup of old state and config outside the active canonical paths.
4. Run `peer convert --source ... --destination ...
   --expected-public-key ...` for the selected old publisher or subscriber
   identity. The expected key is mandatory. The helper is offline-only,
   refuses overwrite and linked or ambiguous sources, and writes one private
   `peer.json`.
5. Install the canonical TOML with `peers`, `services`, and `bindings`; keep
   allowlists explicit and do not turn a label conversion into a broad grant.
6. Run `peer status`, start the canonical unit, and perform an isolated service
   check. Only after that enable or switch supervision.

Rollback is the inverse: stop the canonical unit, move its new state aside,
restore the separately held old state/config, and start the old supervisor.
Never delete a lock file or kill an unrelated process as part of rollback. The
runtime has no legacy probing, fallback, or concurrent old/new mode.

This repository has not performed this conversion on a real NUC or Mac.

## Container image

The non-root image includes the CLI and runtime but owns no persistent key by
itself. Mount a deployment-owned directory at the peer `stateDir` and provide
the canonical config as a read-only file or environment-managed secret-free
artifact:

```sh
npm run kepos -- setup peer --state /var/lib/kepos/peer
npm run kepos -- peer run \
  --state /var/lib/kepos/peer \
  --config /etc/kepos/config.toml \
  --observations ndjson
```

For an image built from Nix:

```sh
nix build .#container-image
docker load < result
docker run --rm ghcr.io/lamplitisles/kepos:local --help
```

Pin a published deployment by digest. The container must have a writable
state directory, outbound DHT/UDX networking, and a restart policy. Kepos does
not expose a public service port; the HTTP gateway defaults to loopback unless
the config explicitly selects another host.

## Kubernetes gateway pattern

Kepos does not ship Kubernetes manifests or a Helm chart. An operator may run
the container on a node and expose its HTTP gateway to selected Pods:

```toml
[gateway]
port = 17480
host = "0.0.0.0"
domain = "kepos.internal"
```

The existing names remain `service.localhost:17480`; `gateway.domain` adds an
operator-selected suffix such as `service.kepos.internal:17480`. It does not
install DNS, create a Service, or authenticate individual Pods. A reachable
gateway gives callers the same immediate peer capability as the runtime that
owns it, so protect the listener with network policy and keep it off the
public Internet. The client-to-gateway HTTP leg is plaintext unless the
deployment protects it separately.

A cluster arrangement should:

- route the chosen suffix to a Service backed by the node-local gateway;
- keep traffic on the node that owns the state, for example with
  `internalTrafficPolicy: Local`;
- restrict gateway access to intended Pod/CNI ranges at the node firewall;
- give each independent peer deployment its own persistent state and lock;
- supervise graceful stop so active channels fail rather than being replayed.

The gateway is an operator-owned access boundary, not a replacement for
service allowlists. An upstream source and a downstream republished service
still authorize their immediate public keys independently.

## Firewall and local files

Allow the HyperDHT candidate listener range used by the deployment (normally
`49737-49741`) and outbound UDP. UDX connection sockets are ephemeral; the
candidate range alone does not guarantee an established data path. Bootstrap
nodes help discovery but do not authorize peers or relay application data.

Keep the state directory and sibling runtime lock on one local filesystem.
Lock ownership is an advisory kernel lock on an open descriptor; the lock file
may remain after a clean exit or crash, and its existence is not proof of a
live process. Do not manually replace or remove it while the unit may still be
running.

For production operations, preserve the generated config and public-key
record, but never collect `peer.json`, secret keys, pairing tokens, or raw
state in logs or support bundles.
