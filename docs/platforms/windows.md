# Windows desktop

Kepos supports **Windows 11 x64** as a portable desktop application. Download
`kepos-windows-x64.zip`, verify it, extract it to a new directory, and
launch `Kepos\App\Kepos.exe`. The ZIP includes the x64 self-contained Windows
App Runtime tree, so Microsoft Windows App Runtime does not need to be
installed separately. The app is a whole-directory product: keep every file
under `Kepos\` together and do not move or distribute `Kepos.exe` alone.

The WebView2 Runtime and Microsoft Visual C++ Redistributable remain system
prerequisites; Kepos does not bundle either one. The ZIP is unsigned by
Authenticode: Windows SmartScreen may warn because the first release has no
Microsoft publisher identity. Do not bypass a warning until the minisign and
SHA-256 checks below succeed.

The ZIP is portable and does not install a service, login startup task, MSI,
MSIX package, Store app, or updater. Kepos runs only in the logged-in desktop
session. Closing the main window hides it; the notification-area icon and
network roles remain active. Choose **Open Kepos** to restore the window and
**Quit Kepos** from the tray menu (or the Settings panel) to stop publisher,
subscriber, WebView, tray, window, and runtime resources in order.

## Data and firewall

Windows configuration is stored under `%APPDATA%\Kepos\config.toml` and role
state under `%LOCALAPPDATA%\Kepos\state\{publisher,subscriber}`. Use
`--config` for a deliberate alternate configuration; do not copy identity
state between machines. Windows Defender Firewall may ask to allow Kepos to
use the network. Allow the app on the networks where the logged-in session
needs DHT connectivity, or it will remain offline; Kepos does not open a public
TCP service port.

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
.\Kepos-vX.Y.Z\Kepos\App\Kepos.exe
```

If SmartScreen blocks a verified download, use the Windows **More info** and
**Run anyway** controls only after checking the release signature and digest.
The archive is unsigned; this warning is expected and is not evidence that the
ZIP is corrupt.

## Remove

Quit from the notification-area menu first. Close the extracted directory and
delete it. Portable removal does not uninstall a Windows registration, but it
also does not delete `%APPDATA%\Kepos` or `%LOCALAPPDATA%\Kepos\state`; remove
those directories separately only when intentionally deleting the device's
configuration and identities.

Windows 10, ARM64, Authenticode, MSI/MSIX, Microsoft Store delivery, automatic
updates, login startup, and Windows Service operation are not supported by this
release.
