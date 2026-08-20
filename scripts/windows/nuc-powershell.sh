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

The helper uses Windows PowerShell only to locate the real WinGet/MSIX
PowerShell 7 executable, then runs the supplied script with pwsh 7.
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

preamble='$ErrorActionPreference = '\''Stop'\''
$ProgressPreference = '\''SilentlyContinue'\''
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
'
inner_encoded=$(printf '%s\n%s\n' "$preamble" "$body" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\r\n')

bootstrap=$(cat <<EOF
\$ErrorActionPreference = 'Stop'
\$ProgressPreference = 'SilentlyContinue'
\$pwsh = \$env:PWSH_EXECUTABLE
if (-not \$pwsh -or -not (Test-Path -LiteralPath \$pwsh) -or \$pwsh -like '*WindowsApps\\pwsh.exe') {
  \$standard = Join-Path \$env:ProgramFiles 'PowerShell\\7\\pwsh.exe'
  if (Test-Path -LiteralPath \$standard) {
    \$pwsh = \$standard
  } else {
    \$pwsh = Get-ChildItem -LiteralPath (Join-Path \$env:ProgramFiles 'WindowsApps') -Directory -Force -ErrorAction SilentlyContinue |
      Where-Object Name -Like 'Microsoft.PowerShell_*' |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path \$_.FullName 'pwsh.exe' } |
      Where-Object { Test-Path -LiteralPath \$_ } |
      Select-Object -First 1
  }
}
if (-not \$pwsh) { throw 'A real PowerShell 7 executable was not found. Run the Windows installer first.' }
& \$pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand '$inner_encoded'
exit \$LASTEXITCODE
EOF
)
outer_encoded=$(printf '%s\n' "$bootstrap" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\r\n')

ssh "$host" "cd /mnt/c && '$bootstrap_exe' -NoLogo -NoProfile -NonInteractive -EncodedCommand '$outer_encoded'"
