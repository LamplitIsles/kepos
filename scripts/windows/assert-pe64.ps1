[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Executable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bytes = [System.IO.File]::ReadAllBytes($Executable)
if ($bytes.Length -lt 64) { throw "Windows executable is truncated: $Executable" }
$peOffset = [System.BitConverter]::ToInt32($bytes, 0x3c)
if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length) { throw "Windows executable has an invalid PE header: $Executable" }
if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
  throw "Windows executable is not a PE image: $Executable"
}
$machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
if ($machine -ne 0x8664) { throw "Windows executable must be x64; machine was 0x$('{0:x4}' -f $machine)" }
