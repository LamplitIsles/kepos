# macOS desktop publisher spike evidence

Date: 2026-07-25 (Asia/Shanghai)

## Environment

- Host: Apple Silicon (`arm64`)
- OS: macOS 26.5 (build 25F71)
- App: unsigned `dist/desktop/Kepos.app`
- Outbound subscriber state:
  `~/.local/state/kepos-neo/mux-navidrome-subscriber`
- Inbound publisher and subscriber states: isolated temporary directories under
  `/tmp` (removed after the smoke test)
- Publisher target: loopback HTTP server on port 18080
- Temporary subscriber gateway: port 17490

No state secrets, publisher seeds, subscriber secrets, public IP addresses, or
pairing tokens are recorded here.

## Build

```sh
npm ci
npm run desktop:build
```

The packaged Bare app includes the Home HTML and CSS assets needed by the
publisher runtime. Node built-ins used by the shared Home server map to their
Bare implementations in the packaged module graph.

## Dual-role acceptance

The packaged app launched with both existing subscriber state and isolated
publisher state:

```sh
dist/desktop/Kepos.app/Contents/MacOS/Kepos \
  --subscriber-state ~/.local/state/kepos-neo/mux-navidrome-subscriber \
  --subscriber-service ssh:2222 \
  --publisher-state "$SMOKE_ROOT/publisher"
```

Observed results:

- one desktop process owned both independent role runtimes;
- both the publisher-state and subscriber-state runtime locks belonged to that
  process;
- `curl --noproxy '*' http://navidrome.localhost:17480/ping` returned `.`;
- `ssh -p 2222 127.0.0.1 true` exited successfully;
- attempting `kepos publisher run` with the same publisher state failed with
  the expected identity-in-use error and did not disturb the desktop app;
- a separate temporary subscriber connected through gateway port 17490;
- `curl --noproxy '*' http://smoke.localhost:17490/` returned the loopback
  target response;
- stopping the temporary subscriber left the desktop's outbound subscriber
  services usable.

The user inspected the role sidebar and both role views during this run.

## Single-role acceptance

Publisher-only launch used only `--publisher-state`. It acquired only the
publisher lock and did not bind the subscriber gateway or SSH listener.

Subscriber-only launch used only the role-explicit subscriber flags. It
acquired only the subscriber lock, and both the Navidrome ping and SSH probe
passed.

For all three launch shapes, the in-app **Quit Kepos** action stopped the
process and released the requested role locks and listeners. No new macOS crash
report appeared after these in-app exits.

## Automated checks

```sh
npm ci
npm run check
npm run desktop:check
npm run desktop:build
git diff --check
```

These checks are rerun on the final branch after recording this evidence.

## Shared TOML launch

After the initial role-flag smoke, an isolated HOME was prepared with:

- `~/.config/kepos/config.toml` containing an enabled, Home-only publisher;
- publisher identity at the fixed
  `~/.local/state/kepos-neo/publisher` location;
- no desktop role flags.

The rebuilt packaged app loaded that TOML, started the publisher, and acquired
the canonical publisher runtime lock. The log contained no option, config, or
startup error. This isolated smoke did not read or modify the user's live Kepos
identity.

The live Mac subscriber identity was then moved, not copied, from its dogfood
directory to the canonical `~/.local/state/kepos-neo/subscriber` directory. The
shared TOML enabled subscriber with gateway port 17480 and SSH port 2222. A
no-argument packaged launch acquired the canonical subscriber lock;
`http://navidrome.localhost:17480/ping` and the loopback SSH probe both passed.

## Deferred work

This spike does not add QR pairing, a tray/menu-bar process, publisher setup or
editing UI, signing, notarization, DMG packaging, Windows delivery, or a
network-switch acceptance gate. Android was not built or exercised.
