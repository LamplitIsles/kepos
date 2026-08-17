# Windows core portability evidence

This document records Specification 1 verification. It contains no user state,
credentials, identities, seeds, private keys, or public network addresses.

## Local checks

The target worktree was checked with the repository's required Node toolchain:

```text
mise exec -- node --version  -> v24.18.1
mise exec -- npm --version   -> 11.16.0
mise exec -- npm run check   -> PASS
mise exec -- node --import tsx --test test/app-config.test.ts test/state.test.ts test/runtime-lock.test.ts test/cli.test.ts
  -> 49/49 passed
```

`npm run check` passed package builds, TypeScript checks, desktop checks, core
coverage/tests, and web verification. Its complete core suite passed 380/380.
The web suite passed 16/16, and the web check and build passed. These checks
were run from the LF-materialized checkout.

## Windows-native acceptance

The designated Windows checkout was run with the pinned native binaries:

```text
%USERPROFILE%\.local\kepos-tools\node-v24.18.1-win-x64\node.exe --version -> v24.18.1
%USERPROFILE%\.local\kepos-tools\node-v24.18.1-win-x64\node.exe %USERPROFILE%\.local\kepos-tools\node-v24.18.1-win-x64\node_modules\npm\bin\npm-cli.js --version -> 11.16.0
```

The direct CLI tracer was created in a new test-owned directory under
`%LOCALAPPDATA%\Temp`, executed with the native `win32` Node binary, and
removed in its `finally` cleanup. The invocation used the equivalent of:

```text
cd %USERPROFILE%\.local\kepos-build\repo-final
%USERPROFILE%\.local\kepos-tools\node-v24.18.1-win-x64\node.exe %TEMP%\<test-owned-script>\tracer.mjs
```

Its generated publisher/subscriber state was
also under a new tracer-owned temporary directory and was removed. The fixture
and subscriber service used ephemeral loopback ports only.

The tracer exercised this sequence:

1. Created publisher and subscriber identities with the CLI, without recording
   either identity.
2. Exposed a loopback TCP fixture through a publisher `fixture` service and a
   subscriber local service.
3. Confirmed the deny-all publisher policy produced no transferred bytes.
4. Confirmed publisher and subscriber conflicting runtime ownership failed with
   the expected lock errors.
5. Updated the publisher allowlist with `publisher set-allow`, terminated the
   publisher, observed its stale lock, and restarted it.
6. Confirmed the publisher identity stayed stable across restart and the
   subscriber transferred 42 observable bytes with matching fixture response.

Sanitized tracer result:

```json
{
  "node": "v24.18.1",
  "platform": "win32",
  "fixture": "127.0.0.1",
  "deniedBeforeAllowlistUpdate": true,
  "publisherLockConflict": true,
  "subscriberLockConflict": true,
  "publisherIdentityStableAcrossRestart": true,
  "stalePublisherLockObservedBeforeRestart": true,
  "stalePublisherLockRecoveredOnRestart": true,
  "transferredBytes": 42,
  "requestDigest": "b9587ac2558f03c0",
  "responseDigest": "1c5e114ded4ed9c6"
}
```

The tracer temporary root was absent after the run. The Windows checkout had
pre-existing unrelated working-tree entries; they were not changed or cleaned
by this acceptance run.

## Bounded limitations

- This is a same-host Windows-loopback acceptance run. It does not establish
  NAT traversal, relay behavior, restricted-network quality, or production
  readiness.
- The tracer validates CLI policy, runtime-lock ownership/recovery, and byte
  transfer. It does not replace the full native test, web, or release checks.
