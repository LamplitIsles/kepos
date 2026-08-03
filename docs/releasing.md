# Release and artifact verification

Kepos publishes an arm64 Android APK and an Apple Silicon macOS ZIP outside
the app stores. Android uses one long-lived release certificate. The macOS app
is ad-hoc signed and **Not notarized** by Apple. A minisign signature over the
checksum manifest authenticates both files.

## Maintainer runbook

Release only from the designated release Mac. Keep the Android JKS and
minisign secret key outside the repository. Keep their passwords in Keychain
or a password manager, never in a command argument, tracked file, or shell
history.

1. Start from a clean, current `main` and run all checks:

   ```sh
   npm ci
   npm run check
   npm run android:check
   npm run desktop:check
   ```

2. Create one annotated tag for the exact checked commit and push only that
   tag. Do not move or delete a published tag.

   ```sh
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

3. Load the Android keystore path, alias, and password into the current shell
   from local secret storage. Use absolute paths. Then build both artifacts.
   The minisign command prompts for its key password in the terminal.

   ```sh
   npm run release:android -- v0.1.0
   npm run release:macos -- v0.1.0
   export KEPOS_MINISIGN_SECRET_KEY="/absolute/path/outside/the/repository/minisign.key"
   npm run release:manifest -- v0.1.0
   unset KEPOS_ANDROID_KEYSTORE KEPOS_ANDROID_KEY_ALIAS KEPOS_ANDROID_KEY_PASSWORD KEPOS_MINISIGN_SECRET_KEY
   ```

4. Install the APK on a clean Android device, then repeat with
   `adb install -r`. Extract the Mac ZIP in a temporary directory, run the
   verification commands below, launch Kepos, and check the tray plus basic
   publisher/subscriber behavior.

5. Create a draft from the four fixed assets. The script requires an existing
   remote annotated tag that resolves to local `HEAD`; it cannot create a tag,
   replace an asset, or publish the release.

   ```sh
   npm run release:draft -- v0.1.0
   gh release view v0.1.0 --json tagName,targetCommitish,isDraft,assets
   ```

6. Inspect the target commit, draft status, four names, and sizes. Publish only
   after that check:

   ```sh
   gh release edit v0.1.0 --draft=false --verify-tag
   ```

If any formal build or verification fails after the tag is pushed, fix it in a
new pull request and release a new version. Do not replace the tag or assets.

Pull-request checks use `--rehearsal`. Rehearsal files live under
`dist/release/rehearsal-vX.Y.Z/` and the publisher always rejects them.

## Verify a downloaded release

Download the APK, ZIP, `SHA256SUMS`, and `SHA256SUMS.minisig` from one release.
Get `release/minisign.pub` from the same Kepos source tag. In that download
directory, verify the publisher signature before trusting the checksums:

```sh
minisign -Vm SHA256SUMS -x SHA256SUMS.minisig -p /path/to/minisign.pub
shasum -a 256 -c SHA256SUMS
```

Stop if either command fails.

### Android

The APK supports Android 12 or newer on `arm64-v8a`. Its signing certificate
SHA-256 fingerprint is recorded in `release/android-certificate.sha256`. You
can compare it with:

```sh
apksigner verify --verbose --print-certs kepos-android-arm64-v0.1.0.apk
```

Install by sideloading the verified APK. Future Kepos APKs must use the same
certificate to update this installation.

### macOS

The ZIP contains an Apple Silicon app. It is ad-hoc signed, which checks bundle
integrity but does not give Gatekeeper an Apple-trusted publisher identity.
It is **Not notarized**.

After minisign and checksum verification, unzip it, move it to
`/Applications/Kepos.app`, and check its structure:

```sh
codesign --verify --deep --strict --verbose=4 /Applications/Kepos.app
codesign -dvvv /Applications/Kepos.app
```

If macOS blocks the verified app because it was downloaded from the internet,
remove quarantine only from this exact app and launch it again:

```sh
xattr -dr com.apple.quarantine /Applications/Kepos.app
```

## Key recovery

The release Mac holds the working JKS and minisign secret key. The remote NUC
holds only an age-encrypted recovery bundle; it is not an offline backup. Keep
the age passphrase somewhere else.

To recover, download the encrypted bundle to a fresh temporary directory on a
trusted Mac, compare its recorded SHA-256, decrypt it there, and verify the
Android certificate fingerprint and minisign public key before restoring the
working files. Delete the temporary plaintext after the drill. Do not record
the NUC hostname, passphrase, or real private-key paths in this repository.
