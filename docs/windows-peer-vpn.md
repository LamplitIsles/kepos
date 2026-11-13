# Kepos VPN (Windows)

The Windows client is called **Kepos VPN**; its executable is `KeposVPN.exe`.
It is a Windows 11 x64 **personal test build**. It runs the same worklet engine as the
other Kepos hosts with a Wintun overlay device, and joins a managed receiver with
an invitation. The tray owns the interface; the backend in `apps/windows` owns the
identity, pairing, connection supervision and the overlay device.

The package has been built and statically checked on Linux. One **user-reported**
startup check on an isolated Windows machine exists (see "Device evidence"): it
covered starting the application and copying the public key from the tray, and
nothing else. Every other statement about runtime behaviour is a design
intention, not an observation, and none of the reported run was independently
verified by this repository.

## Scope

- Windows 11 x64 only. No claim for Windows 10, ARM64 or Server.
- IPv4 TCP overlay to authorized peers, one `/32` local address, one `/32` route
  per peer, MTU 1400. No DNS changes, no IPv6 overlay, no application UDP, no
  subnet forwarding, no exit node.
- The application must run **as administrator**: creating the Wintun adapter and
  adding addresses and routes needs elevation. There is no separate privileged
  service.
- **Clash TUN must be off.** The build does not configure Clash, does not scan
  for conflicting tunnels and does not coexist with another TUN.
- One identity per Windows user profile, in `%LOCALAPPDATA%\Kepos\windows`. No
  migration of any older Kepos Windows state, and no reading of another host's
  identity.

## Pairing, identity and the unknown outcome

- The device identity is one seed in `peer.json`; the public key is derived by
  the worklet and shown in the tray so it can be copied.
- Pairing is a separate step from connecting, as on iOS: pair while
  disconnected, then connect.
- Before an invitation can leave the process, a marker
  (`pair-pending.json`) is written and flushed. If that write fails, **nothing is
  sent** and the tray reports a state error.
- If the outcome is unknown — a lost response, an unusable result, a failed
  configuration write, an interrupted attempt, or the engine dying mid-pairing —
  the marker is kept and the tray reports an unknown outcome. The user must
  inspect the receiver's authorized devices before acknowledging it; pairing
  stays blocked until they do. The invitation is never replayed automatically,
  and the warning survives a restart.
- A configuration is only reported as paired after it was written to disk. A
  failed write is reported as an unknown outcome, because the receiver may
  already have admitted the device.

## Build

```sh
npm run windows:build
```

Inputs, all already in the repository or its ignored build directories:

| Input | Where |
| --- | --- |
| Bare Kit 3.0.1 Windows x64 library | `.build/bare-kit/3.0.1/windows-x64/bare-kit.dll` (provenance in that directory) |
| Wintun 0.14.1 release archive | `.build/wintun-0.14.1.zip` (SHA-256 verified by the script) |
| Addon prebuilds and bundling tools | `node_modules` |

The script bundles the worklet with `esbuild` and `bare-pack --host win32-x64
--linked`, links the four addons with `bare-link --host win32-x64`, generates an
import library and a forwarder `.def` from the library's actual exports, builds
the tray with `cargo xwin rustc --release`, and copies the runtime, the driver and
the licences. It cross-compiles from Linux with the local `cargo-xwin` cache; no
Windows machine is needed to build, and nothing is downloaded by the script.

Two linker details matter and are easy to lose:

1. **Symbol forwarding.** The prebuilt addons delay-load and resolve bare/js/uv
   symbols against the host executable, so `KeposVPN.exe` is linked with a `.def`
   that forwards 801 symbols to `bare-kit.dll`. Without it, addon loading fails
   at runtime.
2. **Manifest.** The executable embeds
   `requireAdministrator`; the manifest is what makes Windows request elevation
   when the application starts.

Output: `apps/windows/target/package/kepos-windows-x64/`. The script replaces that
directory only when every entry in it is a file the script writes; otherwise it
stops instead of deleting data.

| File | Role |
| --- | --- |
| `KeposVPN.exe` | tray and backend |
| `install.cmd` | portable install: copies this folder to `%LOCALAPPDATA%\Programs\Kepos VPN` and starts Kepos VPN |
| `bare-kit.dll` | Bare Kit 3.0.1 native library |
| `bare-inspect-3.1.4.dll`, `bare-type-1.4.0.dll`, `sodium-native-5.1.0.dll`, `udx-native-1.20.7.dll` | worklet addons; must stay next to the executable |
| `kepos-worklet.bundle` | packed worklet |
| `wintun.dll` + `wintun.LICENSE.txt` | unmodified Wintun driver and its prebuilt-binaries licence |
| `LICENSE`, `THIRD-PARTY.md`, `licenses/` | Kepos licence, component inventory, and the licence files of every linked crate |
| `README.txt` | run notes |

## Installing and using it

1. Run `KeposVPN-0.1.0-setup.exe` from the release and follow the wizard. It
   installs to `%LOCALAPPDATA%\Programs\Kepos VPN`, adds a Start Menu shortcut
   and an entry under Settings → Apps (uninstall), and needs no administrator
   rights itself. It refuses a folder it does not own, and it refuses to run
   while `KeposVPN.exe` is open — quit the app first. Running a newer setup
   replaces the files this installer owns in that folder.
   The unpacked folder can also be used directly as a portable copy; its
   `install.cmd` copies it to the same place. Either way, nothing ever reads or
   writes `%LOCALAPPDATA%\Kepos\windows`, and no service, scheduled task or
   autostart entry is created.
2. Close Clash TUN mode, then accept the administrator prompt. If the prompt is
   declined the application does not start; there is no reduced mode.
3. Get the invitation from the receiver operator and choose **Pair with
   invitation…** in the menu. A small dialog opens: paste or type the invitation
   there and confirm with **Pair**. The menu also keeps "copy public key" for
   sending this device's key to the receiver operator.
4. Connect. The tray distinguishes "VPN running" from "receiver connected": a
   running engine does not prove the receiver is reachable.
5. Disconnect, or quit; quitting stops the tunnel and releases the adapter, its
   routes and the identity lock.
6. To remove Kepos VPN, quit it and uninstall it from Settings → Apps. The
   uninstaller deletes only the files this installer placed in
   `%LOCALAPPDATA%\Programs\Kepos VPN`; the identity in
   `%LOCALAPPDATA%\Kepos\windows` is left in place by design.

If the tray reports that the backend is no longer running (for example after the
engine did not confirm its exit), restart the application: the identity is still
locked in that process on purpose.

## Licences

`THIRD-PARTY.md` lists every component in the package, with the licence files of
the exact crate versions linked into the executable (copied from the local cargo
registry), the Bare Kit licence and NOTICE, each addon's own licence, and the
Wintun prebuilt-binaries licence. The Kepos crates themselves are covered by the
project `LICENSE`. Rebuilding regenerates the inventory; if a third-party crate
has no licence file in its package the build fails rather than shipping an
incomplete list.

## Verified and unverified

Statically verified on Linux, from the built artifact:

- `KeposVPN.exe` imports `bare-kit.dll` and re-exports `bare_module_find` and the
  other bare/js/uv symbols the addons need.
- The executable contains the `requireAdministrator` manifest.
- The package contains the runtime, the four addons, the worklet bundle, the
  driver, the licence files listed above, and `install.cmd`.
- `install.cmd` names exactly the files the package contains, refuses to touch an
  existing installation, removes only a copy it created when a step fails, and
  never writes the state directory.
- The NSIS setup installs into `%LOCALAPPDATA%\Programs\Kepos VPN`, writes a
  `kepos-vpn-install-v1` ownership marker, refuses a non-empty folder without that
  marker, refuses while `KeposVPN.exe` is open, and uninstalls by deleting only
  the files it installed plus its own marker, shortcut and registry entry. It
  never uses a recursive delete of the install folder and never mentions the
  state directory except in a comment.
- These properties are checked statically on the generated `.nsi`, by an
  ownership model in a temporary directory, and by building the setup with the
  installed NSIS. The setup has since been installed and run by the user on the
  NUC, but its install folder, ownership marker, shortcut and uninstall entry
  were not independently inspected here.
- `cargo test` covers the platform-independent backend: framing, identity and
  configuration storage, the pending-pairing marker, the pairing/connection state
  machine, the action dispatcher and the outbox.

### Device evidence (user-run on the NUC)

The application was paired with the real receiver from the NUC and connected
twice. Both attempts are recorded in the client's own event log
(`%LOCALAPPDATA%\Kepos\logs\vpn-<pid>.log`) and, for the second attempt, in the
receiver's service log:

- First attempt: `phase:connecting` → `settings` → `device:open-ok` /
  `ready-written` → `diag listen`, then `read-eof` / `exit-0` / `worklet:gone`
  about 5.8 s later, with no `running` and no `error` frame.
- Second attempt: `phase:connecting` → `settings` → `device:open-ok` /
  `ready-written` → `diag-listen` at 4348 ms → `worklet:running`,
  `phase:connected` and `diag-listen-returned` at 7423 ms.
- Receiver service log at the same time: the client key
  `80f325b0…dd11a5` authenticated handshake admitted, then `transport accepted`
  and `VPN peer connected`.

So the worklet started, the addons loaded, the Wintun device opened, the DHT
listened, and the authenticated peer session was established. The two attempts
differ, and the cause of the first one's silent exit is **not** established; no
change in this repository has been shown to cause or prevent it.

Limits: the logs are fixed codes only, so they do not show packet counts or
which packets were forwarded; no application traffic was measured; no device
was instrumented. This is two attempts on one machine.

**Not verified** — these still need a device run:

- The elevation prompt's behaviour when declined, the full tray menu, and
  whether every menu action reaches the backend.
- Creating and removing the Wintun adapter, applying the address and MTU, and
  adding/removing the `/32` routes; whether the driver is really removed with the
  adapter after an abnormal exit.
- Real packet flow: application TCP traffic through the tunnel, allowed and
  denied TCP, disconnect and reconnect, and repeated attempts in one process.
- Memory, CPU, and behaviour with Clash TUN accidentally on.

## Runtime diagnostics

The backend writes a bounded event log to
`%LOCALAPPDATA%\Kepos\logs\vpn-<pid>[-n].log` (next to, never inside, the
identity directory). It contains only fixed event codes and a millisecond
counter relative to process start, for example:

```
      12ms start
      18ms phase:idle
    1420ms phase:connecting
    1430ms engine:create-ok
    1512ms worklet:gone
    1513ms engine:ipc-closed
```

Codes cover the connect path (`phase:*`, `engine:create-ok|create-fail`,
`engine:start-fail`, `engine:exit-timeout` after the 10 s wait,
`engine:ipc-closed`, `worklet:gone`, `device:open-fail`, `retire:begin|done`,
`shutdown`). There is no API for free text, so invitations, seeds, keys,
configuration and packet data cannot appear in it. Each file stops at 64 KiB, a
new file is created per process instead of overwriting an existing one, and any
log write failure is ignored so the VPN is unaffected. If no file appears, the
directory could not be created — the VPN still runs.

## Power-loss boundary

The marker and the configuration are written to a temporary file, flushed, and
replaced with `MoveFileExW(MOVEFILE_WRITE_THROUGH)`. Microsoft documents that flag
as "the function does not return until the file is actually moved on the disk",
with an explicit flush guarantee only for a copy-and-delete move; `FlushFileBuffers`
covers file data and metadata, and no user-mode API is documented to flush a
parent directory entry. A power loss immediately after the write can therefore
lose that directory entry, and the loss cannot be detected: a lost marker reads as
"no marker" and pairing would be allowed again. Two measures narrow this without
closing it — the contents are flushed before the move, and a leftover `*.tmp` file
is also treated as a marker. No stronger guarantee is claimed.

## Isolation harness

`apps/windows/kepos-vpn/src/bin/isolation-harness.rs` runs the real packed
worklet, the real IPC and the real frame codec without the installed
application. It uses a synthetic identity and a synthetic configuration whose
DHT bootstrap is a single loopback address, opens no TUN adapter (packet frames
are counted and dropped), adds no route and never pairs. It reads nothing from
`%LOCALAPPDATA%\Kepos` and nothing from `%LOCALAPPDATA%\Programs\Kepos VPN`.

### Build

The harness executable is a Bare Kit host, so it needs the same two link inputs
the packaged `KeposVPN.exe` uses: the import library generated from
`bare-kit.dll`, and `kepos-host.def`, which forwards the `bare_*` exports that
the addons resolve from the host executable. Without the `.def` the executable
still links, but it exports nothing, and addon loading cannot be expected to
work.

```sh
cd apps/windows
PKG=$PWD/../../.build/windows-package
RUSTFLAGS="-C target-feature=+crt-static" \
  cargo +1.99.1 xwin rustc -p kepos-vpn --bin isolation-harness --release \
  --target x86_64-pc-windows-msvc --offline -- \
  -L "native=$PKG" -C "link-arg=/DEF:$PKG/kepos-host.def"
```

The link inputs are passed with `cargo rustc ... -- <args>` so they reach only
this crate's final link, exactly as the packaging build does for `kepos-tray`.
They must not go into `RUSTFLAGS`: that would add the forwarder table to every
dependency and every build script, which breaks crates that run a linker
probe, `tun-rs` among them. The only global flag is `+crt-static`, which must
match the flag the cached release artifacts were built with; a different global
flag rebuilds every dependency and costs about 137 MiB of duplicate artifacts.

The build is 1.3 s when the cached release artifacts match, and about 4.5 MiB of
new artifacts. An earlier build without the `.def` and without the static CRT
had no export table and imported `VCRUNTIME140.dll`; it has been rebuilt with
the command above and checked as described below.

Static check of the result (no Windows host needed):

```sh
llvm-readobj --coff-exports apps/windows/target/x86_64-pc-windows-msvc/release/isolation-harness.exe
llvm-readobj --coff-imports  apps/windows/target/x86_64-pc-windows-msvc/release/isolation-harness.exe
```

The exports must list the same 46 `bare_*` names the packaged `KeposVPN.exe`
exports, each forwarded to `bare-kit.dll`, including `bare_module_find`,
`bare_worklet_start` and `bare_ipc_read`; the imports must list `bare-kit.dll`
and must not list `VCRUNTIME140.dll`, which would mean the static CRT flag was
missing.

### Test-only bundle with a fake DHT

`apps/windows/kepos-vpn/worklet/harness-entry.ts` runs the real
`runWorkletBridge`, the real framing and the real IPC, but passes
`startVpnEngine` an injected `dht` (`worklet/fake-dht.ts`). The engine uses
`options.dht ?? createDht(...)`, so with an injected DHT it never evaluates
`createDht` and the fake never opens a socket.

```sh
OUT=apps/windows/target/harness
node_modules/.bin/esbuild apps/windows/kepos-vpn/worklet/harness-entry.ts \
  --platform=node --format=cjs --packages=external --bundle --minify-syntax \
  --define:KEPOS_ACCEPTANCE_DIAGNOSTICS=false --outfile=$OUT/harness-worklet.cjs
node_modules/.bin/bare-pack --host win32-x64 --linked \
  --out $OUT/kepos-harness-worklet.bundle $OUT/harness-worklet.cjs
node_modules/.bin/bare-link --host win32-x64 --out $OUT $OUT/harness-worklet.cjs
```

The scenario is carried by this device's synthetic overlay address, which the
fake DHT never routes on: `198.18.0.1` makes the fake listen resolve,
`198.18.0.2` makes it reject and `198.18.0.3` leaves it pending. The fake reads
it from the parsed `PeerConfig.vpn.address`, not from the raw TOML.
`isolation-harness.exe --dht <success|reject|pending>` selects one and prints
`EVENT dht-mode`. The harness sink always binds `127.0.0.1:0`, so no fixed
system port is claimed, and the configured bootstrap points at that ephemeral
port.

The harness keeps that socket bound for the whole run and counts what arrives
on it. `EVENT sink-datagrams 0` says only that this socket received nothing; it
is not evidence about any other network activity in the process.

What this shows: the fake DHT creates no real DHT socket, and the engine's
bridge, framing, IPC and supervision behave under each listen outcome. What it
does not show: that the whole process makes no outbound connection. The bundle
still imports the real `hyperdht`, `udx` and `sodium` modules at load time,
`runWorkletBridge` and the engine are otherwise unchanged, and nothing here
blocks a socket at the OS level. Only an OS-level block (a firewall rule or a
restricted token) could support a whole-process claim, and this harness installs
neither. A fake DHT also says nothing about real DHT behaviour on a device.

### Run on the test machine

The harness must run from a copy of the packaged files, so `bare-kit.dll`, the
bundle and the four addons resolve, and the installed application is never
touched. Run it through the checked-in wrapper with a complete PowerShell file:

```powershell
# isolation-harness.ps1
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:TEMP ("kepos-harness-" + [guid]::NewGuid().ToString('N'))
Copy-Item -Recurse -LiteralPath 'C:\kepos-harness' -Destination $work
Copy-Item -LiteralPath 'C:\kepos-harness\isolation-harness.exe' -Destination $work
try {
  & (Join-Path $work 'isolation-harness.exe') `
    --bundle (Join-Path $work 'kepos-harness-worklet.bundle') --timeout-ms 30000 --dht success
  "harness-exit=$LASTEXITCODE"
} finally {
  Remove-Item -Recurse -Force -LiteralPath $work
}
```

`C:\kepos-harness` stands for the transferred harness directory: the contents
of `apps/windows/target/harness` (the bundle and the four addons bare-link
produced), `bare-kit.dll` from the package, and `isolation-harness.exe`. The
installed application directory is never used.

### Output

One `EVENT <label>` line per observation, plus `last-stage` and `verdict`.
Stages are printed only for the fixed labels in
`apps/windows/kepos-vpn/src/harness.rs::STAGES`; any other string in a control
frame is dropped, so no value from the worklet can reach the output.

The verdict is a real outcome only when the engine reported one:
`settings-running`, `settings-error-<stage>` or `settings-stopped`. Otherwise it
states what was last observed and how the run stopped, for example
`last-observed-listen-eof`, `last-observed-listen-timeout` or
`no-settings-timeout`. End of stream, timeout and a harness abort are kept
separate, and a missing stage is never treated as evidence, because the
diagnostic channel is best-effort: a dropped frame says nothing about the
engine.

Exit code 0 means a real outcome was observed, 1 means none was, 2 means the
harness could not start.

### Limits

Network isolation is by configuration only. `hyperdht` replaces its public
bootstrap list with the configured one, so the only node the engine is told
about is the loopback address the harness selected; no DNS name is involved.

The harness binds a UDP socket on `127.0.0.1:0`, reads the port it was given,
closes it and uses that port, so the destination was observed unbound on this
machine immediately before the run instead of assuming a fixed port such as 1
is free. The observation is a moment in time: the port could be claimed between
the check and the first packet, and nothing here stops another process from
binding it.

That is still not a process-level guarantee. The runtime binds its own local
UDP sockets and the harness installs no firewall rule, so it cannot show that
no packet leaves the machine. The alternatives each cost more than they buy
here: an OS-level block needs a firewall change on the test machine, and a
fake DHT would mean injecting a different node into the shipping engine or
packing a second bundle, which stops the run from exercising the real engine.

The harness does not prove Windows TUN, Wintun or route behaviour and does not
replace a device run. It reports whether the engine reached `running`, reported
a failure, or was still at some stage when the stream ended or the timeout
expired.
