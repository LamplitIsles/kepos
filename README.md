# Kepos

[![CI](https://github.com/LamplitIsles/kepos/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/LamplitIsles/kepos/actions/workflows/check.yml)
[![codecov](https://codecov.io/github/LamplitIsles/kepos/graph/badge.svg?branch=main)](https://app.codecov.io/github/LamplitIsles/kepos)

**Share a service, not a network.**

Kepos gives trusted devices access to selected services without exposing a
public service port or joining every device to a virtual subnet. A publisher
owns the service and its allowlist; a subscriber receives the allowed service
as an ordinary local URL or TCP port.

Kepos has no hosted account or Kepos-operated control plane. Device keys stay
on the devices that created them. The current service path is TCP-only, carried
through an authenticated peer connection whose Internet transport uses UDP.

> Kepos is a developer preview. Android APKs, Apple Silicon macOS ZIPs, and
> Windows x64 portable ZIPs are available for direct download. Android is
> sideload-only; macOS is ad-hoc signed and not notarized; Windows is not
> Authenticode-signed and may trigger SmartScreen.

## Start here

The **[Kepos user documentation](https://kepos.guion.io/docs/)** is the
primary installation, pairing, publisher, subscriber, trust, comparison, and
troubleshooting guide.

Developers and operators can continue with:

- [Developer architecture](docs/architecture.md)
- [CLI, identity, and configuration](docs/cli.md)
- [Platform and release guides](docs/platforms/)
- [Nix, container, and Kubernetes deployment](docs/deployment.md)
- [Network transport and compatibility](docs/network-transport-and-compatibility.md)

## Supported surfaces

| Surface | Roles | Current boundary |
| --- | --- | --- |
| Android | Subscriber | Android 12+, `arm64-v8a`, sideload-only; persistent app-private subscriber identity |
| macOS | Publisher, subscriber, or both | Apple Silicon; native desktop app; ad-hoc-signed direct-download ZIP |
| Windows | Publisher, subscriber, or both | Windows 10 x64 build 19045 (22H2)+ and Windows 11 x64; portable ZIP with optional per-user install |
| Headless CLI | Publisher, subscriber, or both | Node.js 24; local HTTP gateway and explicit raw TCP listeners |
| Nix / Home Manager | Publisher and CLI | Declarative publisher policy; private keys stay out of the Nix store |
| Container | Publisher and subscriber | Non-root `linux/amd64` image; deployment owns state, networking, and supervision |

The repository's Kubernetes path is an operator-owned subscriber gateway, not a
shipped cluster product. See [deployment](docs/deployment.md) for its boundary.

## Direct downloads

These links follow GitHub's latest **stable** release and do not select beta
prereleases:

- [Android APK](https://github.com/LamplitIsles/kepos/releases/latest/download/kepos-android-arm64.apk) — subscriber only
- [Apple Silicon macOS ZIP](https://github.com/LamplitIsles/kepos/releases/latest/download/kepos-macos-arm64.zip) — publisher and subscriber
- [Windows x64 ZIP](https://github.com/LamplitIsles/kepos/releases/latest/download/kepos-windows-x64.zip) — publisher and subscriber

Download `SHA256SUMS` and `SHA256SUMS.minisig` from the same release and follow
[release and artifact verification](docs/releasing.md) before opening a binary.

## Develop

Requirements: Node.js 24, npm 11, and initialized Git submodules for desktop
development.

```sh
git clone --recurse-submodules https://github.com/LamplitIsles/kepos.git
cd kepos
npm ci
npm run kepos -- --help
```

Run the full portable check:

```sh
npm run check
```

Useful platform checks are separate from the root check:

```sh
npm run android:check
npm run android:install
npm run android:device-check
npm run desktop:check
npm run desktop:native-check
```

`android:install` uses `adb install -r`, preserving app-private state. The
physical-device gate uses the isolated `io.github.ttalab.kepos.devicetest`
package so it cannot replace or remove the installed Kepos app.

The website is the `@lamplitisles/kepos-web` npm workspace:

```sh
npm run web:dev
npm run web:verify
npm run web:deploy:dry-run
```

Cloudflare Git Builds are disabled. Deployment is a local post-merge
operation; do not use the deploy command for ordinary development.

## More repository documentation

- [Android subscriber](docs/platforms/android.md)
- [macOS desktop](docs/platforms/macos.md)
- [Windows desktop](docs/platforms/windows.md)
- [Release and artifact verification](docs/releasing.md)
- [How Kepos grew from Hypertele](docs/hypertele-provenance.md)
- [Architecture decisions](docs/adr/)
- [Physical and field evidence](docs/evidence/)

The evidence directory records environments, commands, failures, and remaining
gates. It is separate from current product claims.

## License

[Apache License 2.0](LICENSE)
