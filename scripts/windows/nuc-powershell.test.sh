#!/usr/bin/env bash
# Behavioural test for scripts/windows/nuc-powershell.sh.
#
# The wrapper is exercised with a fake `ssh` on PATH, so the discovery order,
# the PowerShell 7 verification and the failure message are tested without a
# Windows host, without a real SSH connection and without installing anything.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
wrapper="$here/nuc-powershell.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
cat >"$work/bin/ssh" <<'FAKE'
#!/usr/bin/env bash
# $1 host, $2 remote command. The wrapper always sends one PowerShell snippet.
command_text="$2"
encoded=$(printf '%s' "$command_text" | sed -n "s/.*-EncodedCommand '\([^']*\)'.*/\1/p")
if [[ -z "$encoded" ]]; then
  echo "fake ssh: no EncodedCommand in: $command_text" >&2
  exit 3
fi
snippet=$(printf '%s' "$encoded" | base64 -d | iconv -f UTF-16LE -t UTF-8)

if [[ "$snippet" == *PSVersionTable* ]]; then
  # The wrapper captures this output, so record the probe separately for the
  # test to inspect.
  printf 'PROBE:%s\n' "$(printf '%s' "$snippet" | head -n 1)" >>"${FAKE_LOG:-/dev/null}"
  candidate=$(printf '%s' "$snippet" | sed -n "s/.*CANDIDATE = '\(.*\)'; & .*/\1/p" | sed "s/''/'/g")
  case "$candidate" in
    *"$FAKE_GOOD_SUFFIX") echo "${FAKE_GOOD_VERSION:-7}" ;;
    *) echo "${FAKE_BAD_VERSION:-5}" ;;
  esac
  exit 0
fi

if [[ "$snippet" == *Get-AppxPackage* ]]; then
  printf '%s\n' "$FAKE_CANDIDATES"
  exit 0
fi

# The user script: report the bootstrap command and the decoded payload.
inner=$(printf '%s' "$snippet" | sed -n "s/.*-EncodedCommand '\([^']*\)'.*/\1/p" | tail -n 1)
echo "RAN-WITH:$command_text"
echo "OUTER:$(printf '%s' "$snippet" | tr '\n' ' ')"
if [[ -n "$inner" ]]; then
  echo "INNER:$(printf '%s' "$inner" | base64 -d | iconv -f UTF-16LE -t UTF-8 | tail -n 2 | tr '\n' ' ')"
fi
FAKE
chmod +x "$work/bin/ssh"

fail=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "ok   $label"
  else
    echo "FAIL $label: expected '$expected' in: $actual" >&2
    fail=1
  fi
}

run_wrapper() {
  PATH="$work/bin:$PATH" WINDOWS_SSH_HOST=fake FAKE_LOG="$work/probe.log" \
    FAKE_CANDIDATES="$1" FAKE_GOOD_SUFFIX="$2" \
    bash "$wrapper" <<<"Get-Date" 2>&1 || true
}

# 1. The first candidate that starts PowerShell 7 is used.
out=$(run_wrapper "/opt/ps7/pwsh.exe
/alias/WindowsApps/pwsh.exe" "/opt/ps7/pwsh.exe")
check "prefers a verified standard install" "RAN-WITH:" "$out"
check "runs the user script with the standard install" "\$exe = '/opt/ps7/pwsh.exe'" "$out"
check "goes through the Windows PowerShell bootstrap" "powershell.exe" "$out"
check "carries the decoded user script" "Get-Date" "$out"

# 2. A candidate that reports PowerShell 5 is rejected and the next one is used.
out=$(run_wrapper "/stale/pwsh.exe
/alias/WindowsApps/pwsh.exe" "/alias/WindowsApps/pwsh.exe")
check "skips a candidate that is not PowerShell 7" "Skipping /stale/pwsh.exe" "$out"
check "falls through to the alias after verification" "\$exe = '/alias/WindowsApps/pwsh.exe'" "$out"

# 3. With nothing usable the command fails and says where it looked.
out=$(run_wrapper "" "")
check "reports that no PowerShell 7 was found" "No PowerShell 7 executable was found" "$out"
check "lists the searched locations" "Get-Command pwsh" "$out"
check "does not run the user script" "" "$(printf '%s' "$out" | grep -c RAN-WITH || true)"

# 4. A path with a space and a single quote stays one PowerShell literal.
out=$(run_wrapper "/Program Files/it's pwsh/pwsh.exe" "/Program Files/it's pwsh/pwsh.exe")
check "quotes the executable as a PowerShell literal" "\$exe = '/Program Files/it''s pwsh/pwsh.exe'" "$out"
# The same escaping must be used by the version probe, which runs before the
# executable is accepted; an unescaped quote there would break the probe and
# could inject PowerShell.
check "quotes the candidate in the version probe" \
  "CANDIDATE = '/Program Files/it''s pwsh/pwsh.exe'" "$(cat "$work/probe.log" 2>/dev/null)"

if [[ $fail -ne 0 ]]; then
  echo "nuc-powershell wrapper tests failed" >&2
  exit 1
fi
echo "nuc-powershell wrapper tests passed"
