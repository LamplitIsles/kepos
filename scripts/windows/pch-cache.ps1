Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Remove-CachedCMakePchOutputs {
  param([Parameter(Mandatory = $true)] [string]$CacheRoot)

  if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
    throw 'cached CMake files path must not be empty'
  }
  if (-not [System.IO.Path]::IsPathRooted($CacheRoot)) {
    throw "cached CMake files path must be absolute: $CacheRoot"
  }

  $root = [System.IO.Path]::GetFullPath($CacheRoot).TrimEnd('\', '/')
  $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer) {
    throw "cached CMake files path is not a directory: $root"
  }
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "cached CMake files contains a reparse point: $root"
  }

  $link = Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop |
    Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 } |
    Select-Object -First 1
  if ($null -ne $link) {
    throw "cached CMake files contains a reparse point: $($link.FullName)"
  }

  $removed = 0
  foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction Stop)) {
    if ($file.Name -like 'cmake_pch.hxx.*') {
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
      $removed++
    }
  }
  return $removed
}
