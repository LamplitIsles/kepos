[CmdletBinding()]
param(
  [string]$LocalAppData,
  [string]$AppData,
  [string]$Desktop,
  [string]$StartMenu,
  [string]$InstallRoot,
  [string]$StagingRoot,
  [string]$TestRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:OwnerMarker = 'kepos-windows-per-user-install-v1'
$script:InstallerFiles = @('Install.cmd', 'install.ps1', 'Uninstall.cmd', 'uninstall.ps1')

function Get-FullPath {
  param([Parameter(Mandatory = $true)] [string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'path arguments must not be empty' }
  if (-not [System.IO.Path]::IsPathRooted($Path)) { throw "path must be absolute: $Path" }
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
  return $full
}

function Test-ContainedPath {
  param(
    [Parameter(Mandatory = $true)] [string]$Parent,
    [Parameter(Mandatory = $true)] [string]$Child,
    [switch]$AllowEqual
  )
  $parentPath = Get-FullPath $Parent
  $childPath = Get-FullPath $Child
  if ($AllowEqual -and $childPath.Equals($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = $parentPath.TrimEnd('\', '/') + '\'
  return $childPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-ContainedPath {
  param(
    [Parameter(Mandatory = $true)] [string]$Parent,
    [Parameter(Mandatory = $true)] [string]$Child,
    [Parameter(Mandatory = $true)] [string]$Name,
    [switch]$AllowEqual
  )
  if (-not (Test-ContainedPath $Parent $Child -AllowEqual:$AllowEqual)) { throw "$Name must remain inside $Parent" }
}

function Test-ReparsePoint {
  param([Parameter(Mandatory = $true)] [System.IO.FileSystemInfo]$Item)
  return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-NoReparseAncestors {
  param([Parameter(Mandatory = $true)] [string]$Path)
  $current = Get-FullPath $Path
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and (Test-ReparsePoint $item)) { throw "path contains a reparse point: $current" }
    $root = [System.IO.Path]::GetPathRoot($current).TrimEnd('\', '/')
    if ($current.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $next = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrWhiteSpace($next) -or $next.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $current = Get-FullPath $next
  }
}

function Assert-NoReparseTree {
  param(
    [Parameter(Mandatory = $true)] [string]$Root,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer) { throw "$Name must be a directory: $Root" }
  if (Test-ReparsePoint $rootItem) { throw "$Name contains a reparse point: $Root" }
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop)) {
    if (Test-ReparsePoint $item) { throw "$Name contains a reparse point: $($item.FullName)" }
  }
}

function Ensure-SafeDirectory {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  $canonical = Get-FullPath $Path
  Assert-NoReparseAncestors $canonical
  $existing = Get-Item -LiteralPath $canonical -Force -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    New-Item -ItemType Directory -Path $canonical -Force | Out-Null
  } elseif (-not $existing.PSIsContainer) {
    throw "$Name is not a directory: $canonical"
  }
  Assert-NoReparseTree $canonical $Name
  return $canonical
}

function Assert-RegularFile {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (Test-ReparsePoint $item)) { throw "$Name must be a regular file: $Path" }
  if ($item.Length -le 0) { throw "$Name must not be empty: $Path" }
  return $item
}

function Get-OptionalItem {
  param([Parameter(Mandatory = $true)] [string]$Path)
  return Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Get-DefaultLocalAppData {
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { return $env:LOCALAPPDATA }
  return [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
}

function Get-DefaultAppData {
  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) { return $env:APPDATA }
  return [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
}

function Get-DefaultDesktop {
  return [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
}

function Get-DefaultStartMenu {
  return Join-Path (Get-DefaultAppData) 'Microsoft\Windows\Start Menu\Programs'
}

function Get-OwnerMarkerContent {
  return "$($script:OwnerMarker)`r`n"
}

function Assert-OwnerMarker {
  param([Parameter(Mandatory = $true)] [string]$Root)
  $marker = Join-Path $Root '.kepos-owner'
  Assert-RegularFile $marker 'Kepos ownership marker' | Out-Null
  if ([System.IO.File]::ReadAllText($marker) -cne (Get-OwnerMarkerContent)) {
    throw "Kepos installation ownership marker is not exact: $marker"
  }
}

function Assert-InstalledLayout {
  param([Parameter(Mandatory = $true)] [string]$Root)
  $item = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (Test-ReparsePoint $item)) { throw "Kepos installation is not a real directory: $Root" }
  Assert-NoReparseTree $Root 'Kepos installation'
  Assert-OwnerMarker $Root
  $required = @(
    'App\Kepos.exe',
    'App\kepos-bootstrap.json',
    'App\self-contained-runtime.json',
    'App\Microsoft.WindowsAppRuntime.dll',
    'AppxManifest.xml',
    'Assets\Logo.ico'
  ) + $script:InstallerFiles
  foreach ($relative in $required) {
    Assert-RegularFile (Join-Path $Root $relative) "installed Kepos file $relative" | Out-Null
  }
}

function Get-ShortcutValues {
  param([Parameter(Mandatory = $true)] [string]$Path)
  $shell = $null
  $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $result = [pscustomobject]@{
      TargetPath = [string]$shortcut.TargetPath
      WorkingDirectory = [string]$shortcut.WorkingDirectory
      IconLocation = [string]$shortcut.IconLocation
      Arguments = [string]$shortcut.Arguments
    }
  } finally {
    if ($null -ne $shortcut) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null }
    if ($null -ne $shell) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
  }
  return $result
}

function Test-ExpectedShortcut {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [psobject]$Definition
  )
  $item = Get-OptionalItem $Path
  if ($null -eq $item) { return $false }
  if ($item.PSIsContainer -or (Test-ReparsePoint $item)) { throw "Kepos shortcut is a reparse point or directory: $Path" }
  try { $actual = Get-ShortcutValues $Path } catch { throw "existing Kepos shortcut cannot be inspected: $Path" }
  return (
    $actual.TargetPath.Equals($Definition.TargetPath, [System.StringComparison]::OrdinalIgnoreCase) -and
    $actual.WorkingDirectory.Equals($Definition.WorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase) -and
    $actual.IconLocation.Equals($Definition.IconLocation, [System.StringComparison]::OrdinalIgnoreCase) -and
    [string]::IsNullOrEmpty($actual.Arguments)
  )
}

function Get-ShortcutDefinitions {
  param(
    [Parameter(Mandatory = $true)] [string]$Root,
    [Parameter(Mandatory = $true)] [string]$StartMenuDirectory,
    [Parameter(Mandatory = $true)] [string]$DesktopDirectory
  )
  $exe = Join-Path $Root 'App\Kepos.exe'
  $app = Join-Path $Root 'App'
  $icon = "$exe,0"
  return @(
    [pscustomobject]@{
      Name = 'Start Menu app shortcut'
      Path = Join-Path $StartMenuDirectory 'Kepos.lnk'
      TargetPath = $exe
      WorkingDirectory = $app
      IconLocation = $icon
    },
    [pscustomobject]@{
      Name = 'Start Menu uninstall shortcut'
      Path = Join-Path $StartMenuDirectory 'Uninstall Kepos.lnk'
      TargetPath = Join-Path $Root 'Uninstall.cmd'
      WorkingDirectory = $Root
      IconLocation = $icon
    },
    [pscustomobject]@{
      Name = 'Desktop app shortcut'
      Path = Join-Path $DesktopDirectory 'Kepos.lnk'
      TargetPath = $exe
      WorkingDirectory = $app
      IconLocation = $icon
    }
  )
}

function Get-RunningKeposProcesses {
  try {
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Kepos.exe'" -ErrorAction Stop)
  } catch {
    throw "cannot inspect Kepos.exe processes; refusing to uninstall: $($_.Exception.Message)"
  }
}

function Assert-NoRunningKepos {
  param([Parameter(Mandatory = $true)] [string]$Install)
  foreach ($process in (Get-RunningKeposProcesses)) {
    $path = [string]$process.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($path)) {
      throw 'Kepos.exe is running but its executable path cannot be inspected; close it before uninstalling'
    }
    if (Test-ContainedPath $Install (Get-FullPath $path) -AllowEqual) {
      throw "Kepos.exe is running from $path; close Kepos before uninstalling"
    }
  }
}

function Get-UninstallParameters {
  if ([string]::IsNullOrWhiteSpace($script:LocalAppDataValue)) { $script:LocalAppDataValue = Get-DefaultLocalAppData }
  if ([string]::IsNullOrWhiteSpace($script:AppDataValue)) { $script:AppDataValue = Get-DefaultAppData }
  if ([string]::IsNullOrWhiteSpace($script:DesktopValue)) { $script:DesktopValue = Get-DefaultDesktop }
  if ([string]::IsNullOrWhiteSpace($script:StartMenuValue)) { $script:StartMenuValue = Get-DefaultStartMenu }
  $local = Get-FullPath $script:LocalAppDataValue
  $appData = Get-FullPath $script:AppDataValue
  $desktop = Get-FullPath $script:DesktopValue
  $startMenu = Get-FullPath $script:StartMenuValue
  $programs = Get-FullPath (Join-Path $local 'Programs')
  $expectedInstall = Get-FullPath (Join-Path $programs 'Kepos')
  if ([string]::IsNullOrWhiteSpace($script:InstallRootValue)) { $script:InstallRootValue = $expectedInstall }
  $install = Get-FullPath $script:InstallRootValue
  if (-not $install.Equals($expectedInstall, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallRoot must be the current user's Programs\Kepos directory: $expectedInstall"
  }
  if ([string]::IsNullOrWhiteSpace($script:StagingRootValue)) { $script:StagingRootValue = Join-Path $programs '.kepos-staging' }
  $staging = Get-FullPath $script:StagingRootValue
  Assert-ContainedPath $programs $staging 'staging root' -AllowEqual
  if (Test-ContainedPath $install $staging -AllowEqual) {
    throw "staging root must not be inside the installed Kepos directory: $staging"
  }
  if (-not [string]::IsNullOrWhiteSpace($TestRoot)) {
    $test = Get-FullPath $TestRoot
    foreach ($entry in @(
      @{ Name = 'LocalAppData'; Path = $local },
      @{ Name = 'AppData'; Path = $appData },
      @{ Name = 'Desktop'; Path = $desktop },
      @{ Name = 'StartMenu'; Path = $startMenu },
      @{ Name = 'staging root'; Path = $staging }
    )) {
      Assert-ContainedPath $test $entry.Path $entry.Name -AllowEqual
    }
  }
  Assert-NoReparseAncestors $local
  Assert-NoReparseAncestors $programs
  Assert-NoReparseAncestors $install
  Assert-NoReparseAncestors $staging
  return [pscustomobject]@{
    LocalAppData = $local
    AppData = $appData
    Desktop = $desktop
    StartMenu = $startMenu
    Programs = $programs
    Install = $install
    Staging = $staging
  }
}

function New-DeferredCleanupScript {
  param([Parameter(Mandatory = $true)] [string]$Path)
  $source = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$InstallRoot,
  [Parameter(Mandatory = $true)] [string]$ProgramsRoot,
  [Parameter(Mandatory = $true)] [string]$StartMenuShortcut,
  [Parameter(Mandatory = $true)] [string]$UninstallShortcut,
  [Parameter(Mandatory = $true)] [string]$DesktopShortcut,
  [Parameter(Mandatory = $true)] [string]$HelperPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$owner = 'kepos-windows-per-user-install-v1'
function Full([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value) -or -not [IO.Path]::IsPathRooted($value)) { throw 'deferred cleanup received an unsafe path' }
  $full = [IO.Path]::GetFullPath($value)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
  return $full
}
function Inside([string]$parent, [string]$child, [switch]$Equal) {
  $p = Full $parent; $c = Full $child
  if ($Equal -and $p.Equals($c, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $c.StartsWith($p.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Reparse([IO.FileSystemInfo]$item) { return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) }
function ShortcutMatches([string]$path, [string]$target, [string]$working, [string]$icon) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (Reparse $item)) { return $false }
  $shell = $null; $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($path)
    return (
      ([string]$shortcut.TargetPath).Equals($target, [StringComparison]::OrdinalIgnoreCase) -and
      ([string]$shortcut.WorkingDirectory).Equals($working, [StringComparison]::OrdinalIgnoreCase) -and
      ([string]$shortcut.IconLocation).Equals($icon, [StringComparison]::OrdinalIgnoreCase) -and
      [string]::IsNullOrEmpty([string]$shortcut.Arguments)
    )
  } finally {
    if ($null -ne $shortcut) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null }
    if ($null -ne $shell) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
  }
}
function NoRunning([string]$root) {
  try { $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Kepos.exe'" -ErrorAction Stop) } catch { throw 'could not inspect Kepos.exe during deferred uninstall' }
  foreach ($process in $processes) {
    $path = [string]$process.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($path)) { throw 'Kepos.exe path was not inspectable during deferred uninstall' }
    if (Inside $root (Full $path) -Equal) { throw 'Kepos.exe is still running during deferred uninstall' }
  }
}
$install = Full $InstallRoot
$programs = Full $ProgramsRoot
if (-not (Inside $programs $install)) { throw 'deferred cleanup install path escaped Programs' }
if (-not (Inside $programs (Full $HelperPath))) { throw 'deferred cleanup helper path escaped Programs' }
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    NoRunning $install
    $item = Get-Item -LiteralPath $install -Force -ErrorAction Stop
    if ($item.PSIsContainer -eq $false -or (Reparse $item)) { throw 'installed Kepos path changed before deferred cleanup' }
    $marker = [IO.File]::ReadAllText((Join-Path $install '.kepos-owner'))
    if ($marker -cne "$owner`r`n") { throw 'installed Kepos ownership marker changed before deferred cleanup' }
    $exe = Join-Path $install 'App\Kepos.exe'
    $app = Join-Path $install 'App'
    $icon = "$exe,0"
    foreach ($shortcut in @(
      @{ Path = $StartMenuShortcut; Target = $exe; Working = $app },
      @{ Path = $UninstallShortcut; Target = (Join-Path $install 'Uninstall.cmd'); Working = $install },
      @{ Path = $DesktopShortcut; Target = $exe; Working = $app }
    )) {
      $existing = Get-Item -LiteralPath $shortcut.Path -Force -ErrorAction SilentlyContinue
      if ($null -ne $existing -and -not (ShortcutMatches $shortcut.Path $shortcut.Target $shortcut.Working $icon)) {
        throw "refusing to remove an unowned shortcut: $($shortcut.Path)"
      }
    }
    foreach ($shortcut in @($StartMenuShortcut, $UninstallShortcut, $DesktopShortcut)) {
      $existing = Get-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
      if ($null -ne $existing) { Remove-Item -LiteralPath $shortcut -Force }
    }
    Remove-Item -LiteralPath $install -Recurse -Force
    Remove-Item -LiteralPath $HelperPath -Force -ErrorAction SilentlyContinue
    exit 0
  } catch {
    if ($attempt -eq 59) { throw }
    Start-Sleep -Milliseconds 500
  }
}
'@
  [System.IO.File]::WriteAllText($Path, $source, [System.Text.Encoding]::ASCII)
}

$script:LocalAppDataValue = $LocalAppData
$script:AppDataValue = $AppData
$script:DesktopValue = $Desktop
$script:StartMenuValue = $StartMenu
$script:InstallRootValue = $InstallRoot
$script:StagingRootValue = $StagingRoot

try {
  $parameters = Get-UninstallParameters
  $installItem = Get-OptionalItem $parameters.Install
  if ($null -eq $installItem) {
    throw "owned Kepos installation was not found: $($parameters.Install)"
  }
  Assert-InstalledLayout $parameters.Install
  Assert-NoRunningKepos $parameters.Install

  $definitions = @(Get-ShortcutDefinitions $parameters.Install $parameters.StartMenu $parameters.Desktop)
  foreach ($definition in $definitions) {
    Assert-NoReparseAncestors (Split-Path -Parent $definition.Path)
    $existing = Get-OptionalItem $definition.Path
    if ($null -ne $existing -and -not (Test-ExpectedShortcut $definition.Path $definition)) {
      throw "$($definition.Name) exists but is not an owned Kepos shortcut: $($definition.Path)"
    }
  }

  Ensure-SafeDirectory $parameters.Staging 'installer staging directory' | Out-Null
  $helper = Join-Path $parameters.Staging ('.kepos-uninstall-' + [Guid]::NewGuid().ToString('N') + '.ps1')
  Assert-ContainedPath $parameters.Programs $helper 'deferred uninstall helper'
  New-DeferredCleanupScript $helper
  $powershell = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { $powershell = 'powershell.exe' }
  $argumentList = @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$helper`"",
    '-InstallRoot', "`"$($parameters.Install)`"",
    '-ProgramsRoot', "`"$($parameters.Programs)`"",
    '-StartMenuShortcut', "`"$(Join-Path $parameters.StartMenu 'Kepos.lnk')`"",
    '-UninstallShortcut', "`"$(Join-Path $parameters.StartMenu 'Uninstall Kepos.lnk')`"",
    '-DesktopShortcut', "`"$(Join-Path $parameters.Desktop 'Kepos.lnk')`"",
    '-HelperPath', "`"$helper`""
  ) -join ' '
  $deferred = Start-Process -FilePath $powershell -ArgumentList $argumentList -WindowStyle Hidden -PassThru
  if ($null -eq $deferred) { throw 'could not start deferred uninstall cleanup' }
  Write-Host 'Kepos uninstall scheduled; the owned program tree and shortcuts will be removed after this script exits.'
  Write-Host 'Configuration, identity, diagnostics, and other mutable user data are not removed.'
} catch {
  Write-Error $_.Exception.Message
  exit 1
}

exit 0
