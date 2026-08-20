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
  `nuc-powershell /tmp/task.ps1`. Use stdin only for a short probe. Check that
  the host-local wrapper exists instead of recreating its SSH/encoding logic.
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
