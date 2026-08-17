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

function Get-ContainedReleaseArtifactPath {
  param(
    [Parameter(Mandatory = $true)] [string]$RunDirectory,
    [Parameter(Mandatory = $true)] [string]$ArtifactName
  )
  if ($ArtifactName -notmatch '^kepos-windows-x64-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.zip$') {
    throw "invalid Windows artifact name: $ArtifactName"
  }
  $artifact = Join-Path $RunDirectory $ArtifactName
  Assert-OwnedPath $RunDirectory $artifact 'release artifact'
  return $artifact
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

function Get-PortableFileSet {
  param([Parameter(Mandatory = $true)] [string]$PackageRoot)
  $items = @(Get-ChildItem -LiteralPath $PackageRoot -Force -Recurse)
  if ($items.Count -eq 0) { throw "Windows portable app has no files: $PackageRoot" }

  # This is deliberately an allowlist, not a catch-all DLL rule. Native
  # dependency versions may change, but only the named runtime families may
  # cross the release boundary.
  $runtimeDll = '\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?'
  $allowedEntries = @(
    '^App$',
    '^Assets$',
    '^AppxManifest\.xml$',
    '^Assets\\Logo\.ico$',
    '^App\\Kepos\.exe$',
    '^App\\app\.bundle$',
    '^App\\Microsoft\.Web\.WebView2\.Core\.dll$',
    '^App\\Microsoft\.WindowsAppRuntime\.Bootstrap\.dll$',
    "^App\\bare-(abort|buffer|crypto|dns|fs|hrtime|inspect|lief|module-lexer|os|path|pipe|signals|stdio|structured-clone|subprocess|tcp|tty|type|url|win-ui)-$runtimeDll\.dll$",
    "^App\\(sodium-native|udx-native)-$runtimeDll\.dll$"
  )
  $relative = @($items | ForEach-Object {
      if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Windows portable app contains a link: $($_.FullName)"
      }
      Get-PortableRelativePath $PackageRoot $_
    } | Sort-Object)
  foreach ($name in $relative) {
    if (-not ($allowedEntries | Where-Object { $name -match $_ })) {
      throw "Windows portable app contains an unexpected entry: $name"
    }
  }
  foreach ($name in @('AppxManifest.xml', 'Assets\Logo.ico', 'App\Kepos.exe', 'App\app.bundle', 'App\Microsoft.Web.WebView2.Core.dll', 'App\Microsoft.WindowsAppRuntime.Bootstrap.dll')) {
    if (-not $relative.Contains($name)) { throw "Windows portable app is missing $name" }
  }
  if (-not ($relative | Where-Object { $_ -match '^App\\bare-win-ui-' })) {
    throw 'Windows portable app is missing the bare-win-ui runtime'
  }
  Assert-Pe64 (Join-Path $PackageRoot 'App\Kepos.exe')
  return $relative
}

function Invoke-PortableSmoke {
  param(
    [Parameter(Mandatory = $true)] [string]$Executable,
    [Parameter(Mandatory = $true)] [string]$SmokeRoot,
    [Parameter(Mandatory = $true)] [string]$Logs
  )
  $state = Join-Path $SmokeRoot 'state'
  $smokeHome = Join-Path $SmokeRoot 'home'
  $appData = Join-Path $SmokeRoot 'AppData\Roaming'
  $localAppData = Join-Path $SmokeRoot 'AppData\Local'
  $webViewData = Join-Path $SmokeRoot 'WebView2'
  $ready = Join-Path $SmokeRoot 'ready.marker'
  $quit = Join-Path $SmokeRoot 'quit.marker'
  New-Item -ItemType Directory -Path $state, $smokeHome, $appData, $localAppData, $webViewData, $Logs -Force | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $publisherManifest = @{ displayName = 'Kepos release smoke'; publisherConfig = 'publisher.json'; services = @() } |
    ConvertTo-Json -Depth 5
  $publisherConfig = @{ seed = (('00' * 32) -join ''); allow = @() } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText((Join-Path $state 'publisher.manifest.json'), $publisherManifest, $utf8)
  [System.IO.File]::WriteAllText((Join-Path $state 'publisher.json'), $publisherConfig, $utf8)
  $env:APPDATA = $appData
  $env:LOCALAPPDATA = $localAppData
  $env:WEBVIEW2_USER_DATA_FOLDER = $webViewData
  $env:KEPOS_WINDOWS_SMOKE_READY_FILE = $ready
  $env:KEPOS_WINDOWS_SMOKE_QUIT_FILE = $quit
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo.FileName = $Executable
  $process.StartInfo.Arguments = "--publisher-state `"$state`" --smoke-test --smoke-home `"$smokeHome`""
  $process.StartInfo.WorkingDirectory = Split-Path -Parent $Executable
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardOutput = $false
  $process.StartInfo.RedirectStandardError = $false
  try {
    if (-not $process.Start()) { throw 'Windows portable smoke process did not start' }
    if (-not $process.WaitForExit(45000)) {
      & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-File (Join-Path $Logs 'smoke-timeout.log')
      throw 'Windows portable smoke process timed out'
    }
    if ($process.ExitCode -ne 0) { throw "Windows portable smoke exited with code $($process.ExitCode)" }
    if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) { throw 'Windows portable smoke never reached ready' }
    try {
      $snapshot = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
      if ($snapshot.appPhase -ne 'running' -or $null -eq $snapshot.publisher -or $snapshot.publisher.phase -ne 'running') {
        throw 'ready marker did not contain a healthy publisher/runtime snapshot'
      }
    } catch {
      throw "Windows portable smoke health proof is invalid: $($_.Exception.Message)"
    }
    if (-not (Test-Path -LiteralPath $quit -PathType Leaf)) { throw 'Windows portable smoke did not complete clean Quit' }
  } finally {
    if (-not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-File (Join-Path $Logs 'smoke-cleanup.log')
    }
    $process.Dispose()
    Remove-Item Env:KEPOS_WINDOWS_SMOKE_READY_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:KEPOS_WINDOWS_SMOKE_QUIT_FILE -ErrorAction SilentlyContinue
  }
}

function Invoke-PortableRelease {
  param(
    [Parameter(Mandatory = $true)] [string]$RunDirectory,
    [Parameter(Mandatory = $true)] [string]$Logs,
    [Parameter(Mandatory = $true)] [string]$ArtifactName,
    [Parameter(Mandatory = $true)] [string]$Mode
  )
  if ($ArtifactName -notmatch '^kepos-windows-x64-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.zip$') { throw "invalid Windows artifact name: $ArtifactName" }
  $artifact = Join-Path $RunDirectory $ArtifactName
  if (Test-Path -LiteralPath $artifact) { throw "release output already exists: $artifact" }
  $sourceRoot = Join-Path $RunDirectory 'dist\desktop\Kepos'
  $fileSet = @(Get-PortableFileSet $sourceRoot)
  $packageRoot = Join-Path $RunDirectory 'package'
  $packageApp = Join-Path $packageRoot 'Kepos'
  $extracted = Join-Path $RunDirectory 'extracted'
  foreach ($directory in @($packageRoot, $extracted)) {
    if (Test-Path -LiteralPath $directory) { throw "release output already exists: $directory" }
  }
  New-Item -ItemType Directory -Path $packageApp -Force | Out-Null
  foreach ($relative in $fileSet) {
    $source = Join-Path $sourceRoot $relative
    $target = Join-Path $packageApp $relative
    if ((Get-Item -LiteralPath $source) -is [System.IO.DirectoryInfo]) {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
      continue
    }
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
  }
  Compress-Archive -LiteralPath $packageApp -DestinationPath $artifact -CompressionLevel Optimal
  New-Item -ItemType Directory -Path $extracted -Force | Out-Null
  Expand-Archive -LiteralPath $artifact -DestinationPath $extracted -Force
  $extractedApp = Join-Path $extracted 'Kepos'
  $extractedSet = @(Get-PortableFileSet $extractedApp)
  if (($fileSet -join "`n") -ne ($extractedSet -join "`n")) { throw 'Windows ZIP changed the validated portable file set' }
  Invoke-PortableSmoke (Join-Path $extractedApp 'App\Kepos.exe') $extracted (Join-Path $Logs 'smoke')
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

try {
  $WorkspaceRoot = Get-CanonicalPath $WorkspaceRoot
  $RunDirectory = Get-CanonicalPath $RunDirectory
  $Repository = Get-CanonicalPath $Repository
  $ToolsDirectory = Get-CanonicalPath $ToolsDirectory
  Assert-OwnedPath $WorkspaceRoot $RunDirectory 'RunDirectory'
  Assert-OwnedPath $WorkspaceRoot $Repository 'Repository'
  if ($Workflow -eq 'release') {
    if ([string]::IsNullOrWhiteSpace($ReleaseArtifactName)) { throw 'release workflow requires an artifact name' }
    # Validate and contain this value before any catch-path cleanup can use it.
    $ReleaseArtifactPath = Get-ContainedReleaseArtifactPath $RunDirectory $ReleaseArtifactName
  }

  $Node = Join-Path $ToolsDirectory 'node-v24.18.1-win-x64\node.exe'
  $Npm = Join-Path $ToolsDirectory 'node-v24.18.1-win-x64\npm.cmd'
  $Logs = Join-Path $RunDirectory 'logs'
  $Artifact = Join-Path $RunDirectory 'dist\desktop'
  $RepositoryArtifact = Join-Path $Repository 'dist\desktop'
  $RevisionFile = Join-Path $RunDirectory 'build-revisions.txt'
  $RunMarker = Join-Path $RunDirectory '.kepos-windows-workflow-run'
  Assert-OwnedPath $Repository $RepositoryArtifact 'Repository artifact'
  Assert-OwnedPath $RunDirectory $Artifact 'staged artifact'
  Assert-OwnedPath $RunDirectory $Logs 'logs'
  Assert-OwnedPath $RunDirectory $RevisionFile 'revision file'
  Assert-OwnedPath $WorkspaceRoot $RunMarker 'run marker'

  if (-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) { throw "Workspace root is missing: $WorkspaceRoot" }
  if (-not (Test-Path -LiteralPath $Repository -PathType Container)) { throw "Repository snapshot is missing: $Repository" }

  # Mark this run only after containment checks. A timestamp-shaped directory
  # without this exact workflow marker is never eligible for retention.
  New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
  "kepos-windows-workflow-run:$RunId" | Set-Content -LiteralPath $RunMarker -Encoding utf8
  $ownedRuns = Get-ChildItem -LiteralPath $WorkspaceRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^[0-9TZ-]+$' -and $_.Name -ne $RunId -and (Test-OwnedRunDirectory $_) } |
    Sort-Object LastWriteTime -Descending
  $ownedRuns | Select-Object -Skip 3 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
  New-Item -ItemType Directory -Path $Logs -Force | Out-Null
  Start-Transcript -LiteralPath (Join-Path $Logs 'orchestrator.log') -Force | Out-Null
  $TranscriptStarted = $true

  foreach ($ownedOutput in @((Join-Path $RunDirectory 'dist'), (Join-Path $RunDirectory 'native-check'))) {
    if (Test-Path -LiteralPath $ownedOutput) { Remove-Item -LiteralPath $ownedOutput -Recurse -Force }
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
  $CanonicalNativeCheck = Join-Path $Repository '.build\windows-native-check'
  $CanonicalNativeBuildRoot = Join-Path $WorkspaceRoot 'cache'
  Assert-OwnedPath $WorkspaceRoot $CanonicalNativeBuildRoot 'native build root'
  New-Item -ItemType Directory -Path $CanonicalNativeBuildRoot -Force | Out-Null
  $env:KEPOS_WINDOWS_NATIVE_BUILD_ROOT = 'K:\cache'
  Assert-OwnedPath $Repository $CanonicalNativeCheck 'native check output'
  if (Test-Path -LiteralPath $NativeCheck) { Remove-Item -LiteralPath $NativeCheck -Recurse -Force }

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

  Invoke-LoggedNative $Npm 'desktop-build' @('run', 'desktop:build', '--', '--target', 'win32-x64')

  # bare-win-ui's real sample is the stable native seam: WebView bridge, close
  # cancellation/reuse, tray selection, TaskbarCreated, and explicit teardown.
  $WinUi = Join-Path $BuildRepository 'vendor\holepunch\bare-win-ui'
  Invoke-LoggedNative $BareBuild 'bare-win-ui-build' @('--base', $WinUi, '--host', 'win32-x64', '--runtime', (Join-Path $WinUi 'runtime.js'), '--out', $NativeCheck, (Join-Path $WinUi 'sample.js'))
  $NativeExecutable = Get-ChildItem -LiteralPath $NativeCheck -Filter '*.exe' -Recurse | Select-Object -First 1
  if ($null -eq $NativeExecutable) { throw "bare-win-ui native check produced no executable under $NativeCheck" }
  # Inherit both probe streams so a child filling either pipe cannot deadlock
  # the bounded wait. Transcript captures console output; this result log is an
  # explicit bounded outcome and is finalized after timeout cleanup.
  $NativeCheckResult = Join-Path $Logs 'bare-win-ui-run.result.log'
  $WebViewData = Join-Path $RunDirectory 'webview2'
  Assert-OwnedPath $RunDirectory $WebViewData 'WebView2 test data'
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

  # Keep the run directory as the sole transfer boundary: stage only the
  # already-validated desktop output, never the source checkout or native tree.
  if (-not (Test-Path -LiteralPath $RepositoryArtifact -PathType Container)) { throw "Repository desktop output is missing: $RepositoryArtifact" }
  New-Item -ItemType Directory -Path (Join-Path $RunDirectory 'dist') -Force | Out-Null
  Copy-Item -LiteralPath $RepositoryArtifact -Destination $Artifact -Recurse -Force
  $StagedExecutable = Join-Path $Artifact 'Kepos\App\Kepos.exe'
  if (-not (Test-Path -LiteralPath $StagedExecutable -PathType Leaf)) { throw "staged Kepos.exe was not produced: $StagedExecutable" }
  Get-ChildItem -LiteralPath $Artifact -File -Recurse | Select-Object FullName, Length | Format-Table -AutoSize | Out-File (Join-Path $Logs 'artifact-files.txt')
  if ($Workflow -eq 'release') {
    Invoke-PortableRelease $RunDirectory $Logs $ReleaseArtifactName $ReleaseMode
  }
  Write-Host "Windows desktop build complete: $Artifact"
} catch {
  $ExitCode = 1
  if ($null -ne $ReleaseArtifactPath) {
    Remove-Item -LiteralPath $ReleaseArtifactPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $RunDirectory 'package') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $RunDirectory 'extracted') -Recurse -Force -ErrorAction SilentlyContinue
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
