# Windows desktop dogfood evidence

This is a fill-in record for the Windows 11 x64 manual matrix. It contains no
observations until Main runs the commands on the logged-in `nuc-kep` session.
Use a new run directory and test-owned config/state for every row. Do not paste
keys, invitation URIs, or personal paths into this document.

## Build and native probe

Run from the Kepos checkout on the Mac:

```sh
scripts/windows/nuc-kep.sh
```

Record the returned run ID, root revision, and the three native submodule
revisions from `build-revisions.txt`:

| Check | Expected | Verified result | Run ID / log |
| --- | --- | --- | --- |
| Node/npm preflight | Node 24, npm 11 | _pending_ | _pending_ |
| MSVC/CMake/Bare preflight | all present | _pending_ | _pending_ |
| Windows executable | `Kepos\App\Kepos.exe`, manifest, icon, and required DLLs | _pending_ | _pending_ |
| bare-win-ui native probe | exit 0 | _pending_ | _pending_ |

## Test-owned role launch

From WSL on `nuc-kep`, replace `<run>` with the retrieved run ID. The Windows
process receives no live user configuration because both roots are owned by the
run directory:

```sh
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -Command "
  \$buildRoot = Join-Path \$env:USERPROFILE '.local\\kepos-build';
  \$root = Join-Path \$buildRoot '<run>\\dogfood';
  New-Item -ItemType Directory -Force \"\$root\\AppData\", \"\$root\\State\" | Out-Null;
  \$env:APPDATA = \"\$root\\AppData\";
  \$env:LOCALAPPDATA = \"\$root\\State\";
  & (Join-Path \$buildRoot '<run>\\dist\\desktop\\Kepos\\App\\Kepos.exe') --config \"\$root\\AppData\\Kepos\\config.toml\"
"
```

Prepare publisher identities and subscriber contacts with the Windows Node
CLI in the same `State` root before launching a role. Keep public keys out of
this record. The config rows below show the only role settings that differ.

| Matrix row | Publisher | Subscriber | Test-owned paths | Visible start result |
| --- | --- | --- | --- | --- |
| Publisher-only | enabled | disabled | _pending_ | _pending_ |
| Subscriber-only | disabled | enabled | _pending_ | _pending_ |
| Dual-role | enabled | enabled | _pending_ | _pending_ |

## Resident lifecycle and peer matrix

| Probe | Expected observation | Verified result | Notes / log |
| --- | --- | --- | --- |
| Close during startup | window hides; startup cleanup completes | _pending_ | _pending_ |
| Close while traffic is active | traffic continues; same window reopens from tray | _pending_ | _pending_ |
| Repeated Open/Close | one window, no duplicate tray | _pending_ | _pending_ |
| Quit during startup | ordered cleanup; immediate restart works | _pending_ | _pending_ |
| Quit during normal operation | publisher, subscriber, WebView, tray, window, locks stop once | _pending_ | _pending_ |
| Second launch | singleton conflict is visible; no second owner | _pending_ | _pending_ |
| Mac → Windows service | expected service access | _pending_ | _pending_ |
| Windows → Mac service | expected service access | _pending_ | _pending_ |
| Firewall | record profile/prompt and executable path only | _pending_ | _pending_ |
| Explorer restart | notification icon returns | _pending_ | _pending_ |

The firewall and Explorer rows are genuine logged-in Windows observations and
cannot be verified by the Mac-side build script. No CI Windows build or release
asset is implied by this evidence template.
