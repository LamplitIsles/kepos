# macOS desktop subscriber spike evidence

Date: 2026-07-24 (Asia/Shanghai)

## Environment

- Host: Apple Silicon (`arm64`)
- OS: macOS 26.5 (build 25F71)
- App: unsigned `dist/desktop/Kepos.app`
- State: `~/.local/state/kepos-neo/mux-navidrome-subscriber` (secret files not copied)
- `bare-web-kit`: `52486fa13a2f34ee347c26a580f3bc3db4ffd4cd`
- `bare-native`: `02d83fca71c09f50afd603766d21febe73049849`

## Build

```sh
git submodule update --init --recursive
npm ci
npm run desktop:build
```

The build compiled the local Darwin arm64 `bare-web-kit` source, packaged the
app with `bare-native/runtime`, linked the native AppKit and WebKit frameworks,
and produced an ad-hoc signed arm64 Mach-O app. The native compile step is part
of `desktop:build`; it does not rely on an untracked prebuild left on this Mac.

## Physical acceptance

The app launched with:

```sh
dist/desktop/Kepos.app/Contents/MacOS/Kepos \
  --subscriber-state ~/.local/state/kepos-neo/mux-navidrome-subscriber \
  --subscriber-service ssh:2222
```

These are the current role-explicit names for the same subscriber-only launch;
the original spike predated publisher support.

Observed results:

- one `Kepos` process owned the subscriber, gateway, WebView, and shutdown;
- one 720 × 648 Kepos window showed `kosmos-wsl` as connected;
- the validated Registry contained Home plus Ente Photos, Ente Storage,
  Forgejo, Navidrome, SSH, and Woodpecker;
- `curl --noproxy '*' http://navidrome.localhost:17480/ping` returned `.`;
- `ssh -p 2222 127.0.0.1 true` exited successfully;
- Navidrome copied `http://navidrome.localhost:17480/`;
- Forgejo `OPEN` launched `http://forgejo.localhost:17480/` in the default
  browser while Kepos remained at one window;
- a second desktop launch exited without adding a process, window, or
  subscriber connection;
- a held CLI subscriber-state lock rejected desktop launch before any window
  opened.

The initial external-open package failed because JavaScript had changed while
the ignored native prebuild was stale. The runtime log showed
`binding.webViewOpenExternal is not a function`. Rebuilding the Darwin native
binding fixed it; `desktop:build` now performs that build so a fresh checkout
does not repeat the mismatch.

## Automated checks

```sh
npm run check
npm run desktop:check
npm run desktop:build
npm ls --omit=dev
nix flake check
git diff --check
```

The root check passed 180 tests with 96.72% line, 85.73% branch, and 92.36%
function coverage. Fork unit tests passed 5/5 in `bare-web-kit` and 5/5 in
`bare-native`. `nix flake check` passed on the x86_64 Linux NUC checkout; the
Mac itself does not have Nix installed.

## Remaining physical gate

The same packaged process still needs one deliberate Mac network change to
record reconnect-in-place. This is kept explicit because changing the active
network can disrupt unrelated work on the machine.
