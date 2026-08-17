# Windows core portability evidence

This document records Specification 1 verification. It contains no user state,
credentials, identities, or private network addresses.

## Local checks

From the Kepos repository, using test-owned temporary directories:

```text
mise exec -- npm run build:packages
mise exec -- npm run typecheck
mise exec -- npm run desktop:typecheck
mise exec -- node --import tsx --test test/app-config.test.ts test/state.test.ts test/runtime-lock.test.ts test/cli.test.ts test/desktop-options.test.ts
mise exec -- npm run desktop:check
```

All listed local commands passed. The targeted suite passed 59 tests and the
desktop suite passed 100 tests. The tests cover Windows AppData path resolution,
complete-file replacement and failure preservation, state
identity/configuration updates, runtime-lock contention and stale-owner recovery,
and CLI shutdown handling.
These local results are not Windows-native acceptance evidence.

## Designated host preflight

The read-only version probe was run through the WSL control entrypoint:

```text
ssh nuc-kep '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "node --version; npm --version"'
```

Observed output:

```text
v22.20.0
10.9.3
```

The host was not provisioned or mutated. Specification 1 requires Windows Node
24 and npm 11, so the native acceptance run was not started. A later read-only
probe ended with the SSH connection closing, before MSVC/CMake availability
could be recorded.

## Unmet native acceptance evidence

The following Windows-host checks remain unverified because the designated host
still has the wrong toolchain and no repository-authorized provisioning path was
available:

- Node 24/npm 11 installation and dependency installation on Windows.
- Windows-native targeted tests.
- Publisher/subscriber identity creation and Windows-loopback TCP fixture.
- Config and allowlist update followed by restart.
- Bounded conflicting-owner failure, clean stop, restart, and stale-lock proof.
