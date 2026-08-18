# Windows desktop dogfood evidence

This record combines automated observations from a logged-in Windows 11 x64
`nuc-kep` session with the remaining manual matrix.
Use a new run directory and test-owned config/state for every row. Do not paste
keys, invitation URIs, or personal paths into this document.

## Build and native probe

Run from the Kepos checkout on the Mac:

```sh
WINDOWS_USER=<windows-account> scripts/windows/nuc-kep.sh
```

Record the returned run ID, root revision, and the three native submodule
revisions from `build-revisions.txt`:

| Check | Expected | Verified result | Run ID / log |
| --- | --- | --- | --- |
| Node/npm preflight | Node 24, npm 11 | Node 24.18.1, npm 11.16.0 | `20260817T182811Z-219` orchestrator log |
| MSVC/CMake/Bare preflight | all present | passed; native runtime compiled and linked | `20260817T182811Z-219` desktop-build log |
| Windows executable | `Kepos\App\Kepos.exe`, manifest, icon, and required DLLs | passed and retrieved to the Mac | `20260817T182811Z-219` artifact-files log |
| bare-win-ui native probe | exit 0 | passed | `20260817T182811Z-219` bare-win-ui result log |

## Test-owned role launch

From WSL on `nuc-kep`, replace `<run>` with the retrieved run ID. The Windows
process receives no live user configuration because both roots are owned by the
run directory:

```sh
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -Command "
  \$buildRoot = Join-Path \$env:SystemDrive 'kb';
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
| Publisher-only | enabled | disabled | run-owned AppData/LocalData | visible window; 2 UDP endpoints |
| Subscriber-only | disabled | enabled | run-owned AppData/LocalData | visible window; 2 UDP endpoints |
| Dual-role | enabled | enabled | run-owned AppData/LocalData | visible window; 2 UDP endpoints |

## Resident lifecycle and peer matrix

| Probe | Expected observation | Verified result | Notes / log |
| --- | --- | --- | --- |
| Close during startup | window hides; startup cleanup completes | _pending_ | _pending_ |
| Close while traffic is active | traffic continues; same window reopens from tray | partial: process and both UDP endpoints survived red close | service traffic and tray reopen remain pending |
| Repeated Open/Close | one window, no duplicate tray | _pending_ | _pending_ |
| Quit during startup | ordered cleanup; immediate restart works | _pending_ | _pending_ |
| Quit during normal operation | publisher, subscriber, WebView, tray, window, locks stop once | _pending_ | _pending_ |
| Second launch | singleton conflict is visible; no second owner | passed; second process exited nonzero while first remained resident | isolated dual-role run |
| Mac → Windows service | expected service access | _pending_ | _pending_ |
| Windows → Mac service | expected service access | _pending_ | _pending_ |
| Firewall | record profile/prompt and executable path only | _pending_ | _pending_ |
| Explorer restart | notification icon returns | _pending_ | _pending_ |

The firewall and Explorer rows are genuine logged-in Windows observations and
cannot be verified by the Mac-side build script. No CI Windows build or release
asset is implied by this evidence template.
