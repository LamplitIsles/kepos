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
  [Parameter(Mandatory = $true)] [string]$BareAppKitRevision
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

$TranscriptStarted = $false
$DriveCreated = $false
$CleanupFailed = $false
$ExitCode = 0
$OriginalLocation = (Get-Location).Path
$Logs = $null

try {
  $WorkspaceRoot = Get-CanonicalPath $WorkspaceRoot
  $RunDirectory = Get-CanonicalPath $RunDirectory
  $Repository = Get-CanonicalPath $Repository
  $ToolsDirectory = Get-CanonicalPath $ToolsDirectory
  Assert-OwnedPath $WorkspaceRoot $RunDirectory 'RunDirectory'
  Assert-OwnedPath $RunDirectory $Repository 'Repository'

  $Node = Join-Path $ToolsDirectory 'node-v24.18.1-win-x64\node.exe'
  $Npm = Join-Path $ToolsDirectory 'node-v24.18.1-win-x64\npm.cmd'
  $Logs = Join-Path $RunDirectory 'logs'
  $Artifact = Join-Path $RunDirectory 'dist\desktop'
  $RepositoryArtifact = Join-Path $Repository 'dist\desktop'
  $RevisionFile = Join-Path $RunDirectory 'build-revisions.txt'
  Assert-OwnedPath $Repository $RepositoryArtifact 'Repository artifact'
  Assert-OwnedPath $RunDirectory $Artifact 'staged artifact'

  if (-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) { throw "Workspace root is missing: $WorkspaceRoot" }
  if (-not (Test-Path -LiteralPath $Repository -PathType Container)) { throw "Repository snapshot is missing: $Repository" }

  $ownedRuns = Get-ChildItem -LiteralPath $WorkspaceRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^[0-9TZ-]+$' -and $_.Name -ne $RunId } |
    Sort-Object LastWriteTime -Descending
  $ownedRuns | Select-Object -Skip 3 | Remove-Item -Recurse -Force
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
    if ((Get-CanonicalPath $existingSubst) -ne $Repository) {
      throw "K: is already mapped to a different path: $existingSubst"
    }
    # An exact pre-existing mapping is safe to use and to remove in finally;
    # conflicting mappings are rejected before this flag is set.
    $DriveCreated = $true
    Write-Host "Reusing existing K: mapping for $Repository"
  } else {
    $existingDrive = Get-PSDrive -Name K -ErrorAction SilentlyContinue
    if ($null -ne $existingDrive) {
      throw 'K: is already in use and is not a subst mapping to this repository'
    }
    # Mark this before invoking subst so a partially successful command is
    # still inspected and cleaned up by finally.
    $DriveCreated = $true
    $mountOutput = @(& subst.exe K: $Repository 2>&1)
    $mountCode = $LASTEXITCODE
    if ($mountCode -ne 0) {
      $details = ($mountOutput -join ' ').Trim()
      if ([string]::IsNullOrWhiteSpace($details)) {
        throw "Failed to map K: to $Repository with exit code $mountCode"
      }
      throw "Failed to map K: to $Repository with exit code ${mountCode}: $details"
    }
    $mappedAfterMount = Get-SubstTarget
    if ($null -eq $mappedAfterMount -or (Get-CanonicalPath $mappedAfterMount) -ne $Repository) {
      throw "K: did not resolve to the owned repository after mapping"
    }
    Write-Host "Mapped K: to $Repository"
  }

  # All npm, CMake, Bare, and native sample paths below use this short alias.
  $BuildRepository = 'K:\'
  Set-Location -LiteralPath $BuildRepository
  $NativeCheck = Join-Path $BuildRepository '.build\windows-native-check'
  $CanonicalNativeCheck = Join-Path $Repository '.build\windows-native-check'
  $NativeBuildRoot = Join-Path $RunDirectory 'b'
  Assert-OwnedPath $RunDirectory $NativeBuildRoot 'native build root'
  if (Test-Path -LiteralPath $NativeBuildRoot) { Remove-Item -LiteralPath $NativeBuildRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $NativeBuildRoot -Force | Out-Null
  $env:KEPOS_WINDOWS_NATIVE_BUILD_ROOT = $NativeBuildRoot
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
    & $File @Arguments 2>&1 | Tee-Object -FilePath $log
    $code = $LASTEXITCODE
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
  $NativeCheckStdout = Join-Path $Logs 'bare-win-ui-run.stdout.log'
  $NativeCheckStderr = Join-Path $Logs 'bare-win-ui-run.stderr.log'
  $process = Start-Process -FilePath $NativeExecutable.FullName -Wait -PassThru -RedirectStandardOutput $NativeCheckStdout -RedirectStandardError $NativeCheckStderr
  if ($process.ExitCode -ne 0) { throw "bare-win-ui native check failed with exit code $($process.ExitCode); see $NativeCheckStdout" }

  # Keep the run directory as the sole transfer boundary: stage only the
  # already-validated desktop output, never the source checkout or native tree.
  if (-not (Test-Path -LiteralPath $RepositoryArtifact -PathType Container)) { throw "Repository desktop output is missing: $RepositoryArtifact" }
  New-Item -ItemType Directory -Path (Join-Path $RunDirectory 'dist') -Force | Out-Null
  Copy-Item -LiteralPath $RepositoryArtifact -Destination $Artifact -Recurse -Force
  $StagedExecutable = Join-Path $Artifact 'Kepos\App\Kepos.exe'
  if (-not (Test-Path -LiteralPath $StagedExecutable -PathType Leaf)) { throw "staged Kepos.exe was not produced: $StagedExecutable" }
  Get-ChildItem -LiteralPath $Artifact -File -Recurse | Select-Object FullName, Length | Format-Table -AutoSize | Out-File (Join-Path $Logs 'artifact-files.txt')
  Write-Host "Windows desktop build complete: $Artifact"
} catch {
  $ExitCode = 1
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
      Remove-OwnedSubst $Repository
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
