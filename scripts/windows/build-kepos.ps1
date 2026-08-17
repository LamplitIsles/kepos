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
$RevisionFile = Join-Path $RunDirectory 'build-revisions.txt'

if (-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) { throw "Workspace root is missing: $WorkspaceRoot" }
if (-not (Test-Path -LiteralPath $Repository -PathType Container)) { throw "Repository snapshot is missing: $Repository" }

$ownedRuns = Get-ChildItem -LiteralPath $WorkspaceRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^[0-9TZ-]+$' } |
  Sort-Object LastWriteTime -Descending
$ownedRuns | Select-Object -Skip 3 | Remove-Item -Recurse -Force
foreach ($ownedOutput in @($Logs, (Join-Path $RunDirectory 'dist'), (Join-Path $RunDirectory 'native-check'))) {
  if (Test-Path -LiteralPath $ownedOutput) { Remove-Item -LiteralPath $ownedOutput -Recurse -Force }
}
New-Item -ItemType Directory -Path $Logs -Force | Out-Null
Start-Transcript -LiteralPath (Join-Path $Logs 'orchestrator.log') -Force | Out-Null

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
Set-Location -LiteralPath $Repository

Invoke-LoggedNative $Npm 'npm-ci' @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
$BareMake = Join-Path $Repository 'node_modules\.bin\bare-make.cmd'
$BareBuild = Join-Path $Repository 'node_modules\.bin\bare-build.cmd'
$BareLink = Join-Path $Repository 'node_modules\.bin\bare-link.cmd'
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
$WinUi = Join-Path $Repository 'vendor\holepunch\bare-win-ui'
$NativeCheck = Join-Path $RunDirectory 'native-check'
Invoke-LoggedNative $BareBuild 'bare-win-ui-build' @('--base', $WinUi, '--host', 'win32-x64', '--runtime', (Join-Path $WinUi 'runtime.js'), '--out', $NativeCheck, (Join-Path $WinUi 'sample.js'))
$NativeExecutable = Get-ChildItem -LiteralPath $NativeCheck -Filter '*.exe' -Recurse | Select-Object -First 1
if ($null -eq $NativeExecutable) { throw "bare-win-ui native check produced no executable under $NativeCheck" }
$NativeCheckStdout = Join-Path $Logs 'bare-win-ui-run.stdout.log'
$NativeCheckStderr = Join-Path $Logs 'bare-win-ui-run.stderr.log'
$process = Start-Process -FilePath $NativeExecutable.FullName -Wait -PassThru -RedirectStandardOutput $NativeCheckStdout -RedirectStandardError $NativeCheckStderr
if ($process.ExitCode -ne 0) { throw "bare-win-ui native check failed with exit code $($process.ExitCode); see $NativeCheckStdout" }

if (-not (Test-Path -LiteralPath (Join-Path $Artifact 'Kepos\App\Kepos.exe'))) { throw 'Kepos.exe was not produced' }
Get-ChildItem -LiteralPath $Artifact -File -Recurse | Select-Object FullName, Length | Format-Table -AutoSize | Out-File (Join-Path $Logs 'artifact-files.txt')
Write-Host "Windows desktop build complete: $Artifact"
Stop-Transcript | Out-Null
