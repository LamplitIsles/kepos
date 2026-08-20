# Release and artifact verification

Kepos publishes three direct-download binaries for a release: an arm64
Android APK, an Apple Silicon macOS ZIP, and a Windows 11 x64 portable ZIP.
`SHA256SUMS` covers exactly those three files and
`SHA256SUMS.minisig` authenticates that manifest. Android uses the long-lived
release certificate. macOS is ad-hoc signed and **not notarized**. Windows is
not Authenticode-signed.

## Maintainer runbook

Formal release work runs on the designated release Mac. Windows compilation
runs manually on the designated NUC through `nuc-kep`; WSL is only the control
plane. Keep the Android JKS and minisign secret key outside the repository and
keep passwords in Keychain or a password manager.

### 1. Candidate and checks

Start from a clean, current `main`. Normal synchronization uses `og pull`; do
not use it for tags, release drafts, asset uploads, or publication.

```sh
npm ci
npm run check
npm run android:check
npm run desktop:check
```

The candidate commit must remain clean for every release command. The
release machine's normal Kepos config must contain a non-empty
`[network].bootstrap` array. Release and rehearsal commands fail before native
packaging when that sanitized asset is missing or invalid; the writer reads
only this network section and never copies the TOML into a build input or
artifact. Confirm the requested version is new and that the local and remote
tag do not already exist. Windows uses the exact command in the next section;
it rejects a dirty worktree and, for a formal release, an unannotated or
mismatched tag.

### 2. Build the exact tagged artifacts

Create and inspect one annotated tag only after the checks pass:

```sh
git tag -a v0.1.0 -m "v0.1.0"
git show-ref --dereference refs/tags/v0.1.0
git push origin v0.1.0
```

Load Android keystore path, alias, and password from local secret storage.
Never put passwords in arguments, tracked files, logs, or shell history. Build
Android and macOS, then run the Windows build from the release Mac:

```sh
npm run release:android -- v0.1.0
npm run release:macos -- v0.1.0
WINDOWS_USER=white npm run release:windows -- v0.1.0
unset KEPOS_ANDROID_KEYSTORE KEPOS_ANDROID_KEY_ALIAS KEPOS_ANDROID_KEY_PASSWORD
```

`release:windows` transfers only the tracked source snapshot plus one
separately generated `kepos-bootstrap.json` sidecar to `nuc-kep`, invokes
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`, builds in the
NTFS `C:\kb` workspace, and copies back only the verified
`kepos-windows-x64.zip`. The ZIP has one top-level `Kepos` directory:
`AppxManifest.xml` and `Assets\Logo.ico` are beside `App\Kepos.exe` and its
explicitly allowlisted runtime files. The remote side resolves the annotated
tag against the release Mac `HEAD`, validates the exact layout and x64 PE
architecture, extracts into fresh empty test-owned directories, and launches the
packaged app with test-owned state to prove a real first-run render over the
WebView bridge: the app bootstraps its own subscriber identity, records the
rendered-page acknowledgement, reports a healthy unconfigured subscriber
snapshot, and quits cleanly (ready, rendered, and quit markers) before the ZIP
is accepted. Failed runs retain logs under
`dist/windows/<run-id>/logs` but remove partial publishable ZIPs.

For a no-tag local rehearsal, use the isolated path:

```sh
WINDOWS_USER=white npm run release:windows -- v0.1.0 --rehearsal
```

Rehearsal files are under `dist/release/rehearsal-v0.1.0/`; they are never
accepted by the publisher.

### 3. Manifest and independent verification

After `kepos-android-arm64.apk`, `kepos-macos-arm64.zip`, and
`kepos-windows-x64.zip` exist in the same formal or rehearsal directory:

```sh
export KEPOS_MINISIGN_SECRET_KEY="/absolute/path/outside/repository/minisign.key"
npm run release:manifest -- v0.1.0
unset KEPOS_MINISIGN_SECRET_KEY
```

The command refuses missing, extra, empty, symlinked, or pre-existing output;
writes exactly the three binary names to `SHA256SUMS`; verifies every digest;
and verifies the minisign signature before returning success. It must run on
the designated release Mac. Never copy a signature from another rehearsal.

### 4. Smoke and draft gate

Verify downloaded-style copies before drafting. On macOS:

```sh
minisign -Vm dist/release/v0.1.0/SHA256SUMS \
  -x dist/release/v0.1.0/SHA256SUMS.minisig -p release/minisign.pub
shasum -a 256 -c dist/release/v0.1.0/SHA256SUMS
codesign --verify --deep --strict --verbose=4 /path/to/extracted/Kepos.app
# Only for this exact verified app if macOS applies quarantine:
xattr -dr com.apple.quarantine /Applications/Kepos.app
```

Run the Windows extraction and tray lifecycle smoke from
[the Windows guide](platforms/windows.md). Install the Android APK on a clean
test device and repeat with `adb install -r`; do not uninstall a real app or
erase pairing state. Before installation, compare its signing certificate with
the recorded public fingerprint:

```sh
actual=$(apksigner verify --verbose --print-certs \
  dist/release/v0.1.0/kepos-android-arm64.apk | \
  awk -F: '/Signer #1 certificate SHA-256 digest/ { gsub(/[[:space:]]/, "", $2); print tolower($2) }')
test "$actual" = "$(cat release/android-certificate.sha256)"
```

Stop if the digest differs.

The draft must contain exactly these five assets: `kepos-android-arm64.apk`,
`kepos-macos-arm64.zip`, `kepos-windows-x64.zip`, `SHA256SUMS`, and
`SHA256SUMS.minisig`.

```sh
npm run release:draft -- v0.1.0
gh release view v0.1.0 --json tagName,targetCommitish,isDraft,assets
```

The script requires the existing remote annotated tag to peel to local `HEAD`,
verifies the minisign signature and all three checksums, rejects rehearsal
paths, existing releases, replacement flags, and publication. Inspect names,
sizes, and digests before publishing. A draft is not a publication.

### 5. Publication

Only after the candidate, host, checks, artifact, manifest, smoke, and draft
gates pass:

```sh
gh release edit v0.1.0 --draft=false --verify-tag
gh release view v0.1.0 --json tagName,targetCommitish,isDraft,publishedAt,assets
```

Confirm `isDraft=false`, the tagged target commit, and five public download
URLs. Merging a pull request, creating a tag, or making a draft does not
deploy or publish a release.

## Verify a downloaded release

Download all five assets from one release and get `release/minisign.pub` from
the same source tag. Verify the publisher signature before trusting checksums:

```sh
minisign -Vm SHA256SUMS -x SHA256SUMS.minisig -p /path/to/minisign.pub
shasum -a 256 -c SHA256SUMS
```

Stop if either command fails. Then use the platform-specific install and
lifecycle guidance in `docs/platforms/android.md`, `docs/platforms/macos.md`,
and `docs/platforms/windows.md`.

## Recovery and failure

If a formal build fails after its tag is pushed, leave that tag and any assets
unchanged. Fix the cause in a new pull request and restart from a new patch
version; never move, delete, force-update, or reuse a published tag. Keep
failure logs for diagnosis, but do not record credentials or private-key
material.

The release Mac holds the working JKS and minisign secret key. The remote NUC
holds only an age-encrypted recovery bundle, not an offline backup. During a
recovery drill, decrypt into a fresh temporary directory, compare the recorded
SHA-256, verify the Android certificate fingerprint and minisign public key,
restore only after those checks, and delete plaintext temporary files.
