#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  nuc-powershell path/to/script.ps1
  printf '%s\n' 'Get-Date' | nuc-powershell

Environment:
  WINDOWS_SSH_HOST                    SSH host (default: nuc)
  WINDOWS_BOOTSTRAP_POWERSHELL_EXE    Remote WSL path to Windows PowerShell 5.1

Windows PowerShell is used only to discover and to verify a real PowerShell 7
executable; the supplied script itself always runs under PowerShell 7. Every
candidate is executed before it is accepted, so an App Execution Alias that
cannot start PowerShell 7 is rejected rather than trusted. If no candidate
works the command fails with the list of places it looked.
EOF
  exit 2
}

if [[ $# -gt 1 ]]; then
  usage
fi

host="${WINDOWS_SSH_HOST:-nuc}"
bootstrap_exe="${WINDOWS_BOOTSTRAP_POWERSHELL_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

if [[ $# -eq 1 ]]; then
  [[ -f "$1" ]] || { echo "PowerShell script not found: $1" >&2; exit 2; }
  body=$(<"$1")
elif [[ ! -t 0 ]]; then
  body=$(cat)
else
  usage
fi

encode() {
  printf '%s' "$1" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\r\n'
}

# Run one snippet with the bootstrap Windows PowerShell and print its output.
bootstrap_ps() {
  ssh "$host" "cd /mnt/c && '$bootstrap_exe' -NoLogo -NoProfile -NonInteractive -EncodedCommand '$(encode "$1")'"
}

# PowerShell single-quoted literal: the only safe way to pass a path that may
# contain spaces or quotes into a snippet.
ps_literal() {
  printf "'%s'" "${1//\'/\'\'}"
}

# Candidate paths, most preferred first. Only paths that exist are printed.
candidates_ps='$ErrorActionPreference = '"'"'Stop'"'"'
$found = New-Object System.Collections.Generic.List[string]
$explicit = $env:PWSH_EXECUTABLE
if ($explicit -and (Test-Path -LiteralPath $explicit)) { $found.Add($explicit) }
$standard = Join-Path $env:ProgramFiles '"'"'PowerShell\7\pwsh.exe'"'"'
if (Test-Path -LiteralPath $standard) { $found.Add($standard) }
$package = Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction SilentlyContinue |
  Sort-Object Version -Descending | Select-Object -First 1
if ($package -and $package.InstallLocation) {
  $appx = Join-Path $package.InstallLocation '"'"'pwsh.exe'"'"'
  if (Test-Path -LiteralPath $appx) { $found.Add($appx) }
}
$command = Get-Command pwsh -All -ErrorAction SilentlyContinue | Select-Object -First 1
if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source)) { $found.Add($command.Source) }
$found'

# Accept a candidate only after it has actually started PowerShell 7.
version_ps='& "$env:CANDIDATE" -NoLogo -NoProfile -NonInteractive -Command '"'"'$PSVersionTable.PSVersion.Major'"'"''

pwsh_exe=""
tried=()
while IFS= read -r candidate; do
  [[ -n "$candidate" ]] || continue
  tried+=("$candidate")
  version=$(bootstrap_ps "\$env:CANDIDATE = $(ps_literal "$candidate"); $version_ps" 2>/dev/null | tr -d '\r' | tail -n 1 || true)
  if [[ "$version" == "7" ]]; then
    pwsh_exe="$candidate"
    break
  fi
  echo "Skipping $candidate: it did not start PowerShell 7 (reported '${version:-nothing}')" >&2
done < <(bootstrap_ps "$candidates_ps" | tr -d '\r')

if [[ -z "$pwsh_exe" ]]; then
  {
    echo "No PowerShell 7 executable was found or could be started on $host."
    echo "Looked at: \$env:PWSH_EXECUTABLE, \$env:ProgramFiles\\PowerShell\\7\\pwsh.exe,"
    echo "the Microsoft.PowerShell Appx install location, and 'Get-Command pwsh'."
    if [[ ${#tried[@]} -gt 0 ]]; then
      printf 'Tried and rejected: %s\n' "${tried[*]}"
    fi
    echo "Install PowerShell 7 on the Windows machine, or set PWSH_EXECUTABLE for the remote shell."
  } >&2
  exit 2
fi

preamble='$ErrorActionPreference = '\''Stop'\''
$ProgressPreference = '\''SilentlyContinue'\''
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
'
inner_encoded=$(printf '%s\n%s\n' "$preamble" "$body" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\r\n')

# The verified executable is started from the Windows PowerShell bootstrap, not
# from the WSL shell: a Windows path is not a WSL command, and a path with a
# space or a quote must not be spliced into a shell command. Both the path and
# the payload are passed as PowerShell literals inside an encoded snippet.
bootstrap_ps "\$exe = $(ps_literal "$pwsh_exe")
& \$exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '$inner_encoded'
exit \$LASTEXITCODE"
