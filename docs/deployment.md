# Nix, container, and Kubernetes deployment

Kepos ships a Nix package, a Home Manager publisher module, and a non-root
Linux container image. Kubernetes-specific routing is supported by the
subscriber gateway, but this repository does not yet ship cluster manifests or
a Helm chart.

## Nix package and Home Manager publisher

A consumer flake can follow its existing Nixpkgs and Home Manager inputs:

```nix
inputs.kepos-neo = {
  url = "github:tta-lab/kepos-neo";
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
  imports = [inputs.kepos-neo.homeManagerModules.default];

  services.kepos.publisher = {
    enable = true;
    displayName = "kosmos";
    allow = ["<subscriber-public-key>"];
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

On first start, the user service creates publisher identity under
`$XDG_STATE_HOME/kepos-neo/publisher`. Complete state is reused without
rotation; partial state fails closed. The module generates public TOML policy
in the Nix store. Private identity material is created later in the mutable
state directory and never enters the store.

The CLI is also available directly:

```sh
nix run github:tta-lab/kepos-neo -- --help
```

## Container image

Build and load the non-root image for the current supported Linux system
(`x86_64-linux` or `aarch64-linux`):

```sh
nix build .#container-image
docker load < result
docker run --rm ghcr.io/tta-lab/kepos-neo:local --help
```

The GitHub workflow currently runs on x86 and publishes a `linux/amd64` image
from every push to `main`, using `main` and `sha-<git-commit>` tags. Deployments
should pin the digest printed in the Actions summary:

```text
ghcr.io/tta-lab/kepos-neo@sha256:<digest>
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
