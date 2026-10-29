# Kepos repository instructions

## Formal releases

- Formal release tags and artifacts use standard `git` and `gh`, not `og`.
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

## Website

- The website lives in `apps/web` and uses the root npm workspace and lockfile.
- Keep Cloudflare configuration in `apps/web/wrangler.jsonc`.
- Cloudflare Git Builds are disabled. Run the local Wrangler deploy only after
  the website change has merged and passed checks.

## Peer VPN

- A peer has one seed-only `peer.json` identity. Preserve authenticated
  peer-to-address binding, default-deny inbound TCP grants, bounded packet
  handling, and TUN/route cleanup. See `docs/peer-vpn.md` for current platform
  and protocol boundaries. Keep external DNS and service authentication
  separate from the VPN.
- Tests for peer state, sockets, locks, and runtimes must use test-owned
  temporary paths, generated keys, fakes, or local HyperDHT testnets. Never
  inspect or mutate live Kepos/DSH state, credentials, installed binaries, or
  production services.
