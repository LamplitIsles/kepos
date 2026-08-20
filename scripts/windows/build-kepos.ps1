[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$Repository,
  [Parameter(Mandatory = $true)] [string]$RunDirectory,
  [Parameter(Mandatory = $true)] [string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)] [string]$ToolsDirectory,
  [Parameter(Mandatory = $true)] [ValidatePattern('^[0-9TZ-]+$')] [string]$RunId,
  [Parameter(Mandatory = $true)] [string]$RootRevision,
  [Parameter(Mandatory = $true)] [string]$BareNativeRevision,
  [Parameter(Mandatory = $true)] [string]$BareWinUiRevision,
  [Parameter(Mandatory = $true)] [string]$BareAppKitRevision,
  [string]$BootstrapAsset,
  [switch]$RequireBootstrap,
  [ValidateSet('dogfood', 'release')] [string]$Workflow = 'dogfood',
  [string]$ReleaseTag,
  [ValidateSet('release', 'rehearsal')] [string]$ReleaseMode,
  [string]$RemoteOrigin,
  [string]$ReleaseArtifactName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CanonicalPath {
  param([Parameter(Mandatory = $true)] [string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Path arguments must not be empty' }
  if (-not [System.IO.Path]::IsPathRooted($Path)) { throw "Path must be absolute: $Path" }
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-OwnedPath {
  param(
    [Parameter(Mandatory = $true)] [string]$Parent,
    [Parameter(Mandatory = $true)] [string]$Child,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  $parentForComparison = $Parent.Replace('/', '\').TrimEnd('\')
  $childForComparison = $Child.Replace('/', '\').TrimEnd('\')
  $prefix = "$parentForComparison\"
  if (
    $childForComparison -eq $parentForComparison -or
    -not $childForComparison.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "$Name must be inside $Parent"
  }
}

function Assert-SafeOwnedPath {
  param(
    [Parameter(Mandatory = $true)] [string]$Parent,
    [Parameter(Mandatory = $true)] [string]$Child,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  Assert-OwnedPath $Parent $Child $Name
  $parentPath = Get-CanonicalPath $Parent
  $currentPath = Get-CanonicalPath $Child
  while ($true) {
    $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "$Name contains an existing reparse point: $currentPath"
    }
    if ($currentPath.Equals($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $nextPath = [System.IO.Path]::GetDirectoryName($currentPath)
    if ([string]::IsNullOrWhiteSpace($nextPath) -or $nextPath -eq $currentPath) {
      throw "Unable to inspect containment path for $Name"
    }
    $currentPath = Get-CanonicalPath $nextPath
  }
}

function Assert-NoReparsePointsInTree {
  param(
    [Parameter(Mandatory = $true)] [string]$Root,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Name contains an existing reparse point: $Root"
  }
  $link = Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop |
    Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 } |
    Select-Object -First 1
  if ($null -ne $link) { throw "$Name contains an existing reparse point: $($link.FullName)" }
}

function Remove-SafeOwnedTree {
  param(
    [Parameter(Mandatory = $true)] [string]$Parent,
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  Assert-SafeOwnedPath $Parent $Path $Name
  if (Test-Path -LiteralPath $Path) {
    Assert-NoReparsePointsInTree $Path $Name
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Get-ContainedReleaseArtifactPath {
  param(
    [Parameter(Mandatory = $true)] [string]$RunDirectory,
    [Parameter(Mandatory = $true)] [string]$ArtifactName
  )
  if ($ArtifactName -ne 'kepos-windows-x64.zip') {
    throw "invalid Windows artifact name: $ArtifactName"
  }
  $artifact = Join-Path $RunDirectory $ArtifactName
  Assert-SafeOwnedPath $RunDirectory $artifact 'release artifact'
  return $artifact
}

function Assert-BootstrapInput {
  param(
    [Parameter(Mandatory = $true)] [string]$RunDirectory,
    [string]$Path,
    [Parameter(Mandatory = $true)] [bool]$Required
  )
  if ([string]::IsNullOrWhiteSpace($Path)) {
    if ($Required) { throw 'required Windows bootstrap input is missing' }
    return $null
  }
  $canonical = Get-CanonicalPath $Path
  Assert-SafeOwnedPath $RunDirectory $canonical 'bootstrap input'
  if ([System.IO.Path]::GetFileName($canonical) -ne 'kepos-bootstrap.json') {
    throw 'bootstrap input must use the fixed kepos-bootstrap.json name'
  }
  $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
    return $canonical
  }
  throw 'bootstrap input must be a regular file'
}

function Get-SubstTarget {
  $lines = @(& subst.exe 2>&1)
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "Unable to inspect substituted drives; exit code $code" }
  foreach ($line in $lines) {
    $text = [string]$line
    if ($text -match '^\s*([A-Za-z]):\\.*=>\s*(.+?)\s*$' -and $matches[1].ToUpperInvariant() -eq 'K') {
      return $matches[2].Trim()
    }
  }
  return $null
}

function Remove-OwnedSubst {
  param([Parameter(Mandatory = $true)] [string]$Repository)
  $mapped = Get-SubstTarget
  if ($null -eq $mapped) {
    Write-Host 'K: mapping is already absent'
    return
  }
  if ((Get-CanonicalPath $mapped) -ne (Get-CanonicalPath $Repository)) {
    throw "Refusing to remove changed K: mapping; it now targets $mapped"
  }
  $output = @(& subst.exe K: /d 2>&1)
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    $details = ($output -join ' ').Trim()
    if ([string]::IsNullOrWhiteSpace($details)) {
      throw "Failed to remove K: mapping with exit code $code"
    }
    throw "Failed to remove K: mapping with exit code ${code}: $details"
  }
  Write-Host 'Removed temporary K: mapping'
}

function Test-OwnedRunDirectory {
  param([Parameter(Mandatory = $true)] [System.IO.DirectoryInfo]$Directory)
  if (($Directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $marker = Join-Path $Directory.FullName '.kepos-windows-workflow-run'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
  try {
    return ((Get-Content -LiteralPath $marker -Raw).Trim() -eq "kepos-windows-workflow-run:$($Directory.Name)")
  } catch {
    return $false
  }
}

function Get-PortableRelativePath {
  param(
    [Parameter(Mandatory = $true)] [string]$Root,
    [Parameter(Mandatory = $true)] [System.IO.FileSystemInfo]$File
  )
  $prefix = (Get-CanonicalPath $Root) + '\'
  return $File.FullName.Substring($prefix.Length).Replace('/', '\')
}

function Assert-Pe64 {
  param([Parameter(Mandatory = $true)] [string]$Executable)
  $bytes = [System.IO.File]::ReadAllBytes($Executable)
  if ($bytes.Length -lt 64) { throw "Windows executable is truncated: $Executable" }
  $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3c)
  if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length) { throw "Windows executable has an invalid PE header: $Executable" }
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
    throw "Windows executable is not a PE image: $Executable"
  }
  $machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
  if ($machine -ne 0x8664) { throw "Windows executable must be x64; machine was 0x$('{0:x4}' -f $machine)" }
}

function Get-ExecutableDependencies {
  param([Parameter(Mandatory = $true)] [string]$Executable)
  $dumpbin = Get-Command dumpbin.exe -CommandType Application -ErrorAction Stop
  $output = @(& $dumpbin.Path /DEPENDENTS $Executable 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect executable imports: $Executable"
  }
  return ($output -join "`n")
}

function Assert-SelfContainedImports {
  param([Parameter(Mandatory = $true)] [string]$Executable)
  $dependencies = Get-ExecutableDependencies $Executable
  if ($dependencies -notmatch '(?im)^\s*Microsoft\.WindowsAppRuntime\.dll\s*$') {
    throw "Executable does not import Microsoft.WindowsAppRuntime.dll: $Executable"
  }
  if ($dependencies -match '(?im)Microsoft\.WindowsAppRuntime\.Bootstrap\.dll') {
    throw "Executable imports the Bootstrap DLL: $Executable"
  }
  $runtime = Join-Path (Split-Path -Parent $Executable) 'Microsoft.WindowsAppRuntime.dll'
  if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) {
    throw "Executable import is not backed by a local Windows App Runtime DLL: $runtime"
  }
}

function Get-PortableFileSet {
  param([Parameter(Mandatory = $true)] [string]$PackageRoot)
  $items = @(Get-ChildItem -LiteralPath $PackageRoot -Force -Recurse)
  if ($items.Count -eq 0) { throw "Windows portable app has no files: $PackageRoot" }

  # The adapter manifest owns the runtime payload inventory. This function
  # checks only the outer whole-directory product shape; final payload
  # semantics are delegated to scripts/windows/self-contained-runtime.ts.
  $relative = @($items | ForEach-Object {
      if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Windows portable app contains a link: $($_.FullName)"
      }
      Get-PortableRelativePath $PackageRoot $_
    } | Sort-Object)
  foreach ($name in $relative) {
    if (
      $name -ne 'App' -and
      $name -ne 'Assets' -and
      $name -ne 'AppxManifest.xml' -and
      $name -ne 'Assets\Logo.ico' -and
      -not $name.StartsWith('App\')
    ) {
      throw "Windows portable app contains an unexpected outer entry: $name"
    }
  }
  foreach ($name in @(
    'AppxManifest.xml',
    'Assets\Logo.ico',
    'App\Kepos.exe',
    'App\kepos-bootstrap.json',
    'App\app.bundle',
    'App\Microsoft.Web.WebView2.Core.dll',
    'App\self-contained-runtime.json',
    'App\Microsoft.WindowsAppRuntime.dll'
  )) {
    if (-not $relative.Contains($name)) { throw "Windows portable app is missing $name" }
  }
  if (-not ($relative | Where-Object { $_ -match '^App\\bare-win-ui-[^\\]+\.dll$' })) {
    throw 'Windows portable app is missing the bare-win-ui runtime'
  }
  Assert-Pe64 (Join-Path $PackageRoot 'App\Kepos.exe')
  return $relative
}

function Invoke-PortableSmoke {
  param(
    [Parameter(Mandatory = $true)] [string]$Executable,
    [Parameter(Mandatory = $true)] [string]$SmokeRoot,
    [Parameter(Mandatory = $true)] [string]$Logs,
    [string]$BootstrapAsset,
    [string]$Node
  )
  $smokeHome = Join-Path $SmokeRoot 'home'
  $appData = Join-Path $SmokeRoot 'AppData\Roaming'
  $localAppData = Join-Path $SmokeRoot 'AppData\Local'
  $webViewData = Join-Path $SmokeRoot 'WebView2'
  $ready = Join-Path $SmokeRoot 'ready.marker'
  $rendered = Join-Path $SmokeRoot 'rendered.marker'
  $quit = Join-Path $SmokeRoot 'quit.marker'
  # These roots intentionally begin empty. The app must create the subscriber
  # identity/configuration through its real bootstrap path before it can render
  # the unconfigured snapshot. The second launch proves that identity survives
  # a clean quit and restart without importing live state.
  New-Item -ItemType Directory -Path $smokeHome, $appData, $localAppData, $webViewData, $Logs -Force | Out-Null
  $env:APPDATA = $appData
  $env:LOCALAPPDATA = $localAppData
  $env:WEBVIEW2_USER_DATA_FOLDER = $webViewData
  $env:KEPOS_WINDOWS_SMOKE_READY_FILE = $ready
  $env:KEPOS_WINDOWS_SMOKE_RENDER_FILE = $rendered
  $env:KEPOS_WINDOWS_SMOKE_QUIT_FILE = $quit
  $firstSubscriberKey = $null
  try {
    foreach ($marker in @($ready, $rendered, $quit)) {
      $existing = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
      if ($null -ne $existing) {
        if ($existing.PSIsContainer -or (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
          throw "Windows portable smoke marker is not a regular file: $marker"
        }
        Remove-Item -LiteralPath $marker -Force
      }
    }

    for ($attempt = 1; $attempt -le 2; $attempt++) {
      if ($attempt -gt 1) {
        foreach ($marker in @($ready, $rendered, $quit)) {
          $existing = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
          if ($null -ne $existing) {
            if ($existing.PSIsContainer -or (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
              throw "Windows portable smoke marker is not a regular file: $marker"
            }
            Remove-Item -LiteralPath $marker -Force
          }
        }
      }

      $process = New-Object System.Diagnostics.Process
      $process.StartInfo.FileName = $Executable
      $process.StartInfo.Arguments = "--smoke-test --smoke-home `"$smokeHome`""
      $process.StartInfo.WorkingDirectory = Split-Path -Parent $Executable
      $process.StartInfo.UseShellExecute = $false
      $process.StartInfo.RedirectStandardOutput = $false
      $process.StartInfo.RedirectStandardError = $false
      $processStarted = $false
      try {
        if (-not $process.Start()) { throw 'Windows portable smoke process did not start' }
        $processStarted = $true
        if (-not $process.WaitForExit(45000)) {
          & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-File (Join-Path $Logs "smoke-timeout-$attempt.log")
          throw 'Windows portable smoke process timed out'
        }
        if ($process.ExitCode -ne 0) { throw "Windows portable smoke exited with code $($process.ExitCode)" }
        foreach ($marker in @($ready, $rendered, $quit)) {
          if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
            throw "Windows portable smoke is missing marker: $marker"
          }
        }
        try {
          $snapshot = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
          if (
            $snapshot.appPhase -ne 'running' -or
            $null -eq $snapshot.subscriber -or
            $snapshot.subscriber.phase -ne 'running' -or
            $snapshot.subscriber.connection -ne 'unconfigured' -or
            [string]::IsNullOrWhiteSpace([string]$snapshot.subscriber.subscriberKey)
          ) {
            throw 'ready marker did not contain a healthy unconfigured subscriber snapshot'
          }
          $subscriberKey = [string]$snapshot.subscriber.subscriberKey
          if ($attempt -eq 1) {
            $firstSubscriberKey = $subscriberKey
          } elseif ($subscriberKey -ne $firstSubscriberKey) {
            throw 'Windows portable smoke changed the subscriber identity across restart'
          }

          $acknowledgement = Get-Content -LiteralPath $rendered -Raw | ConvertFrom-Json
          $expectedFields = @('connectFormVisible', 'connection', 'serviceCount', 'subscriberKeyPresent', 'type') | Sort-Object
          $actualFields = @($acknowledgement.PSObject.Properties.Name) | Sort-Object
          if (($expectedFields -join '|') -ne ($actualFields -join '|')) {
            throw 'rendered acknowledgement contained unexpected fields'
          }
          if (
            $acknowledgement.type -ne 'windows-smoke-rendered' -or
            $acknowledgement.connection -ne 'unconfigured' -or
            $acknowledgement.serviceCount -ne 0 -or
            $acknowledgement.subscriberKeyPresent -ne $true -or
            $acknowledgement.connectFormVisible -ne $true
          ) {
            throw 'rendered acknowledgement did not prove the unconfigured page state'
          }

          if (-not [string]::IsNullOrWhiteSpace($BootstrapAsset)) {
            $configPath = Join-Path $appData 'Kepos\config.toml'
            if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
              throw 'Windows portable smoke did not create its first-run config'
            }
            Invoke-LoggedNative $Node "bootstrap-config-$attempt" @(
              '--import',
              'tsx',
              'scripts\verify-desktop-bootstrap.ts',
              $BootstrapAsset,
              $configPath
            )
          }
        } catch {
          throw "Windows portable smoke bridge/render proof is invalid: $($_.Exception.Message)"
        }
        Write-Host "Windows portable smoke attempt ${attempt}: bridge, render, config, and Quit PASS"
      } finally {
        if ($processStarted -and -not $process.HasExited) {
          & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-File (Join-Path $Logs "smoke-cleanup-$attempt.log")
        }
        $process.Dispose()
      }
    }
    Write-Host 'Windows portable smoke restart identity: PASS'
  } finally {
    Remove-Item Env:KEPOS_WINDOWS_SMOKE_READY_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:KEPOS_WINDOWS_SMOKE_RENDER_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:KEPOS_WINDOWS_SMOKE_QUIT_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
  }
}

function Invoke-PortableRelease {
  param(
    [Parameter(Mandatory = $true)] [string]$Repository,
    [Parameter(Mandatory = $true)] [string]$RunDirectory,
    [Parameter(Mandatory = $true)] [string]$Logs,
    [Parameter(Mandatory = $true)] [string]$ArtifactName,
    [Parameter(Mandatory = $true)] [string]$Mode,
    [Parameter(Mandatory = $true)] [string]$BootstrapAsset,
    [Parameter(Mandatory = $true)] [string]$Node
  )
  if ($ArtifactName -ne 'kepos-windows-x64.zip') { throw "invalid Windows artifact name: $ArtifactName" }
  $artifact = Join-Path $RunDirectory $ArtifactName
  if (Test-Path -LiteralPath $artifact) { throw "release output already exists: $artifact" }
  $sourceRoot = Join-Path $RunDirectory 'dist\desktop\Kepos'
  $runtimeSource = Join-Path $Repository 'vendor\holepunch\bare-win-ui\prebuilds\win32-x64\bare'
  Assert-SafeOwnedPath $RunDirectory $sourceRoot 'portable source'
  Assert-SafeOwnedPath $Repository $runtimeSource 'native runtime source'
  $fileSet = @(Get-PortableFileSet $sourceRoot)
  $packageRoot = Join-Path $RunDirectory 'package'
  $packageApp = Join-Path $packageRoot 'Kepos'
  $extracted = Join-Path $RunDirectory 'extracted'
  $runtimeValidation = Join-Path $RunDirectory 'runtime-validation'
  Assert-SafeOwnedPath $RunDirectory $packageRoot 'release package'
  Assert-SafeOwnedPath $RunDirectory $extracted 'release extraction'
  Assert-SafeOwnedPath $RunDirectory $runtimeValidation 'runtime validation'
  foreach ($directory in @($packageRoot, $extracted, $runtimeValidation)) {
    if (Test-Path -LiteralPath $directory) { throw "release output already exists: $directory" }
  }
  $script:ReleasePackageOwned = $true
  New-Item -ItemType Directory -Path $packageApp -Force | Out-Null
  foreach ($relative in $fileSet) {
    $source = Join-Path $sourceRoot $relative
    $target = Join-Path $packageApp $relative
    Assert-SafeOwnedPath $packageRoot $target 'release package entry'
    if ((Get-Item -LiteralPath $source) -is [System.IO.DirectoryInfo]) {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
      continue
    }
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
  }
  $script:ReleaseArtifactOwned = $true
  Compress-Archive -LiteralPath $packageApp -DestinationPath $artifact -CompressionLevel Optimal
  $script:ReleaseExtractionOwned = $true
  New-Item -ItemType Directory -Path $extracted -Force | Out-Null
  Expand-Archive -LiteralPath $artifact -DestinationPath $extracted -Force
  $extractedApp = Join-Path $extracted 'Kepos'
  $extractedSet = @(Get-PortableFileSet $extractedApp)
  if (($fileSet -join "`n") -ne ($extractedSet -join "`n")) { throw 'Windows ZIP changed the validated portable file set' }
  $script:ReleaseValidationOwned = $true
  Invoke-LoggedNative $Node 'self-contained-runtime-artifact' @(
    '--import',
    'tsx',
    (Join-Path $Repository 'scripts\windows\self-contained-runtime.ts'),
    'validate-final',
    $runtimeSource,
    (Join-Path $extractedApp 'App'),
    $runtimeValidation
  )
  Assert-SelfContainedImports (Join-Path $extractedApp 'App\Kepos.exe')
  Invoke-LoggedNative $Node 'bootstrap-artifact' @(
    '--import',
    'tsx',
    'scripts\verify-bootstrap-asset.ts',
    $BootstrapAsset,
    (Join-Path $extractedApp 'App\kepos-bootstrap.json')
  )
  Invoke-PortableSmoke (Join-Path $extractedApp 'App\Kepos.exe') $extracted (Join-Path $Logs 'smoke') $BootstrapAsset $Node
  Get-FileHash -Algorithm SHA256 -LiteralPath $artifact | Format-List | Out-File (Join-Path $Logs 'release-artifact.sha256')
  Write-Host "Windows ZIP verified: $artifact"
}

$TranscriptStarted = $false
$DriveCreated = $false
$CleanupFailed = $false
$ExitCode = 0
$OriginalLocation = (Get-Location).Path
$Logs = $null
$RunMarker = $null
$ReleaseArtifactPath = $null
$ReleaseArtifactOwned = $false
$ReleasePackageOwned = $false
$ReleaseExtractionOwned = $false
$ReleaseValidationOwned = $false

try {
  $WorkspaceRoot = Get-CanonicalPath $WorkspaceRoot
  $RunDirectory = Get-CanonicalPath $RunDirectory
  $Repository = Get-CanonicalPath $Repository
  $ToolsDirectory = Get-CanonicalPath $ToolsDirectory
  Assert-SafeOwnedPath $WorkspaceRoot $RunDirectory 'RunDirectory'
  Assert-SafeOwnedPath $WorkspaceRoot $Repository 'Repository'
  $bootstrapRequired = [bool]$RequireBootstrap -or $Workflow -eq 'release'
  $BootstrapAsset = Assert-BootstrapInput $RunDirectory $BootstrapAsset $bootstrapRequired
  if ($Workflow -eq 'release') {
    if ([string]::IsNullOrWhiteSpace($ReleaseArtifactName)) { throw 'release workflow requires an artifact name' }
    # Validate and contain this value before any catch-path cleanup can use it.
    $ReleaseArtifactPath = Get-ContainedReleaseArtifactPath $RunDirectory $ReleaseArtifactName
    foreach ($existingReleaseOutput in @(
      $ReleaseArtifactPath,
      (Join-Path $RunDirectory 'package'),
      (Join-Path $RunDirectory 'extracted')
    )) {
      if (Test-Path -LiteralPath $existingReleaseOutput) {
        throw "release output already exists: $existingReleaseOutput"
      }
    }
  }

  $Node = Join-Path $ToolsDirectory 'node-v24.18.1-win-x64\node.exe'
  $Npm = Join-Path $ToolsDirectory 'node-v24.18.1-win-x64\npm.cmd'
  $Logs = Join-Path $RunDirectory 'logs'
  $Artifact = Join-Path $RunDirectory 'dist\desktop'
  $RepositoryArtifact = Join-Path $Repository 'dist\desktop'
  $RevisionFile = Join-Path $RunDirectory 'build-revisions.txt'
  $RunMarker = Join-Path $RunDirectory '.kepos-windows-workflow-run'
  Assert-SafeOwnedPath $Repository $RepositoryArtifact 'Repository artifact'
  Assert-SafeOwnedPath $RunDirectory $Artifact 'staged artifact'
  Assert-SafeOwnedPath $RunDirectory $Logs 'logs'
  Assert-SafeOwnedPath $RunDirectory $RevisionFile 'revision file'
  Assert-SafeOwnedPath $WorkspaceRoot $RunMarker 'run marker'

  if (-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) { throw "Workspace root is missing: $WorkspaceRoot" }
  if (-not (Test-Path -LiteralPath $Repository -PathType Container)) { throw "Repository snapshot is missing: $Repository" }

  # Mark this run only after containment checks. A timestamp-shaped directory
  # without this exact workflow marker is never eligible for retention.
  New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
  "kepos-windows-workflow-run:$RunId" | Set-Content -LiteralPath $RunMarker -Encoding utf8
  $ownedRuns = Get-ChildItem -LiteralPath $WorkspaceRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^[0-9TZ-]+$' -and $_.Name -ne $RunId -and (Test-OwnedRunDirectory $_) } |
    Sort-Object LastWriteTime -Descending
  $ownedRuns | Select-Object -Skip 3 | ForEach-Object {
    Remove-SafeOwnedTree $WorkspaceRoot $_.FullName 'retained run directory'
  }
  New-Item -ItemType Directory -Path $Logs -Force | Out-Null
  Start-Transcript -LiteralPath (Join-Path $Logs 'orchestrator.log') -Force | Out-Null
  $TranscriptStarted = $true

  foreach ($ownedOutput in @((Join-Path $RunDirectory 'dist'), (Join-Path $RunDirectory 'native-check'))) {
    Remove-SafeOwnedTree $RunDirectory $ownedOutput 'owned build output'
  }

  # npm workspace discovery must use the canonical checkout path. npm resolves
  # substituted-drive workspaces as unrelated roots, while CMake needs the
  # short alias only after dependencies are installed.
  Set-Location -LiteralPath $Repository
  $NpmInstallLog = Join-Path $Logs 'npm-ci.log'
  Write-Host "> $Npm ci --ignore-scripts --no-audit --no-fund"
  & $Npm ci --ignore-scripts --no-audit --no-fund 2>&1 | Tee-Object -FilePath $NpmInstallLog
  $npmInstallCode = $LASTEXITCODE
  if ($npmInstallCode -ne 0) { throw "npm-ci failed with exit code $npmInstallCode; see $NpmInstallLog" }

  $existingSubst = Get-SubstTarget
  if ($null -ne $existingSubst) {
    if ((Get-CanonicalPath $existingSubst) -ne $WorkspaceRoot) {
      throw "K: is already mapped to a different path: $existingSubst"
    }
    # Reusing an exact pre-existing mapping does not transfer ownership to
    # this invocation, so cleanup must leave it in place.
    Write-Host "Reusing existing K: mapping for $WorkspaceRoot"
  } else {
    $existingDrive = Get-PSDrive -Name K -ErrorAction SilentlyContinue
    if ($null -ne $existingDrive) {
      throw 'K: is already in use and is not a subst mapping to this repository'
    }
    $mountOutput = @(& subst.exe K: $WorkspaceRoot 2>&1)
    $mountCode = $LASTEXITCODE
    if ($mountCode -ne 0) {
      $details = ($mountOutput -join ' ').Trim()
      if ([string]::IsNullOrWhiteSpace($details)) {
        throw "Failed to map K: to $Repository with exit code $mountCode"
      }
      throw "Failed to map K: to $Repository with exit code ${mountCode}: $details"
    }
    # Only a successful mapping command makes this invocation the owner.
    $DriveCreated = $true
    $mappedAfterMount = Get-SubstTarget
    if ($null -eq $mappedAfterMount -or (Get-CanonicalPath $mappedAfterMount) -ne $WorkspaceRoot) {
      throw "K: did not resolve to the owned repository after mapping"
    }
    Write-Host "Mapped K: to $WorkspaceRoot"
  }

  # All npm, CMake, Bare, and native sample paths below use this short alias.
  $BuildRepository = 'K:\source'
  Set-Location -LiteralPath $BuildRepository
  $NativeCheck = Join-Path $BuildRepository '.build\windows-native-check'
  $TestWinUi = Join-Path $NativeCheck 'bare-win-ui-testing'
  $CanonicalNativeCheck = Join-Path $Repository '.build\windows-native-check'
  $CanonicalNativeBuildRoot = Join-Path $WorkspaceRoot 'cache'
  Assert-SafeOwnedPath $WorkspaceRoot $CanonicalNativeBuildRoot 'native build root'
  New-Item -ItemType Directory -Path $CanonicalNativeBuildRoot -Force | Out-Null
  $env:KEPOS_WINDOWS_NATIVE_BUILD_ROOT = 'K:\cache'
  $NuGetCache = Join-Path $WorkspaceRoot 'cache-downloads'
  Assert-SafeOwnedPath $WorkspaceRoot $NuGetCache 'NuGet package cache'
  New-Item -ItemType Directory -Path $NuGetCache -Force | Out-Null
  $env:BARE_WIN_UI_NUGET_CACHE = $NuGetCache
  # A tracked snapshot can carry older mtimes than the persistent cache. Drop
  # the compiler PCH sidecar and object together so clang rebuilds both; retain
  # downloaded SDKs and the rest of the native cache.
  $cachedCMakeFiles = Join-Path $CanonicalNativeBuildRoot 'winui\CMakeFiles'
  Assert-SafeOwnedPath $CanonicalNativeBuildRoot $cachedCMakeFiles 'cached CMake files'
  if (Test-Path -LiteralPath $cachedCMakeFiles) {
    Assert-NoReparsePointsInTree $cachedCMakeFiles 'cached CMake files'
    Get-ChildItem -LiteralPath $cachedCMakeFiles -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^cmake_pch\.cxx\.(obj|pch|obj\.d)$' } |
      Remove-Item -Force
  }
  Assert-SafeOwnedPath $Repository $CanonicalNativeCheck 'native check output'
  Remove-SafeOwnedTree $Repository $CanonicalNativeCheck 'native check output'

  function Invoke-LoggedNative {
    param(
      [Parameter(Mandatory = $true)] [string]$File,
      [Parameter(Mandatory = $true)] [string]$Name,
      [Parameter(Mandatory = $false)] [string[]]$Arguments = @()
    )
    $log = Join-Path $Logs "$Name.log"
    Write-Host "> $File $($Arguments -join ' ')"
    $previousErrorPreference = $ErrorActionPreference
    try {
      # Windows PowerShell 5.1 wraps every native stderr line as a non-terminating
      # error. Git and CMake use stderr for normal progress, so trust the exit
      # code while retaining the merged stream in the bounded command log.
      $ErrorActionPreference = 'Continue'
      & $File @Arguments 2>&1 | Tee-Object -FilePath $log
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorPreference
    }
    if ($code -ne 0) { throw "$Name failed with exit code $code; see $log" }
  }

  function Import-MsvcEnvironment {
    $vsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vsWhere)) { throw "MSVC is missing: $vsWhere" }
    $installation = (& $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($installation)) { throw 'MSVC x64 component is missing' }
    $devCmd = Join-Path $installation.Trim() 'Common7\Tools\VsDevCmd.bat'
    if (-not (Test-Path $devCmd)) { throw "MSVC developer command is missing: $devCmd" }
    $dump = & cmd.exe /d /s /c "call `"$devCmd`" -arch=x64 >nul && set"
    foreach ($line in $dump) {
      $separator = $line.IndexOf('=')
      if ($separator -gt 0) {
        [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1))
      }
    }
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) { throw 'MSVC cl.exe is missing after environment setup' }
  }

  function Require-Version {
    param([string]$File, [string]$Name, [string]$Pattern)
    if (-not (Test-Path $File)) { throw "$Name is missing: $File" }
    $version = (& $File --version | Select-Object -First 1).Trim()
    if ($version -notmatch $Pattern) { throw "$Name has unsupported version '$version'; expected $Pattern" }
    Write-Host "${Name}: $version"
  }

  Import-MsvcEnvironment
  if ($Workflow -eq 'release') {
    if ([string]::IsNullOrWhiteSpace($ReleaseTag) -or [string]::IsNullOrWhiteSpace($ReleaseMode) -or [string]::IsNullOrWhiteSpace($RemoteOrigin) -or [string]::IsNullOrWhiteSpace($ReleaseArtifactName)) {
      throw 'release workflow requires tag, mode, origin, and artifact name'
    }
    if ($ReleaseTag -notmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "invalid release tag: $ReleaseTag" }
    $major = [System.Numerics.BigInteger]::Parse($matches[1])
    $minor = [System.Numerics.BigInteger]::Parse($matches[2])
    $patch = [System.Numerics.BigInteger]::Parse($matches[3])
    if ($minor -ge 1000 -or $patch -ge 1000) { throw "invalid release tag components: $ReleaseTag" }
    $versionCode = ($major * 1000000) + ($minor * 1000) + $patch
    if ($versionCode -le 0 -or $versionCode -gt 2100000000) { throw "release tag is outside Android versionCode range: $ReleaseTag" }
    if ($ReleaseMode -eq 'release') {
      $remoteLines = @(& git.exe ls-remote --tags $RemoteOrigin "refs/tags/$ReleaseTag" "refs/tags/$ReleaseTag^{}" 2>&1)
      if ($LASTEXITCODE -ne 0) { throw "remote tag lookup failed; see $Logs\remote-tag.log" }
      $remoteLines | Set-Content -LiteralPath (Join-Path $Logs 'remote-tag.log') -Encoding utf8
      $refs = @{}
      foreach ($line in $remoteLines) {
        if ([string]$line -match '^([0-9a-f]{40,64})\s+(.+)$') { $refs[$matches[2]] = $matches[1] }
      }
      $directRef = "refs/tags/$ReleaseTag"
      $peeledRef = "$directRef^{}"
      if (-not $refs.ContainsKey($directRef) -or -not $refs.ContainsKey($peeledRef)) { throw "remote $ReleaseTag is not an annotated tag; see $Logs\remote-tag.log" }
      if ($refs[$peeledRef] -ne $RootRevision) { throw "remote $ReleaseTag does not resolve to release commit $RootRevision" }
    }
  }
  Require-Version $Node 'Node' '^v24\.'
  Require-Version $Npm 'npm' '^11\.'
  if (-not (Get-Command cmake.exe -ErrorAction SilentlyContinue)) { throw 'CMake is missing from PATH' }

  $BareMake = Join-Path $BuildRepository 'node_modules\.bin\bare-make.cmd'
  $BareBuild = Join-Path $BuildRepository 'node_modules\.bin\bare-build.cmd'
  $BareLink = Join-Path $BuildRepository 'node_modules\.bin\bare-link.cmd'
  foreach ($tool in @($BareMake, $BareBuild, $BareLink)) {
    if (-not (Test-Path $tool)) { throw "Bare tooling is missing: $tool" }
  }

  @(
    "root=$RootRevision",
    "bare-native=$BareNativeRevision",
    "bare-win-ui=$BareWinUiRevision",
    "bare-app-kit=$BareAppKitRevision"
  ) | Set-Content -LiteralPath $RevisionFile -Encoding utf8

  $DesktopBuildArguments = @('run', 'desktop:build', '--', '--target', 'win32-x64')
  if (-not [string]::IsNullOrWhiteSpace($BootstrapAsset)) {
    $DesktopBuildArguments += @('--bootstrap-asset', $BootstrapAsset)
  }
  if ($bootstrapRequired) { $DesktopBuildArguments += '--require-bootstrap' }
  Invoke-LoggedNative $Npm 'desktop-build' $DesktopBuildArguments

  if ($Workflow -eq 'dogfood') {
    # Keep the packaged desktop build production-only. The adapter sample uses
    # private native controls, so build an isolated test prebuild and source
    # root instead of reusing the production prebuild installed above.
    $WinUi = Join-Path $BuildRepository 'vendor\holepunch\bare-win-ui'
    # Reconfigure the already populated production build tree so all fetched
    # SDKs and source dependencies stay inside the existing safe cache root.
    $TestingBuild = Join-Path $env:KEPOS_WINDOWS_NATIVE_BUILD_ROOT 'winui'
    Assert-SafeOwnedPath $NativeCheck $TestWinUi 'bare-win-ui test source'
    New-Item -ItemType Directory -Path $TestWinUi -Force | Out-Null
    foreach ($sourceItem in Get-ChildItem -LiteralPath $WinUi -Force) {
      if ($sourceItem.Name -in @('.git', 'build', 'prebuilds')) { continue }
      Copy-Item -LiteralPath $sourceItem.FullName -Destination (Join-Path $TestWinUi $sourceItem.Name) -Recurse -Force
    }
    $NodeModules = Join-Path $BuildRepository 'node_modules'
    Invoke-LoggedNative $BareMake 'bare-win-ui-test-generate' @(
      'generate',
      '--source', $WinUi,
      '--build', $TestingBuild,
      '--platform', 'win32',
      '--arch', 'x64',
      '--define', "CMAKE_PREFIX_PATH:PATH=$NodeModules",
      '--define', 'FETCHCONTENT_UPDATES_DISCONNECTED:BOOL=ON',
      '--define', "node:FILEPATH=$Node",
      '--define', "npm:FILEPATH=$Npm",
      '--define', 'BARE_WIN_UI_TESTING:BOOL=ON'
    )
    Invoke-LoggedNative $BareMake 'bare-win-ui-test-build' @('build', '--build', $TestingBuild)
    Invoke-LoggedNative $BareMake 'bare-win-ui-test-install' @('install', '--build', $TestingBuild, '--prefix', (Join-Path $TestWinUi 'prebuilds'))
    Invoke-LoggedNative $BareBuild 'bare-win-ui-build' @('--base', $TestWinUi, '--host', 'win32-x64', '--runtime', (Join-Path $TestWinUi 'runtime.js'), '--out', $NativeCheck, (Join-Path $TestWinUi 'sample.js'))
  $NativeExecutable = Get-ChildItem -LiteralPath $NativeCheck -Filter '*.exe' -Recurse | Select-Object -First 1
  if ($null -eq $NativeExecutable) { throw "bare-win-ui native check produced no executable under $NativeCheck" }
  # Inherit both probe streams so a child filling either pipe cannot deadlock
  # the bounded wait. Transcript captures console output; this result log is an
  # explicit bounded outcome and is finalized after timeout cleanup.
  $NativeCheckResult = Join-Path $Logs 'bare-win-ui-run.result.log'
  $WebViewData = Join-Path $RunDirectory 'webview2'
  Assert-SafeOwnedPath $RunDirectory $WebViewData 'WebView2 test data'
  New-Item -ItemType Directory -Path $WebViewData -Force | Out-Null
  $env:WEBVIEW2_USER_DATA_FOLDER = $WebViewData
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo.FileName = $NativeExecutable.FullName
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardOutput = $false
  $process.StartInfo.RedirectStandardError = $false
  $probeStarted = $false
  $probeStatus = 'not-started'
  $nativeExitCode = $null
  $probeFailure = $null
  $probeCleanupFailure = $null
  try {
    if (-not $process.Start()) { throw 'bare-win-ui native check did not start' }
    $probeStarted = $true
    $probeStatus = 'running'
    if (-not $process.WaitForExit(30000)) {
      $probeStatus = 'timed-out'
      throw "bare-win-ui native check timed out; see $NativeCheckResult"
    }
    $process.Refresh()
    $nativeExitCode = $process.ExitCode
    if ($nativeExitCode -ne 0) {
      $probeStatus = 'failed'
      throw "bare-win-ui native check failed with exit code $nativeExitCode; see $NativeCheckResult"
    }
    $probeStatus = 'passed'
  } catch {
    $probeFailure = $_.Exception.Message
    throw
  } finally {
    if ($probeStarted) {
      try {
        if (-not $process.HasExited) {
          & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
          if (-not $process.WaitForExit(5000)) { throw "Timed-out native check process $($process.Id) did not exit after taskkill" }
          if ($probeStatus -eq 'running') { $probeStatus = 'killed' }
        }
      } catch {
        $probeStatus = 'cleanup-failed'
        $probeCleanupFailure = $_.Exception.Message
        if ($null -eq $probeFailure) { $probeFailure = $_.Exception.Message }
      }
    }
    @("status=$probeStatus", "exit-code=$nativeExitCode", "message=$probeFailure") |
      Set-Content -LiteralPath $NativeCheckResult -Encoding utf8
    $process.Dispose()
    if ($null -ne $probeCleanupFailure) { throw $probeCleanupFailure }
  }
  }

  # Keep the run directory as the sole transfer boundary: stage only the
  # already-validated desktop output, never the source checkout or native tree.
  if (-not (Test-Path -LiteralPath $RepositoryArtifact -PathType Container)) { throw "Repository desktop output is missing: $RepositoryArtifact" }
  Assert-NoReparsePointsInTree $RepositoryArtifact 'Repository desktop output'
  New-Item -ItemType Directory -Path (Join-Path $RunDirectory 'dist') -Force | Out-Null
  Copy-Item -LiteralPath $RepositoryArtifact -Destination $Artifact -Recurse -Force
  $StagedExecutable = Join-Path $Artifact 'Kepos\App\Kepos.exe'
  if (-not (Test-Path -LiteralPath $StagedExecutable -PathType Leaf)) { throw "staged Kepos.exe was not produced: $StagedExecutable" }
  Get-ChildItem -LiteralPath $Artifact -File -Recurse | Select-Object FullName, Length | Format-Table -AutoSize | Out-File (Join-Path $Logs 'artifact-files.txt')
  if ($Workflow -eq 'dogfood') {
    $PackagedSmokeRoot = Join-Path $RunDirectory 'packaged-smoke'
    Assert-SafeOwnedPath $RunDirectory $PackagedSmokeRoot 'packaged smoke root'
    Invoke-PortableSmoke $StagedExecutable $PackagedSmokeRoot (Join-Path $Logs 'packaged-smoke') $BootstrapAsset $Node
  } elseif ($Workflow -eq 'release') {
    Invoke-PortableRelease $Repository $RunDirectory $Logs $ReleaseArtifactName $ReleaseMode $BootstrapAsset $Node
  }
  Write-Host "Windows desktop build complete: $Artifact"
} catch {
  $ExitCode = 1
  if ($null -ne $ReleaseArtifactPath) {
    if ($ReleaseArtifactOwned) {
      try { Remove-SafeOwnedTree $RunDirectory $ReleaseArtifactPath 'release artifact' } catch { }
    }
    if ($ReleasePackageOwned) {
      try { Remove-SafeOwnedTree $RunDirectory (Join-Path $RunDirectory 'package') 'release package' } catch { }
    }
    if ($ReleaseExtractionOwned) {
      try { Remove-SafeOwnedTree $RunDirectory (Join-Path $RunDirectory 'extracted') 'release extraction' } catch { }
    }
    if ($ReleaseValidationOwned) {
      try { Remove-SafeOwnedTree $RunDirectory (Join-Path $RunDirectory 'runtime-validation') 'runtime validation' } catch { }
    }
  }
  if ($TranscriptStarted) {
    Write-Host 'Windows desktop build failed:'
    Write-Host ($_ | Out-String)
  } else {
    [Console]::Error.WriteLine($_.Exception.Message)
  }
} finally {
  try {
    Set-Location -LiteralPath $OriginalLocation
  } catch {
    $CleanupFailed = $true
    [Console]::Error.WriteLine("Failed to restore the original location '$OriginalLocation': $($_.Exception.Message)")
    try { Set-Location -LiteralPath ($env:SystemDrive + '\') } catch { }
  }

  if ($DriveCreated) {
    try {
      Remove-OwnedSubst $WorkspaceRoot
    } catch {
      $CleanupFailed = $true
      [Console]::Error.WriteLine("K: cleanup failed: $($_.Exception.Message)")
    }
  }

  if ($TranscriptStarted) {
    try {
      Stop-Transcript | Out-Null
    } catch {
      $CleanupFailed = $true
      [Console]::Error.WriteLine("Transcript cleanup failed: $($_.Exception.Message)")
    }
  }
}

if ($CleanupFailed) { $ExitCode = 1 }
if ($ExitCode -ne 0) { exit $ExitCode }
