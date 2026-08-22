# Windows desktop

For end-user installation, pairing, and troubleshooting, start with the [public Kepos guide](https://kepos.guion.io/docs/). This page keeps Windows packaging and operator detail.

Kepos supports **Windows 10 x64 build 19045 (22H2) and later, and Windows 11
x64** as a portable desktop application with an optional per-user scripted
install. Download `kepos-windows-x64.zip`, verify it, and keep the extracted
`Kepos\` directory together. The ZIP contains the x64 self-contained Windows
App Runtime tree, so Microsoft Windows App Runtime does not need to be
installed separately. The WebView2 Runtime and Microsoft Visual C++
Redistributable remain system prerequisites; Kepos does not bundle either one.

The ZIP has two supported paths:

- **Portable:** launch `Kepos\App\Kepos.exe` directly. This is useful for a
  temporary or deliberately movable extraction, but do not move or distribute
  `Kepos.exe` alone.
- **Per-user install:** after extracting the ZIP, double-click
  `Kepos\Install.cmd`. It installs the complete tree without administrator
  elevation under `%LOCALAPPDATA%\Programs\Kepos`, creates a Start Menu
  shortcut and a Desktop shortcut, and creates a Start Menu **Uninstall Kepos**
  shortcut. The shortcuts target `App\Kepos.exe` directly and use its embedded
  Kepos icon.

The installer is not MSI, MSIX, a Store package, an Add/Remove Programs
registration, a service, a login startup task, or an updater. The ZIP remains
the signed-by-minisign/SHA-256 release unit; the Windows executable and scripts
are not Authenticode-signed.

## Install, repair, and upgrade

Quit Kepos from the notification-area menu before installing, repairing, or
upgrading. The scripts never terminate a running process and refuse when a
`Kepos.exe` process is still using the source or installed tree.

- **First install:** run `Install.cmd` from a freshly extracted release.
- **Repair shortcuts:** run the installed
  `%LOCALAPPDATA%\Programs\Kepos\Install.cmd`. It validates the owned tree and
  recreates missing owned shortcuts. Use `-NoDesktopShortcut` when the owned
  Desktop shortcut should be omitted; it never removes an unrelated Desktop
  file or shortcut.
- **Upgrade:** extract the newer ZIP to a new directory and run its
  `Install.cmd`. The installer validates the payload, copies it to same-volume
  staging, and swaps the owned installation only after the staged tree and
  shortcuts validate. An unowned, malformed, linked, or running destination is
  left in place. A failed replacement rolls back to the previous owned tree.

The installer records a small ownership marker in the program tree so it can
prove that replacement and removal are limited to a Kepos installation. Keep
the extracted release until an upgrade has completed successfully.

## Data and firewall

Windows configuration is stored under `%APPDATA%\Kepos\config.toml`, role state
under `%LOCALAPPDATA%\Kepos\state\{publisher,subscriber}`, and diagnostics
under the user-owned Kepos diagnostics directory. Installation and uninstall
do not remove or replace these files. Do not copy identity state between
machines. Windows Defender Firewall may ask to allow Kepos to use the network;
allow the app on the networks where the logged-in session needs DHT
connectivity, or it will remain offline. Kepos does not open a public TCP
service port.

## Verify and run a download

Download all five assets from one GitHub release: the Android APK, macOS ZIP,
Windows ZIP, `SHA256SUMS`, and `SHA256SUMS.minisig`. Obtain
`release/minisign.pub` from the same Kepos source tag. In PowerShell, from the
download directory, verify the manifest before trusting its checksums:

```powershell
minisign.exe -Vm SHA256SUMS -x SHA256SUMS.minisig -p C:\path\to\minisign.pub
Get-FileHash .\kepos-windows-x64.zip -Algorithm SHA256
Get-Content .\SHA256SUMS
```

Confirm the displayed Windows ZIP digest exactly matches its line in
`SHA256SUMS`. Then extract into a fresh directory; do not extract over an old
Kepos folder:

```powershell
New-Item -ItemType Directory .\Kepos-vX.Y.Z
Expand-Archive .\kepos-windows-x64.zip -DestinationPath .\Kepos-vX.Y.Z
# portable launch:
.\Kepos-vX.Y.Z\Kepos\App\Kepos.exe
# or per-user installation:
.\Kepos-vX.Y.Z\Kepos\Install.cmd
```

If SmartScreen blocks a verified download, use the Windows **More info** and
**Run anyway** controls only after checking the release signature and digest.
The archive and executable are unsigned by Authenticode, so this warning is
expected and is not evidence that the ZIP is corrupt.

## Uninstall

Quit from the notification-area menu first. Run **Uninstall Kepos** from the
Start Menu or run `%LOCALAPPDATA%\Programs\Kepos\Uninstall.cmd`. The uninstaller
validates the exact per-user boundary and ownership marker, refuses while
Kepos is running, and then removes the owned program tree, Start Menu
shortcuts, and Desktop shortcut after the invoking scripts exit. It preserves
`%APPDATA%\Kepos`, `%LOCALAPPDATA%\Kepos\state`, diagnostics, and unrelated user
files. There is no purge option. A portable extraction has no installed tree;
quit the app and delete that extracted directory separately.

Closing the main window hides it; the notification-area icon and network roles
remain active. Choose **Open Kepos** to restore the window and **Quit Kepos**
from the tray menu (or the Settings panel) to stop publisher, subscriber,
WebView, tray, window, and runtime resources in order.

ARM64, Authenticode signing, MSI/MSIX, Microsoft Store delivery, automatic
updates, login startup, and Windows Service operation are not supported by this
release.
