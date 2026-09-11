# Kepos repository instructions

## Formal releases

- The formal release workflow in `docs/releasing.md` uses standard `git` and
  `gh`. Never use `og` for release tags, tag pushes, release drafts, asset
  uploads, or publication.
- Release tags must be annotated. Use `git tag -a`, then push the exact tag
  with `git push origin <tag>`.
- All normal source changes still use a feature branch and a pull request.

## Windows NUC automation

- For ad hoc Windows probes and native build orchestration, place the complete
  operation in a local temporary `.ps1` file and run
  `scripts/windows/nuc-powershell.sh /tmp/task.ps1`. Use stdin only for a short
  probe. Use this checked-in wrapper instead of recreating its SSH/encoding
  logic; the host-installed `nuc-powershell` command is an equivalent shortcut.
- The wrapper reaches the NUC over the LAN, avoids WSL UNC working directories
  and nested SSH/cmd/PowerShell quoting, and runs the real PowerShell 7 with
  terminating errors and UTF-8 output from `C:\`.
- Transfer large source or artifacts separately with `scp`/`rsync` through
  `nuc`. For long configure/build steps, run one bounded command that writes a
  remote log; inspect or retrieve that log instead of rerunning the build.
- The host wrapper is for ad hoc automation. Formal and reproducible Windows
  builds continue through the checked-in `scripts/windows/nuc-kep.sh` and
  `scripts/windows/build-kepos.ps1`; preserve their Windows PowerShell 5.1
  compatibility checks.

## Website

- The website lives in `apps/web` and uses the root npm workspace and lockfile.
- Keep Cloudflare configuration in `apps/web/wrangler.jsonc`.
- Cloudflare Git Builds are disabled. Run the local Wrangler deploy only after
  the website change has merged and passed checks.

## Canonical peer runtime

- New repository-owned configuration uses `peers`, `services`, and `bindings`
  in the strict snake_case TOML schema. Use `setup peer`, `peer key`, `peer
  status`, `peer pair`/`peer trust`, `peer convert`, and `peer run`; do not add
  publisher/subscriber TOML aliases, startup probing, or role-specific
  compatibility adapters.
- A peer has one seed-only `peer.json` identity. Keep service grants explicit
  for the authenticated immediate peer. A `bindings` entry consumes a remote
  service and never republishes it; its default `kind` is a TCP/byte-stream
  listener and `kind = "udp"` owns a forward loopback datagram listener.
  Republication requires a separate local service with an explicit
  peer/service source and allowlist. The optional `metrics` table and
  `--metrics-listen` override expose the existing read-only Prometheus
  contract from the canonical peer runtime.
- Tests for peer state, sockets, locks, and runtimes must use test-owned
  temporary paths, generated keys, fakes, or local HyperDHT testnets. Never
  inspect or mutate live Kepos/DSH state, credentials, installed binaries, or
  production services.
- The canonical runtime preserves old-client-to-new-server wire operations,
  but does not promise new-client-to-old-server operation or reverse UDP.
  Keep compatibility code at the wire boundary and document unsupported
  capabilities truthfully. Android onboarding uses the canonical host IPC
  `configure`/`pair` methods and app-private peer state; it must not
  reintroduce subscriber state or a second runtime.
