[CmdletBinding()]
param(
  [ValidateSet('Embed', 'EmbedAndValidate', 'Validate')]
  [string]$Mode = 'Validate',
  [Parameter(Mandatory = $true)]
  [string]$Executable,
  [string]$Icon
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($null -eq ('KeposWindowsIconResources' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class KeposWindowsIconResources
{
    private const int RT_ICON = 3;
    private const int RT_GROUP_ICON = 14;
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
    private const uint LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x00000020;

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate bool EnumResourceTypesCallback(IntPtr module, IntPtr type, IntPtr parameter);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate bool EnumResourceNamesCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);

    [DllImport("kernel32.dll", EntryPoint = "BeginUpdateResourceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string fileName, [MarshalAs(UnmanagedType.Bool)] bool deleteExistingResources);

    [DllImport("kernel32.dll", EntryPoint = "UpdateResourceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint dataSize);

    [DllImport("kernel32.dll", EntryPoint = "EndUpdateResourceW", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, [MarshalAs(UnmanagedType.Bool)] bool discard);

    [DllImport("kernel32.dll", EntryPoint = "LoadLibraryExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll", EntryPoint = "EnumResourceTypesW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceTypes(IntPtr module, EnumResourceTypesCallback callback, IntPtr parameter);

    [DllImport("kernel32.dll", EntryPoint = "EnumResourceNamesW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResourceNamesCallback callback, IntPtr parameter);

    [DllImport("kernel32.dll", EntryPoint = "FindResourceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LockResource(IntPtr resource);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr resource);

    [DllImport("shell32.dll", EntryPoint = "ExtractIconExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint ExtractIconEx(string fileName, int iconIndex, IntPtr[] largeIcons, IntPtr[] smallIcons, uint iconCount);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr icon);

    public static IntPtr Begin(string fileName)
    {
        return BeginUpdateResource(fileName, false);
    }

    public static bool UpdateIcon(IntPtr update, ushort resourceId, byte[] data)
    {
        return UpdateResource(update, MakeIntResource(3), MakeIntResource(resourceId), 0, data, checked((uint)data.Length));
    }

    public static bool UpdateGroup(IntPtr update, ushort resourceId, byte[] data)
    {
        return UpdateResource(update, MakeIntResource(14), MakeIntResource(resourceId), 0, data, checked((uint)data.Length));
    }

    public static bool End(IntPtr update, bool discard)
    {
        return EndUpdateResource(update, discard);
    }

    public static void Validate(string fileName)
    {
        IntPtr module = LoadLibraryEx(fileName, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (module == IntPtr.Zero) throw Win32("LoadLibraryExW");

        try
        {
            bool hasIcon = false;
            bool hasGroup = false;
            EnumResourceTypesCallback typeCallback = delegate(IntPtr ignoredModule, IntPtr type, IntPtr ignoredParameter)
            {
                if (IsResourceId(type, RT_ICON)) hasIcon = true;
                if (IsResourceId(type, RT_GROUP_ICON)) hasGroup = true;
                return true;
            };
            if (!EnumResourceTypes(module, typeCallback, IntPtr.Zero)) throw Win32("EnumResourceTypesW");
            if (!hasIcon || !hasGroup)
            {
                throw new InvalidDataException("the executable must contain both RT_ICON and RT_GROUP_ICON resources");
            }

            var groups = new List<IntPtr>();
            EnumResourceNamesCallback nameCallback = delegate(IntPtr ignoredModule, IntPtr ignoredType, IntPtr name, IntPtr ignoredParameter)
            {
                groups.Add(name);
                return true;
            };
            if (!EnumResourceNames(module, MakeIntResource(RT_GROUP_ICON), nameCallback, IntPtr.Zero))
            {
                throw Win32("EnumResourceNamesW");
            }
            if (groups.Count == 0) throw new InvalidDataException("the executable has no RT_GROUP_ICON resource names");

            foreach (IntPtr groupName in groups)
            {
                byte[] group = ReadResource(module, groupName, MakeIntResource(RT_GROUP_ICON));
                if (group.Length < 6) throw new InvalidDataException("RT_GROUP_ICON is truncated");
                if (BitConverter.ToUInt16(group, 0) != 0 || BitConverter.ToUInt16(group, 2) != 1)
                {
                    throw new InvalidDataException("RT_GROUP_ICON has an invalid header");
                }
                int count = BitConverter.ToUInt16(group, 4);
                if (count == 0 || group.Length < 6 + (count * 14))
                {
                    throw new InvalidDataException("RT_GROUP_ICON has invalid image entries");
                }

                for (int index = 0; index < count; index++)
                {
                    int offset = 6 + (index * 14);
                    uint expectedSize = BitConverter.ToUInt32(group, offset + 8);
                    ushort iconId = BitConverter.ToUInt16(group, offset + 12);
                    if (iconId == 0 || expectedSize == 0)
                    {
                        throw new InvalidDataException("RT_GROUP_ICON contains an invalid image reference");
                    }
                    IntPtr iconResource = FindResource(module, MakeIntResource(iconId), MakeIntResource(RT_ICON));
                    if (iconResource == IntPtr.Zero) throw Win32("FindResourceW(RT_ICON)");
                    uint actualSize = SizeofResource(module, iconResource);
                    if (actualSize == 0 || actualSize != expectedSize)
                    {
                        throw new InvalidDataException("RT_GROUP_ICON image size does not match its RT_ICON resource");
                    }
                }
            }

            IntPtr[] large = new IntPtr[1];
            IntPtr[] small = new IntPtr[1];
            uint extracted = ExtractIconEx(fileName, 0, large, small, 1);
            try
            {
                if (extracted < 1 || large[0] == IntPtr.Zero || small[0] == IntPtr.Zero)
                {
                    throw new InvalidDataException("ExtractIconExW could not extract both large and small icons");
                }
            }
            finally
            {
                if (large[0] != IntPtr.Zero) DestroyIcon(large[0]);
                if (small[0] != IntPtr.Zero) DestroyIcon(small[0]);
            }
        }
        finally
        {
            FreeLibrary(module);
        }
    }

    private static IntPtr MakeIntResource(int value)
    {
        return new IntPtr(value);
    }

    private static bool IsResourceId(IntPtr value, int expected)
    {
        return (value.ToInt64() >> 16) == 0 && (value.ToInt64() & 0xffff) == expected;
    }

    private static byte[] ReadResource(IntPtr module, IntPtr name, IntPtr type)
    {
        IntPtr resource = FindResource(module, name, type);
        if (resource == IntPtr.Zero) throw Win32("FindResourceW");
        uint size = SizeofResource(module, resource);
        IntPtr loaded = LoadResource(module, resource);
        IntPtr address = loaded == IntPtr.Zero ? IntPtr.Zero : LockResource(loaded);
        if (size == 0 || address == IntPtr.Zero) throw Win32("LoadResource");
        byte[] bytes = new byte[checked((int)size)];
        Marshal.Copy(address, bytes, 0, checked((int)size));
        return bytes;
    }

    private static Exception Win32(string operation)
    {
        int error = Marshal.GetLastWin32Error();
        return new InvalidDataException(operation + " failed with Win32 error " + error);
    }
}
'@
}

function Get-RegularFile {
  param([Parameter(Mandatory = $true)] [string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "icon input must be a regular file: $Path"
  }
  return $item
}

function Set-UInt16 {
  param(
    [Parameter(Mandatory = $true)] [byte[]]$Buffer,
    [Parameter(Mandatory = $true)] [int]$Offset,
    [Parameter(Mandatory = $true)] [uint16]$Value
  )
  [Array]::Copy([BitConverter]::GetBytes($Value), 0, $Buffer, $Offset, 2)
}

function Set-UInt32 {
  param(
    [Parameter(Mandatory = $true)] [byte[]]$Buffer,
    [Parameter(Mandatory = $true)] [int]$Offset,
    [Parameter(Mandatory = $true)] [uint32]$Value
  )
  [Array]::Copy([BitConverter]::GetBytes($Value), 0, $Buffer, $Offset, 4)
}

function Read-UInt16 {
  param([byte[]]$Buffer, [int]$Offset)
  return [BitConverter]::ToUInt16($Buffer, $Offset)
}

function Read-UInt32 {
  param([byte[]]$Buffer, [int]$Offset)
  return [BitConverter]::ToUInt32($Buffer, $Offset)
}

function Embed-IconResources {
  param(
    [Parameter(Mandatory = $true)] [string]$ExecutablePath,
    [Parameter(Mandatory = $true)] [string]$IconPath
  )
  $iconFile = Get-RegularFile $IconPath
  if ($iconFile.Length -lt 6) { throw "ICO file is truncated: $IconPath" }
  $ico = [System.IO.File]::ReadAllBytes($IconPath)
  if ((Read-UInt16 $ico 0) -ne 0 -or (Read-UInt16 $ico 2) -ne 1) {
    throw "ICO file has an invalid header: $IconPath"
  }
  $count = [int](Read-UInt16 $ico 4)
  if ($count -lt 1 -or $ico.Length -lt 6 + (16 * $count)) {
    throw "ICO file has no complete image directory: $IconPath"
  }

  $entries = @()
  for ($index = 0; $index -lt $count; $index++) {
    $offset = 6 + (16 * $index)
    $size = [uint32](Read-UInt32 $ico ($offset + 8))
    $imageOffset = [uint32](Read-UInt32 $ico ($offset + 12))
    if ($size -eq 0 -or $imageOffset -gt [uint32]$ico.Length -or $size -gt [uint32]($ico.Length - $imageOffset)) {
      throw "ICO file has an image outside its data: $IconPath"
    }
    $data = New-Object byte[] ([int]$size)
    [Array]::Copy($ico, [int]$imageOffset, $data, 0, [int]$size)
    $entries += [pscustomobject]@{
      Width = $ico[$offset]
      Height = $ico[$offset + 1]
      ColorCount = $ico[$offset + 2]
      Reserved = $ico[$offset + 3]
      Planes = [uint16](Read-UInt16 $ico ($offset + 4))
      BitCount = [uint16](Read-UInt16 $ico ($offset + 6))
      Size = $size
      Data = $data
      ResourceId = [uint16]($index + 1)
    }
  }

  $update = [KeposWindowsIconResources]::Begin($ExecutablePath)
  if ($update -eq [IntPtr]::Zero) {
    throw "BeginUpdateResourceW failed for $ExecutablePath (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  $finished = $false
  try {
    foreach ($entry in $entries) {
      if (-not [KeposWindowsIconResources]::UpdateIcon($update, $entry.ResourceId, $entry.Data)) {
        throw "UpdateResourceW failed for RT_ICON $($entry.ResourceId) (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
      }
    }

    $group = New-Object byte[] (6 + (14 * $entries.Count))
    Set-UInt16 $group 0 0
    Set-UInt16 $group 2 1
    Set-UInt16 $group 4 ([uint16]$entries.Count)
    for ($index = 0; $index -lt $entries.Count; $index++) {
      $entry = $entries[$index]
      $offset = 6 + (14 * $index)
      $group[$offset] = $entry.Width
      $group[$offset + 1] = $entry.Height
      $group[$offset + 2] = $entry.ColorCount
      $group[$offset + 3] = $entry.Reserved
      Set-UInt16 $group ($offset + 4) $entry.Planes
      Set-UInt16 $group ($offset + 6) $entry.BitCount
      Set-UInt32 $group ($offset + 8) $entry.Size
      Set-UInt16 $group ($offset + 12) $entry.ResourceId
    }
    if (-not [KeposWindowsIconResources]::UpdateGroup($update, 1, $group)) {
      throw "UpdateResourceW failed for RT_GROUP_ICON (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
    if (-not [KeposWindowsIconResources]::End($update, $false)) {
      throw "EndUpdateResourceW failed for $ExecutablePath (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
    $finished = $true
  } finally {
    if (-not $finished) {
      [KeposWindowsIconResources]::End($update, $true) | Out-Null
    }
  }
}

function Validate-IconResources {
  param([Parameter(Mandatory = $true)] [string]$ExecutablePath)
  Get-RegularFile $ExecutablePath | Out-Null
  [KeposWindowsIconResources]::Validate($ExecutablePath)
}

$executableFile = Get-RegularFile $Executable
if ($Mode -eq 'Embed' -or $Mode -eq 'EmbedAndValidate') {
  if ([string]::IsNullOrWhiteSpace($Icon)) { throw "-Icon is required for $Mode" }
  Embed-IconResources $executableFile.FullName ([System.IO.Path]::GetFullPath($Icon))
  Write-Host "Embedded Kepos icon resources: $($executableFile.FullName)"
}
if ($Mode -eq 'Validate' -or $Mode -eq 'EmbedAndValidate') {
  Validate-IconResources $executableFile.FullName
  Write-Host "Validated native Kepos icon resources: $($executableFile.FullName)"
}
