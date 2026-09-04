# Nix, container, and Kubernetes deployment

Kepos ships a Nix package, a Home Manager publisher module, and a non-root
Linux container image. Kubernetes-specific routing is supported by the
subscriber gateway, but this repository does not yet ship cluster manifests or
a Helm chart.

## Nix package and Home Manager publisher

A consumer flake can follow its existing Nixpkgs and Home Manager inputs:

```nix
inputs.kepos = {
  url = "github:LamplitIsles/kepos";
  inputs.nixpkgs.follows = "nixpkgs";
  inputs.home-manager.follows = "home-manager";
};
```

Import and configure the module:

```nix
{
  inputs,
  ...
}: {
  imports = [inputs.kepos.homeManagerModules.default];

  services.kepos.publisher = {
    enable = true;
    displayName = "kosmos";
    subscribers = [
      {
        label = "nuc";
        publicKey = "<subscriber-public-key>";
      }
    ];
    services = {
      ssh = {
        name = "SSH";
        targetPort = 22;
      };
      navidrome = {
        name = "Navidrome";
        targetPort = 4533;
        allow = ["<subscriber-public-key>"];
      };
    };
  };
}
```

The Home Manager module currently publishes only raw `tcp` services: its
`services.<id>` schema has no `kind` option. Use a TOML publisher configuration
for a `kind = "http"` target rather than adding an unsupported Nix attribute;
see [the HTTP service contract](cli.md#http-service-device-authentication).

On first start, the user service runs `setup publisher --state` to create the
seed-only `publisher.json` under `$XDG_STATE_HOME/kepos-neo/publisher`.
Repeated starts validate and reuse that identity without rotation; partial,
extra, or malformed state fails closed. The module generates the complete
publisher TOML policy in the Nix store and starts Kepos with that file. Private
identity material is created later in the mutable state directory and never
enters the store.

Publisher state contains no display name, subscriber devices, services, or
service manifest. Edit the generated TOML to change publisher policy; there are
no state-policy mutation commands.

The CLI is also available directly:

```sh
nix run github:LamplitIsles/kepos -- --help
```

The Home Manager module remains publisher-only. A host that owns both role
states can instead supervise one foreground device process:

```sh
kepos device run \
  --publisher-state /var/lib/kepos/publisher \
  --subscriber-state /var/lib/kepos/subscriber \
  --subscriber-service ssh:2222 \
  --config /etc/kepos/config.toml
```

This uses one device-owned HyperDHT node while retaining the two identities and
state locks. Kepos does not install the systemd unit or choose host paths; the
host configuration still owns setup, restart policy, firewall rules, and
deployment timing. Keep the standalone role commands when the roles need
different transport policy or failure boundaries.

For a publisher scrape endpoint, add `--metrics-listen 127.0.0.1:9464` to the
publisher or dual-role command and permit only the deployment's Prometheus
scraper to reach it. Build the owned dashboard with `nix build
github:LamplitIsles/kepos#grafana-dashboard`; the resulting opaque JSON is at
`share/kepos/grafana/kepos-publisher-observability.json`.

## Container image

Build and load the non-root image for the current supported Linux system
(`x86_64-linux` or `aarch64-linux`):

```sh
nix build .#container-image
docker load < result
docker run --rm ghcr.io/lamplitisles/kepos:local --help
```

The GitHub workflow currently runs on x86 and publishes a `linux/amd64` image
from every push to `main`, using `main` and `sha-<git-commit>` tags. Deployments
should pin the digest printed in the Actions summary:

```text
ghcr.io/lamplitisles/kepos@sha256:<digest>
```

GHCR creates a new package as private. An organization owner must make the
package public once before anonymous clusters can pull it.

## Pod-facing subscriber gateway

Loopback and `.localhost` are the safe defaults. A host-network subscriber can
opt into a Pod-facing listener and one additional hostname suffix:

```toml
[subscriber]
gateway_port = 17480
gateway_host = "0.0.0.0"
gateway_domain = "kepos.internal"
```

The same settings can be passed to one CLI run:

```sh
kepos subscriber run \
  --state /var/lib/kepos/node-subscriber \
  --gateway-host 0.0.0.0 \
  --gateway-domain kepos.internal
```

The gateway accepts both `navidrome.localhost:17480` for node-local clients and
`navidrome.kepos.internal:17480` for Pods. `gateway_domain` only adds Host
header routing. It does not install DNS, create a Service, or make the listener
reachable by itself.

This is device-level delegation: every Pod or LAN client that can reach the
gateway can open services as that subscriber device. For a publisher service
configured as `kind = "http"`, all of those callers produce the same
`Authorization: Kepos <subscriber-public-key>` assertion at the target; there
is no per-Pod identity. The client-to-gateway HTTP leg is plaintext unless the
deployment protects it separately.

A cluster deployment must:

- route `*.kepos.internal` to a ClusterIP backed by the host-network subscriber;
- keep traffic on the node that owns the subscriber, for example with
  `internalTrafficPolicy: Local`;
- restrict port 17480 to Pod or CNI source ranges at the node firewall;
- keep the gateway off public interfaces;
- give every subscriber deployment its own persistent identity and state lock.

This path has been exercised in a private Kubernetes deployment, including
pulling the container across regions. That is evidence for feasibility, not a
promise of supplied manifests, managed DNS, or production support.
