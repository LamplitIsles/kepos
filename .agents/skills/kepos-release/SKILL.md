---
name: kepos-release
description: Use when preparing, building, signing, verifying, recovering, drafting, or publishing a formal Kepos release or release tag for Android, macOS, and Windows.
---

# Kepos Release

## Source of truth

Read [`docs/releasing.md`](../../../docs/releasing.md) completely before acting. Treat it as the release contract; this skill supplies execution discipline and failure gates rather than a second copy of the commands.

Formal releases run only on the designated release Mac. Release tags, exact tag pushes, GitHub Release drafts, asset uploads, and publication use standard `git` and `gh` as required by the repository instructions. Use `og pull` only for the normal pre-release synchronization of `main`.

## Release ledger

Track these gates and stop at the first failure:

1. **Candidate:** the requested semantic version is explicit, local and remote tags are absent, `main` is clean, and local `HEAD` equals `origin/main` after `og pull`.
2. **Host:** Android JKS, Android alias/password, minisign secret key/password, Android SDK tools, `minisign`, and `gh` authentication are available without printing secret values.
3. **Checks:** every check listed in `docs/releasing.md` passes on the exact candidate commit and leaves the worktree clean.
4. **Tag:** create an annotated tag, inspect its peeled commit, push only that exact tag with `git push origin <tag>`, and verify the remote annotated and peeled references.
5. **Artifacts:** run the repository Android, macOS, and remote Windows release scripts for that tag; the Windows command is the checked-in `nuc-kep` route. Retain its `dist/windows/<run-id>/remote-command.log` as build evidence and accept only versioned outputs that pass their built-in signature, architecture, version, archive, extraction, and isolated-smoke verification.
6. **Manifest:** create the minisign checksum manifest, then independently verify the minisign signature and every SHA-256 entry.
7. **Smoke:** follow the artifact checks in `docs/releasing.md`. Preserve live state: use test-owned temporary HOME, state, and config paths for macOS and Windows smoke tests, and never uninstall an existing Android app or erase pairing state without explicit approval.
8. **Draft:** create the draft with the repository script and inspect tag, target commit, draft state, all five exact asset names, upload states, sizes, and digests.
9. **Publish:** publish with the documented `gh release edit` command, then verify `isDraft=false`, the public tag URL, publication time, and all five public download URLs.

A merge is not a release. Completion requires a verified public GitHub Release, not merely a tag, successful build, or draft.

## Secret handling

Keep passwords and private-key material inside local secret storage and subprocesses. Commands and tool output may show the external key path, alias, public certificate fingerprint, and public minisign key; they must not show passwords or private-key bytes.

Check whether credentials exist without echoing their values. When a signing tool requires interactive input, pass the password from local secret storage through a no-log local terminal process; keep it out of command arguments, shell history, tool results, notes, and PR text. Unset exported release variables after use.

Do not substitute rehearsal, debug, ad-hoc Android, moved tags, or manually renamed assets for the formal scripts.

## Android signing material on the release Mac

Before an Android signing operation, inspect the host-local instructions in
`~/.codex/AGENTS.machine.md`. Kepos's standard release-Mac loader is recorded
in `docs/releasing.md`: it scopes the JKS path, `kepos-release` alias, and the
`io.github.ttalab.kepos.android-release` Keychain generic password to the
`release:android` command. Use that loader or the host-local equivalent; never
list Keychain values or print the password.

## Irreversible tag gate

Before pushing a tag, complete the host preflight and all checks. Tag push is the irreversible boundary.

If any formal build or verification fails after the tag is pushed:

1. Stop the release immediately.
2. Keep the failed tag and any published assets unchanged; never delete, move, force-update, or reuse it.
3. For a Windows failure, inspect the run's local `dist/windows/<run-id>/remote-command.log` first and record its path; if that evidence is absent, repair the checked-in capture path before retrying.
4. Identify the narrowest reproducible cause.
5. Fix it on a feature branch through a pull request and verify the original failing path.
6. After merge, restart the full release ledger from clean `main` with a new patch version.

Report the failed tag as unpublished and distinguish generated local artifacts from uploaded GitHub assets.

## Verification report

At completion report:

- released version and public URL;
- tagged commit and confirmation that the tag is annotated;
- checks run and their outcomes;
- Android certificate verification and device smoke result;
- macOS signature, archive, and isolated launch result;
- Windows archive, x64/runtime verification, and isolated clean-Quit result;
- minisign and checksum verification;
- five published asset names and sizes;
- any intentionally retained failed tag from an earlier attempt.
