[CmdletBinding()]
param(
  [string]$SourceRoot,
  [string]$LocalAppData,
  [string]$AppData,
  [string]$Desktop,
  [string]$StartMenu,
  [string]$InstallRoot,
  [string]$StagingRoot,
  [string]$TestRoot,
  [switch]$NoDesktopShortcut
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
  if ($AllowEqual -and $childPath.Equals($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
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
  if (-not (Test-ContainedPath $Parent $Child -AllowEqual:$AllowEqual)) {
    throw "$Name must remain inside $Parent"
  }
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
    if ($null -ne $item -and (Test-ReparsePoint $item)) {
      throw "path contains a reparse point: $current"
    }
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

function Write-OwnerMarker {
  param([Parameter(Mandatory = $true)] [string]$Root)
  $marker = Join-Path $Root '.kepos-owner'
  [System.IO.File]::WriteAllText($marker, (Get-OwnerMarkerContent), [System.Text.Encoding]::ASCII)
}

function Assert-OwnerMarker {
  param([Parameter(Mandatory = $true)] [string]$Root)
  $marker = Join-Path $Root '.kepos-owner'
  Assert-RegularFile $marker 'Kepos ownership marker' | Out-Null
  $content = [System.IO.File]::ReadAllText($marker)
  if ($content -cne (Get-OwnerMarkerContent)) {
    throw "Kepos installation ownership marker is not exact: $marker"
  }
}

function Assert-PayloadLayout {
  param(
    [Parameter(Mandatory = $true)] [string]$Root,
    [switch]$RequireOwnerMarker
  )
  $canonical = Get-FullPath $Root
  $rootItem = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or (Test-ReparsePoint $rootItem)) {
    throw "Kepos payload root must be a real directory: $canonical"
  }
  Assert-NoReparseTree $canonical 'Kepos payload'
  if ($RequireOwnerMarker) {
    Assert-OwnerMarker $canonical
  } else {
    $marker = Get-OptionalItem (Join-Path $canonical '.kepos-owner')
    if ($null -ne $marker) { Assert-OwnerMarker $canonical }
  }

  $required = @(
    'App\Kepos.exe',
    'App\kepos-bootstrap.json',
    'App\self-contained-runtime.json',
    'App\Microsoft.WindowsAppRuntime.dll',
    'AppxManifest.xml',
    'Assets\Logo.ico'
  ) + $script:InstallerFiles
  foreach ($relative in $required) {
    Assert-RegularFile (Join-Path $canonical $relative) "Kepos payload file $relative" | Out-Null
  }
}

function Copy-Payload {
  param(
    [Parameter(Mandatory = $true)] [string]$Source,
    [Parameter(Mandatory = $true)] [string]$Destination
  )
  Assert-PayloadLayout $Source
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force -Recurse | Sort-Object FullName)) {
    $relative = $item.FullName.Substring((Get-FullPath $Source).Length).TrimStart('\', '/')
    $target = Join-Path $Destination $relative
    if (Test-ReparsePoint $item) { throw "Kepos payload contains a reparse point: $($item.FullName)" }
    if ($item.PSIsContainer) {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
    } else {
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath $item.FullName -Destination $target -Force
    }
  }
  Assert-NoReparseTree $Destination 'staged Kepos payload'
}

function Get-ShortcutValues {
  param([Parameter(Mandatory = $true)] [string]$Path)
  $shell = $null
  $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    return [pscustomobject]@{
      TargetPath = [string]$shortcut.TargetPath
      WorkingDirectory = [string]$shortcut.WorkingDirectory
      IconLocation = [string]$shortcut.IconLocation
      Arguments = [string]$shortcut.Arguments
      Description = [string]$shortcut.Description
    }
  } finally {
    if ($null -ne $shortcut) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null }
    if ($null -ne $shell) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
  }
}

function Test-ExpectedShortcut {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [psobject]$Definition
  )
  $item = Get-OptionalItem $Path
  if ($null -eq $item) { return $false }
  if ($item.PSIsContainer -or (Test-ReparsePoint $item)) {
    throw "Kepos shortcut is a reparse point or directory: $Path"
  }
  try {
    $actual = Get-ShortcutValues $Path
  } catch {
    throw "existing Kepos shortcut cannot be inspected: $Path"
  }
  return (
    $actual.TargetPath.Equals($Definition.TargetPath, [System.StringComparison]::OrdinalIgnoreCase) -and
    $actual.WorkingDirectory.Equals($Definition.WorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase) -and
    $actual.IconLocation.Equals($Definition.IconLocation, [System.StringComparison]::OrdinalIgnoreCase) -and
    [string]::IsNullOrEmpty($actual.Arguments)
  )
}

function New-KeposShortcut {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [psobject]$Definition
  )
  $shell = $null
  $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Definition.TargetPath
    $shortcut.WorkingDirectory = $Definition.WorkingDirectory
    $shortcut.IconLocation = $Definition.IconLocation
    $shortcut.Arguments = ''
    $shortcut.Description = $Definition.Description
    $shortcut.Save()
  } finally {
    if ($null -ne $shortcut) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null }
    if ($null -ne $shell) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
  }
  if (-not (Test-ExpectedShortcut $Path $Definition)) {
    throw "created Kepos shortcut did not validate: $Path"
  }
}

function Get-ShortcutDefinitions {
  param(
    [Parameter(Mandatory = $true)] [string]$Root,
    [Parameter(Mandatory = $true)] [string]$StartMenuDirectory,
    [Parameter(Mandatory = $true)] [string]$DesktopDirectory,
    [Parameter(Mandatory = $true)] [bool]$IncludeDesktop
  )
  $exe = Join-Path $Root 'App\Kepos.exe'
  $app = Join-Path $Root 'App'
  $icon = "$exe,0"
  $definitions = @(
    [pscustomobject]@{
      Name = 'Start Menu app shortcut'
      Path = Join-Path $StartMenuDirectory 'Kepos.lnk'
      TargetPath = $exe
      WorkingDirectory = $app
      IconLocation = $icon
      Description = 'Kepos'
    },
    [pscustomobject]@{
      Name = 'Start Menu uninstall shortcut'
      Path = Join-Path $StartMenuDirectory 'Uninstall Kepos.lnk'
      TargetPath = Join-Path $Root 'Uninstall.cmd'
      WorkingDirectory = $Root
      IconLocation = $icon
      Description = 'Uninstall Kepos'
    }
  )
  if ($IncludeDesktop) {
    $definitions += [pscustomobject]@{
      Name = 'Desktop app shortcut'
      Path = Join-Path $DesktopDirectory 'Kepos.lnk'
      TargetPath = $exe
      WorkingDirectory = $app
      IconLocation = $icon
      Description = 'Kepos'
    }
  }
  return $definitions
}

function Assert-ShortcutLocations {
  param([Parameter(Mandatory = $true)] [psobject[]]$Definitions)
  foreach ($definition in $Definitions) {
    Assert-NoReparseAncestors (Split-Path -Parent $definition.Path)
    $existing = Get-OptionalItem $definition.Path
    if ($null -ne $existing -and $existing.PSIsContainer) {
      throw "$($definition.Name) is a directory: $($definition.Path)"
    }
    if ($null -ne $existing -and -not (Test-ExpectedShortcut $definition.Path $definition)) {
      throw "$($definition.Name) exists but is not an owned Kepos shortcut: $($definition.Path)"
    }
  }
}

function Remove-GeneratedItem {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [string]$Parent,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  Assert-ContainedPath $Parent $Path $Name
  $item = Get-OptionalItem $Path
  if ($null -eq $item) { return }
  if (Test-ReparsePoint $item) { throw "$Name became a reparse point: $Path" }
  if ($item.PSIsContainer) {
    Assert-NoReparseTree $Path $Name
    Remove-Item -LiteralPath $Path -Recurse -Force
  } else {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Get-RunningKeposProcesses {
  try {
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Kepos.exe'" -ErrorAction Stop)
  } catch {
    throw "cannot inspect Kepos.exe processes; refusing to mutate an installation: $($_.Exception.Message)"
  }
}

function Assert-NoRunningKepos {
  param(
    [Parameter(Mandatory = $true)] [string[]]$Roots
  )
  foreach ($process in (Get-RunningKeposProcesses)) {
    $path = [string]$process.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($path)) {
      throw "Kepos.exe is running but its executable path cannot be inspected; close it before continuing"
    }
    $canonical = Get-FullPath $path
    foreach ($root in $Roots) {
      if (Test-ContainedPath $root $canonical -AllowEqual) {
        throw "Kepos.exe is running from $canonical; close Kepos before installing or repairing it"
      }
    }
  }
}

function Get-InstallParameters {
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
  if ([string]::IsNullOrWhiteSpace($script:InstallRootValue)) {
    $script:InstallRootValue = $expectedInstall
  }
  $install = Get-FullPath $script:InstallRootValue
  if (-not $install.Equals($expectedInstall, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallRoot must be the current user's Programs\Kepos directory: $expectedInstall"
  }
  if ([string]::IsNullOrWhiteSpace($script:StagingRootValue)) {
    $script:StagingRootValue = Join-Path $programs '.kepos-staging'
  }
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

$script:LocalAppDataValue = $LocalAppData
$script:AppDataValue = $AppData
$script:DesktopValue = $Desktop
$script:StartMenuValue = $StartMenu
$script:InstallRootValue = $InstallRoot
$script:StagingRootValue = $StagingRoot

try {
  if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = $PSScriptRoot }
  $source = Get-FullPath $SourceRoot
  $parameters = Get-InstallParameters
  $sourceItem = Get-Item -LiteralPath $source -Force -ErrorAction Stop
  if (-not $sourceItem.PSIsContainer -or (Test-ReparsePoint $sourceItem)) {
    throw "source is not a real extracted Kepos directory: $source"
  }
  Assert-PayloadLayout $source
  Assert-NoRunningKepos @($source, $parameters.Install)

  $existingInstallItem = Get-OptionalItem $parameters.Install
  $hadPreviousInstall = $null -ne $existingInstallItem
  if ($hadPreviousInstall) {
    if (-not $existingInstallItem.PSIsContainer -or (Test-ReparsePoint $existingInstallItem)) {
      throw "existing Kepos destination is not a replaceable real directory: $($parameters.Install)"
    }
    Assert-PayloadLayout $parameters.Install -RequireOwnerMarker
  }

  $includeDesktop = -not $NoDesktopShortcut
  $definitions = @(Get-ShortcutDefinitions $parameters.Install $parameters.StartMenu $parameters.Desktop $includeDesktop)
  $desktopDefinition = @(
    Get-ShortcutDefinitions $parameters.Install $parameters.StartMenu $parameters.Desktop $true |
      Where-Object { $_.Name -eq 'Desktop app shortcut' }
  )[0]
  $managedDefinitions = @($definitions)
  if (-not $includeDesktop) { $managedDefinitions += $desktopDefinition }
  Assert-ShortcutLocations $managedDefinitions

  Ensure-SafeDirectory $parameters.Programs 'per-user Programs directory' | Out-Null
  Ensure-SafeDirectory $parameters.Staging 'installer staging directory' | Out-Null

  $operationId = [Guid]::NewGuid().ToString('N')
  $stage = Join-Path $parameters.Staging ".payload-$operationId"
  $previous = Join-Path $parameters.Programs ".kepos-previous-$operationId"
  $temporaryShortcuts = @{}
  $shortcutBackups = @{}
  $movedNewShortcuts = @()
  $treeMoved = $false
  $treeInstalled = $false
  $success = $false

  try {
    Copy-Payload $source $stage
    Write-OwnerMarker $stage
    Assert-PayloadLayout $stage -RequireOwnerMarker

    foreach ($definition in $definitions) {
      $parent = Split-Path -Parent $definition.Path
      Ensure-SafeDirectory $parent "$($definition.Name) directory" | Out-Null
      $temporary = "$($definition.Path).$operationId.stage.lnk"
      $temporaryShortcuts[$definition.Path] = $temporary
      New-KeposShortcut $temporary $definition
    }

    if ($NoDesktopShortcut) {
      $desktopExisting = Get-OptionalItem $desktopDefinition.Path
      if ($null -ne $desktopExisting) {
        $desktopBackup = "$($desktopDefinition.Path).$operationId.backup.lnk"
        Move-Item -LiteralPath $desktopDefinition.Path -Destination $desktopBackup -Force
        $shortcutBackups[$desktopDefinition.Path] = $desktopBackup
      }
    }

    if ($hadPreviousInstall) {
      Move-Item -LiteralPath $parameters.Install -Destination $previous -Force
      $treeMoved = $true
    }
    Move-Item -LiteralPath $stage -Destination $parameters.Install -Force
    $treeInstalled = $true
    Assert-PayloadLayout $parameters.Install -RequireOwnerMarker

    foreach ($definition in $definitions) {
      $existing = Get-OptionalItem $definition.Path
      if ($null -ne $existing) {
        $backup = "$($definition.Path).$operationId.backup.lnk"
        Move-Item -LiteralPath $definition.Path -Destination $backup -Force
        $shortcutBackups[$definition.Path] = $backup
      }
      Move-Item -LiteralPath $temporaryShortcuts[$definition.Path] -Destination $definition.Path -Force
      $movedNewShortcuts += $definition.Path
      if (-not (Test-ExpectedShortcut $definition.Path $definition)) {
        throw "$($definition.Name) failed validation after replacement"
      }
    }

    if ($hadPreviousInstall) {
      Remove-GeneratedItem $previous $parameters.Programs 'previous owned Kepos installation'
    }
    foreach ($backup in $shortcutBackups.Values) {
      Remove-GeneratedItem $backup (Split-Path -Parent $backup) 'previous owned shortcut backup'
    }
    $success = $true
    Write-Host "Kepos installed for the current user at $($parameters.Install)"
    if ($NoDesktopShortcut) {
      Write-Host 'Desktop shortcut: omitted (only an owned Kepos shortcut was removed)'
    } else {
      Write-Host 'Desktop shortcut: created'
    }
    Write-Host "Start Menu shortcuts: $($parameters.StartMenu)"
  } catch {
    $failure = $_.Exception.Message
    try {
      foreach ($path in @($movedNewShortcuts)) {
        Remove-GeneratedItem $path (Split-Path -Parent $path) 'failed replacement shortcut'
      }
      foreach ($path in $shortcutBackups.Keys) {
        $backup = $shortcutBackups[$path]
        if ((Get-OptionalItem $backup) -ne $null -and (Get-OptionalItem $path) -eq $null) {
          Move-Item -LiteralPath $backup -Destination $path -Force
        }
      }
      if ($treeInstalled) {
        Remove-GeneratedItem $parameters.Install $parameters.Programs 'failed replacement installation'
      }
      if ($treeMoved -and (Get-OptionalItem $previous) -ne $null -and (Get-OptionalItem $parameters.Install) -eq $null) {
        Move-Item -LiteralPath $previous -Destination $parameters.Install -Force
      }
      foreach ($temporary in $temporaryShortcuts.Values) {
        Remove-GeneratedItem $temporary (Split-Path -Parent $temporary) 'temporary shortcut'
      }
      Remove-GeneratedItem $stage $parameters.Staging 'staged Kepos payload'
      Remove-GeneratedItem $previous $parameters.Programs 'previous Kepos rollback tree'
      foreach ($backup in $shortcutBackups.Values) {
        Remove-GeneratedItem $backup (Split-Path -Parent $backup) 'shortcut rollback backup'
      }
    } catch {
      throw "Kepos installation failed and rollback was incomplete: $failure; rollback: $($_.Exception.Message)"
    }
    throw "Kepos installation failed; the previous installation was preserved: $failure"
  } finally {
    if (-not $success) {
      try { Remove-GeneratedItem $stage $parameters.Staging 'staged Kepos payload' } catch { }
    }
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}

exit 0
