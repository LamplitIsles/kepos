[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$PayloadRoot,
  [Parameter(Mandatory = $true)] [string]$RunRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FullPath {
  param([Parameter(Mandatory = $true)] [string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) { throw "acceptance path must be absolute: $Path" }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
  return $full
}

function Assert-File {
  param([Parameter(Mandatory = $true)] [string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "acceptance expected a regular file: $Path" }
}

function Assert-Directory {
  param([Parameter(Mandatory = $true)] [string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "acceptance expected a real directory: $Path" }
}

function Assert-Absent {
  param([Parameter(Mandatory = $true)] [string]$Path)
  if (Test-Path -LiteralPath $Path) { throw "acceptance expected this path to be absent: $Path" }
}

function Assert-BytesEqual {
  param(
    [Parameter(Mandatory = $true)] [byte[]]$Expected,
    [Parameter(Mandatory = $true)] [string]$ActualPath,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  Assert-File $ActualPath
  $actual = [IO.File]::ReadAllBytes($ActualPath)
  if ($actual.Length -ne $Expected.Length) { throw "$Name changed length during installer acceptance" }
  for ($index = 0; $index -lt $actual.Length; $index++) {
    if ($actual[$index] -ne $Expected[$index]) { throw "$Name changed during installer acceptance" }
  }
}

function Get-QuotedCmdPart {
  param([Parameter(Mandatory = $true)] [string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-CmdEntry {
  param(
    [Parameter(Mandatory = $true)] [string]$Entry,
    [Parameter(Mandatory = $true)] [string[]]$Arguments,
    [switch]$ExpectFailure
  )
  $parts = @((Get-QuotedCmdPart $Entry))
  foreach ($argument in $Arguments) { $parts += Get-QuotedCmdPart $argument }
  $command = $parts -join ' '
  Write-Host "> cmd.exe /d /s /c $command"
  & cmd.exe /d /s /c $command
  $code = $LASTEXITCODE
  if ($ExpectFailure) {
    if ($code -eq 0) { throw "expected CMD entrypoint to fail: $Entry" }
    return $code
  }
  if ($code -ne 0) { throw "CMD entrypoint failed with exit code ${code}: $Entry" }
  return $code
}

function Copy-Payload {
  param(
    [Parameter(Mandatory = $true)] [string]$Source,
    [Parameter(Mandatory = $true)] [string]$Destination
  )
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
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

function Assert-Shortcut {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [string]$Target,
    [Parameter(Mandatory = $true)] [string]$WorkingDirectory,
    [Parameter(Mandatory = $true)] [string]$IconLocation
  )
  Assert-File $Path
  $actual = Get-ShortcutValues $Path
  if (-not $actual.TargetPath.Equals($Target, [StringComparison]::OrdinalIgnoreCase)) { throw "shortcut target mismatch: $Path" }
  if (-not $actual.WorkingDirectory.Equals($WorkingDirectory, [StringComparison]::OrdinalIgnoreCase)) { throw "shortcut working directory mismatch: $Path" }
  if (-not $actual.IconLocation.Equals($IconLocation, [StringComparison]::OrdinalIgnoreCase)) { throw "shortcut icon mismatch: $Path" }
  if (-not [string]::IsNullOrEmpty($actual.Arguments)) { throw "shortcut unexpectedly has arguments: $Path" }
}

function Wait-ForFile {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [int]$TimeoutSeconds = 90
  )
  for ($attempt = 0; $attempt -lt ($TimeoutSeconds * 10); $attempt++) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "timed out waiting for marker: $Path"
}

function Wait-ForAbsent {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [int]$TimeoutSeconds = 45
  )
  for ($attempt = 0; $attempt -lt ($TimeoutSeconds * 10); $attempt++) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "timed out waiting for deferred cleanup: $Path"
}

function Invoke-InstalledSmoke {
  param(
    [Parameter(Mandatory = $true)] [string]$Executable,
    [Parameter(Mandatory = $true)] [string]$SmokeRoot,
    [Parameter(Mandatory = $true)] [string]$AppData,
    [Parameter(Mandatory = $true)] [string]$LocalAppData
  )
  Assert-File $Executable
  New-Item -ItemType Directory -Path $SmokeRoot, $AppData, $LocalAppData -Force | Out-Null
  $smokeHome = Join-Path $SmokeRoot 'home'
  $webViewData = Join-Path $SmokeRoot 'WebView2'
  $ready = Join-Path $SmokeRoot 'ready.marker'
  $rendered = Join-Path $SmokeRoot 'rendered.marker'
  $quit = Join-Path $SmokeRoot 'quit.marker'
  foreach ($marker in @($ready, $rendered, $quit)) {
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
  }
  New-Item -ItemType Directory -Path $smokeHome, $webViewData -Force | Out-Null

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Executable
  $startInfo.Arguments = "--smoke-test --smoke-home $(Get-QuotedCmdPart $smokeHome)"
  $startInfo.WorkingDirectory = Split-Path -Parent $Executable
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $false
  $startInfo.RedirectStandardError = $false
  $startInfo.EnvironmentVariables['APPDATA'] = $AppData
  $startInfo.EnvironmentVariables['LOCALAPPDATA'] = $LocalAppData
  $startInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = $webViewData
  $startInfo.EnvironmentVariables['KEPOS_WINDOWS_SMOKE_READY_FILE'] = $ready
  $startInfo.EnvironmentVariables['KEPOS_WINDOWS_SMOKE_RENDER_FILE'] = $rendered
  $startInfo.EnvironmentVariables['KEPOS_WINDOWS_SMOKE_QUIT_FILE'] = $quit
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $started = $false
  try {
    if (-not $process.Start()) { throw 'installed Kepos process did not start' }
    $started = $true
    Wait-ForFile $quit 90
    if (-not $process.WaitForExit(30000)) { throw 'installed Kepos process did not quit cleanly' }
    if ($process.ExitCode -ne 0) { throw "installed Kepos smoke exited with code $($process.ExitCode)" }
    foreach ($marker in @($ready, $rendered, $quit)) { Assert-File $marker }
    $snapshot = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
    if ($snapshot.appPhase -ne 'running' -or $null -eq $snapshot.subscriber -or $snapshot.subscriber.phase -ne 'running' -or $snapshot.subscriber.connection -ne 'unconfigured') {
      throw 'installed Kepos smoke did not reach the expected ready state'
    }
    Write-Host 'Installed Kepos launch readiness and clean Quit: PASS'
  } finally {
    if ($started -and -not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
      $process.WaitForExit(10000)
    }
    $process.Dispose()
  }
}

function Start-InstalledProcess {
  param(
    [Parameter(Mandatory = $true)] [string]$Executable,
    [Parameter(Mandatory = $true)] [string]$AppData,
    [Parameter(Mandatory = $true)] [string]$LocalAppData,
    [Parameter(Mandatory = $true)] [string]$Root
  )
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Executable
  $startInfo.WorkingDirectory = Split-Path -Parent $Executable
  $startInfo.UseShellExecute = $false
  $startInfo.EnvironmentVariables['APPDATA'] = $AppData
  $startInfo.EnvironmentVariables['LOCALAPPDATA'] = $LocalAppData
  $startInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $Root 'running-WebView2'
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { $process.Dispose(); throw 'installed Kepos running-process fixture did not start' }
  Start-Sleep -Seconds 2
  if ($process.HasExited) {
    $code = $process.ExitCode
    $process.Dispose()
    throw "installed Kepos running-process fixture exited early with code $code"
  }
  return $process
}

function Stop-TestProcess {
  param([Parameter(Mandatory = $true)] [System.Diagnostics.Process]$Process)
  try {
    if (-not $Process.HasExited) {
      & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
      $Process.WaitForExit(10000)
    }
  } finally {
    $Process.Dispose()
  }
}

$root = Get-FullPath $RunRoot
$payload = Get-FullPath $PayloadRoot
Assert-Directory $payload
$acceptanceRoot = Join-Path $root 'installer acceptance'
$sourceWithSpaces = Join-Path $acceptanceRoot 'source payload with spaces\Kepos'
$upgradePayload = Join-Path $acceptanceRoot 'upgrade payload with spaces\Kepos'
$localAppData = Join-Path $acceptanceRoot 'profile\LocalAppData'
$appData = Join-Path $acceptanceRoot 'profile\RoamingAppData'
$desktop = Join-Path $acceptanceRoot 'profile\Desktop'
$startMenu = Join-Path $acceptanceRoot 'profile\Start Menu\Programs'
$staging = Join-Path $localAppData 'Programs\.kepos-staging'
$install = Join-Path $localAppData 'Programs\Kepos'
$arguments = @(
  '-LocalAppData', $localAppData,
  '-AppData', $appData,
  '-Desktop', $desktop,
  '-StartMenu', $startMenu,
  '-StagingRoot', $staging,
  '-TestRoot', $acceptanceRoot
)
$installEntry = Join-Path $sourceWithSpaces 'Install.cmd'
$uninstallEntry = Join-Path $install 'Uninstall.cmd'
$startAppShortcut = Join-Path $startMenu 'Kepos.lnk'
$startUninstallShortcut = Join-Path $startMenu 'Uninstall Kepos.lnk'
$desktopShortcut = Join-Path $desktop 'Kepos.lnk'
$previousPause = $env:KEPOS_INSTALLER_NO_PAUSE
$runningProcess = $null

try {
  New-Item -ItemType Directory -Path $acceptanceRoot -Force | Out-Null
  Copy-Payload $payload $sourceWithSpaces
  Assert-File $installEntry

  $env:KEPOS_INSTALLER_NO_PAUSE = '1'
  Invoke-CmdEntry $installEntry $arguments
  Assert-Directory $install
  Assert-File (Join-Path $install '.kepos-owner')
  Assert-Shortcut $startAppShortcut (Join-Path $install 'App\Kepos.exe') (Join-Path $install 'App') "$(Join-Path $install 'App\Kepos.exe'),0"
  Assert-Shortcut $startUninstallShortcut (Join-Path $install 'Uninstall.cmd') $install "$(Join-Path $install 'App\Kepos.exe'),0"
  Assert-Shortcut $desktopShortcut (Join-Path $install 'App\Kepos.exe') (Join-Path $install 'App') "$(Join-Path $install 'App\Kepos.exe'),0"
  Write-Host 'First install, direct shortcuts, and path-with-spaces CMD forwarding: PASS'

  Invoke-InstalledSmoke (Join-Path $install 'App\Kepos.exe') (Join-Path $acceptanceRoot 'first launch') $appData $localAppData
  $configPath = Join-Path $appData 'Kepos\config.toml'
  $identityPath = Join-Path $localAppData 'Kepos\state\subscriber\client.identity.json'
  Assert-File $configPath
  Assert-File $identityPath
  $configBytes = [IO.File]::ReadAllBytes($configPath)
  $identityBytes = [IO.File]::ReadAllBytes($identityPath)
  $diagnosticsPath = Join-Path $localAppData 'Kepos\diagnostics\installer-acceptance.log'
  $unrelatedPath = Join-Path $acceptanceRoot 'unrelated-user-file.txt'
  New-Item -ItemType Directory -Path (Split-Path -Parent $diagnosticsPath) -Force | Out-Null
  [IO.File]::WriteAllText($diagnosticsPath, 'diagnostics seeded by installer acceptance`r`n', [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($unrelatedPath, 'unrelated state`r`n', [Text.Encoding]::UTF8)
  $diagnosticsBytes = [IO.File]::ReadAllBytes($diagnosticsPath)
  $unrelatedBytes = [IO.File]::ReadAllBytes($unrelatedPath)

  Copy-Payload $sourceWithSpaces $upgradePayload
  [IO.File]::WriteAllText((Join-Path $upgradePayload 'App\installer-upgrade-marker.txt'), 'upgrade complete`r`n', [Text.Encoding]::ASCII)
  Invoke-CmdEntry (Join-Path $upgradePayload 'Install.cmd') $arguments
  Assert-File (Join-Path $install 'App\installer-upgrade-marker.txt')
  Assert-Shortcut $startAppShortcut (Join-Path $install 'App\Kepos.exe') (Join-Path $install 'App') "$(Join-Path $install 'App\Kepos.exe'),0"
  Write-Host 'Owned upgrade through staged replacement: PASS'

  Remove-Item -LiteralPath $startAppShortcut -Force
  Remove-Item -LiteralPath $desktopShortcut -Force
  Invoke-CmdEntry (Join-Path $install 'Install.cmd') $arguments
  Assert-Shortcut $startAppShortcut (Join-Path $install 'App\Kepos.exe') (Join-Path $install 'App') "$(Join-Path $install 'App\Kepos.exe'),0"
  Assert-Shortcut $desktopShortcut (Join-Path $install 'App\Kepos.exe') (Join-Path $install 'App') "$(Join-Path $install 'App\Kepos.exe'),0"
  $unrelatedDesktop = Join-Path $desktop 'do-not-remove.txt'
  [IO.File]::WriteAllText($unrelatedDesktop, 'desktop state`r`n', [Text.Encoding]::UTF8)
  $unrelatedDesktopBytes = [IO.File]::ReadAllBytes($unrelatedDesktop)
  Invoke-CmdEntry (Join-Path $install 'Install.cmd') ($arguments + @('-NoDesktopShortcut'))
  Assert-Absent $desktopShortcut
  Assert-Shortcut $startAppShortcut (Join-Path $install 'App\Kepos.exe') (Join-Path $install 'App') "$(Join-Path $install 'App\Kepos.exe'),0"
  Assert-BytesEqual $unrelatedDesktopBytes $unrelatedDesktop 'unrelated Desktop file'
  Invoke-CmdEntry (Join-Path $install 'Install.cmd') $arguments
  Assert-Shortcut $desktopShortcut (Join-Path $install 'App\Kepos.exe') (Join-Path $install 'App') "$(Join-Path $install 'App\Kepos.exe'),0"
  Write-Host 'Repair and -NoDesktopShortcut ownership boundary: PASS'

  $runningProcess = Start-InstalledProcess (Join-Path $install 'App\Kepos.exe') $appData $localAppData $acceptanceRoot
  Invoke-CmdEntry (Join-Path $upgradePayload 'Install.cmd') $arguments -ExpectFailure
  Invoke-CmdEntry $uninstallEntry $arguments -ExpectFailure
  Stop-TestProcess $runningProcess
  $runningProcess = $null
  Assert-File (Join-Path $install '.kepos-owner')
  Write-Host 'Running-process refusal without termination: PASS'

  $unownedLocal = Join-Path $acceptanceRoot 'unowned profile\LocalAppData'
  $unownedAppData = Join-Path $acceptanceRoot 'unowned profile\AppData'
  $unownedDesktop = Join-Path $acceptanceRoot 'unowned profile\Desktop'
  $unownedMenu = Join-Path $acceptanceRoot 'unowned profile\Programs'
  $unownedInstall = Join-Path $unownedLocal 'Programs\Kepos'
  New-Item -ItemType Directory -Path $unownedInstall -Force | Out-Null
  $unownedSentinel = Join-Path $unownedInstall 'sentinel.txt'
  [IO.File]::WriteAllText($unownedSentinel, 'unowned`r`n', [Text.Encoding]::UTF8)
  $unownedBytes = [IO.File]::ReadAllBytes($unownedSentinel)
  Invoke-CmdEntry $installEntry @('-LocalAppData', $unownedLocal, '-AppData', $unownedAppData, '-Desktop', $unownedDesktop, '-StartMenu', $unownedMenu, '-TestRoot', $acceptanceRoot) -ExpectFailure
  Assert-BytesEqual $unownedBytes $unownedSentinel 'unowned destination'
  Write-Host 'Unowned destination refusal: PASS'

  $linkedOutside = Join-Path $acceptanceRoot 'linked outside'
  $linkedLocal = Join-Path $acceptanceRoot 'linked profile\LocalAppData'
  $linkedInstall = Join-Path $linkedLocal 'Programs\Kepos'
  New-Item -ItemType Directory -Path $linkedOutside, (Split-Path -Parent $linkedInstall) -Force | Out-Null
  $linkedSentinel = Join-Path $linkedOutside 'sentinel.txt'
  [IO.File]::WriteAllText($linkedSentinel, 'linked destination sentinel`r`n', [Text.Encoding]::UTF8)
  & cmd.exe /d /s /c ("mklink /J `"{0}`" `"{1}`"" -f $linkedInstall, $linkedOutside) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not create destination junction for acceptance' }
  $linkedBytes = [IO.File]::ReadAllBytes($linkedSentinel)
  Invoke-CmdEntry $installEntry @('-LocalAppData', $linkedLocal, '-AppData', (Join-Path $acceptanceRoot 'linked profile\AppData'), '-Desktop', (Join-Path $acceptanceRoot 'linked profile\Desktop'), '-StartMenu', (Join-Path $acceptanceRoot 'linked profile\Programs'), '-TestRoot', $acceptanceRoot) -ExpectFailure
  Assert-BytesEqual $linkedBytes $linkedSentinel 'reparse-point destination'
  Write-Host 'Reparse-point destination refusal: PASS'

  $linkedPayload = Join-Path $acceptanceRoot 'linked payload\Kepos'
  $linkedPayloadOutside = Join-Path $acceptanceRoot 'linked payload outside'
  Copy-Payload $sourceWithSpaces $linkedPayload
  New-Item -ItemType Directory -Path $linkedPayloadOutside -Force | Out-Null
  Remove-Item -LiteralPath (Join-Path $linkedPayload 'Assets') -Recurse -Force
  & cmd.exe /d /s /c ("mklink /J `"{0}`" `"{1}`"" -f (Join-Path $linkedPayload 'Assets'), $linkedPayloadOutside) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not create payload junction for acceptance' }
  Invoke-CmdEntry (Join-Path $linkedPayload 'Install.cmd') $arguments -ExpectFailure
  Assert-File (Join-Path $install '.kepos-owner')
  Write-Host 'Reparse-point payload refusal: PASS'

  $malformedPayload = Join-Path $acceptanceRoot 'malformed payload\Kepos'
  Copy-Payload $sourceWithSpaces $malformedPayload
  Remove-Item -LiteralPath (Join-Path $malformedPayload 'Assets\Logo.ico') -Force
  Invoke-CmdEntry (Join-Path $malformedPayload 'Install.cmd') $arguments -ExpectFailure
  Assert-File (Join-Path $install '.kepos-owner')
  Assert-File (Join-Path $install 'App\installer-upgrade-marker.txt')
  Write-Host 'Staged/source validation failure preserved the owned installation: PASS'

  $shortcutFailureRoot = Join-Path $acceptanceRoot 'shortcut failure'
  $shortcutFailureLocal = Join-Path $shortcutFailureRoot 'LocalAppData'
  $shortcutFailureMenu = Join-Path $shortcutFailureRoot 'Start Menu'
  $shortcutFailureDesktop = Join-Path $shortcutFailureRoot 'Desktop'
  New-Item -ItemType Directory -Path $shortcutFailureMenu, $shortcutFailureDesktop -Force | Out-Null
  $shortcutCollision = Join-Path $shortcutFailureMenu 'Kepos.lnk'
  [IO.File]::WriteAllText($shortcutCollision, 'unowned shortcut collision`r`n', [Text.Encoding]::UTF8)
  $collisionBytes = [IO.File]::ReadAllBytes($shortcutCollision)
  Invoke-CmdEntry $installEntry @('-LocalAppData', $shortcutFailureLocal, '-AppData', (Join-Path $shortcutFailureRoot 'AppData'), '-Desktop', $shortcutFailureDesktop, '-StartMenu', $shortcutFailureMenu, '-TestRoot', $acceptanceRoot) -ExpectFailure
  Assert-BytesEqual $collisionBytes $shortcutCollision 'unowned shortcut collision'
  Assert-Absent (Join-Path $shortcutFailureLocal 'Programs\Kepos')
  Write-Host 'Shortcut failure left no partial installation: PASS'

  Invoke-CmdEntry $uninstallEntry $arguments
  Wait-ForAbsent $install
  Wait-ForAbsent $startAppShortcut
  Wait-ForAbsent $startUninstallShortcut
  Wait-ForAbsent $desktopShortcut
  Assert-BytesEqual $configBytes $configPath 'Kepos config'
  Assert-BytesEqual $identityBytes $identityPath 'Kepos subscriber identity'
  Assert-BytesEqual $diagnosticsBytes $diagnosticsPath 'Kepos diagnostics'
  Assert-BytesEqual $unrelatedBytes $unrelatedPath 'unrelated user file'
  Assert-BytesEqual $unrelatedDesktopBytes $unrelatedDesktop 'unrelated Desktop file'
  Assert-Directory (Join-Path $localAppData 'Kepos\state\subscriber')
  Assert-Directory (Join-Path $localAppData 'Kepos\diagnostics')
  $helpers = @(Get-ChildItem -LiteralPath $staging -Filter '.kepos-uninstall-*.ps1' -Force -ErrorAction SilentlyContinue)
  if ($helpers.Count -ne 0) { throw 'deferred uninstall helper did not self-remove' }
  Write-Host 'Deferred uninstall removed only the owned program and shortcuts; mutable state preserved: PASS'
} finally {
  if ($null -ne $runningProcess) {
    Stop-TestProcess $runningProcess
  }
  if ($null -ne $previousPause) { $env:KEPOS_INSTALLER_NO_PAUSE = $previousPause } else { Remove-Item Env:KEPOS_INSTALLER_NO_PAUSE -ErrorAction SilentlyContinue }
}
