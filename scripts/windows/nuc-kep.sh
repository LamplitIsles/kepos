#!/usr/bin/env bash
set -euo pipefail

# Build the checked-out Kepos tree on the designated Windows host. WSL is only
# the control plane; all Node, Bare, CMake, and MSVC work happens in PowerShell.
readonly HOST="nuc-kep"
readonly POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
readonly WINDOWS_USER="${WINDOWS_USER:?set WINDOWS_USER to the Windows account used for dogfood}"
readonly WINDOWS_BUILDS="/mnt/c/kb"
readonly WINDOWS_ROOT="C:\\Users\\${WINDOWS_USER}"
readonly WINDOWS_BUILD_ROOT="C:\\kb"
readonly WINDOWS_SCRIPT="${WINDOWS_BUILD_ROOT}\\source\\scripts\\windows\\build-kepos.ps1"
readonly REMOTE_LOCK="/tmp/kepos-nuc-kep.lock"
LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly LOCAL_ROOT
readonly TRACKED_MANIFEST="${LOCAL_ROOT}/scripts/windows/tracked-manifest.sh"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID
readonly LOCAL_OUTPUT="${LOCAL_ROOT}/dist/windows/${RUN_ID}"
readonly REMOTE_RUN="${WINDOWS_BUILDS}/${RUN_ID}"
readonly REMOTE_SOURCE="${WINDOWS_BUILDS}/source"
TRANSFER_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/kepos-windows-transfer.XXXXXX.tar")"
readonly TRANSFER_ARCHIVE

shell_quote() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

# shellcheck disable=SC2329 # Invoked indirectly by EXIT trap.
cleanup_transfer_archive() {
  rm -f -- "$TRANSFER_ARCHIVE"
}
trap cleanup_transfer_archive EXIT

require_initialized_submodules() {
  local record mode path submodule status_line
  while IFS= read -r -d '' record; do
    mode=${record%%$'\t'*}
    path=${record#*$'\t'}
    if [[ ${mode%% *} != 160000 ]]; then continue; fi
    submodule="${LOCAL_ROOT}/${path}"
    if [[ ! -d "$submodule" ]] || ! git -C "$submodule" rev-parse --verify 'HEAD^{commit}' >/dev/null 2>&1; then
      printf 'Required submodule content is absent: %s\n' "$path" >&2
      return 1
    fi
  done < <(git -C "$LOCAL_ROOT" ls-files --stage -z)

  while IFS= read -r status_line; do
    [[ -z "$status_line" ]] && continue
    if [[ ${status_line:0:1} != " " ]]; then
      printf 'Required submodule is not at an available checked-out revision: %s\n' "$status_line" >&2
      return 1
    fi
  done < <(git -C "$LOCAL_ROOT" submodule status --recursive)
}

mkdir -p "$LOCAL_OUTPUT"
require_initialized_submodules
root_revision=$(git -C "$LOCAL_ROOT" rev-parse HEAD)
bare_native_revision=$(git -C "$LOCAL_ROOT/vendor/holepunch/bare-native" rev-parse HEAD)
bare_win_ui_revision=$(git -C "$LOCAL_ROOT/vendor/holepunch/bare-win-ui" rev-parse HEAD)
bare_app_kit_revision=$(git -C "$LOCAL_ROOT/vendor/holepunch/bare-app-kit" rev-parse HEAD)

# Archive Git's cached recursive manifest, never the working tree. Paths are
# NUL-safe, so ignored/untracked .env, .npmrc, caches, and live state cannot enter.
bash "$TRACKED_MANIFEST" "$LOCAL_ROOT" |
  COPYFILE_DISABLE=1 tar --no-xattrs --null --no-recursion -cf "$TRANSFER_ARCHIVE" -C "$LOCAL_ROOT" -T -

# One non-blocking WSL-host lock covers source replacement, PowerShell build,
# native probe, staging, and PowerShell cleanup. Concurrent calls fail visibly.
remote_command=()
remote_command+=("$POWERSHELL" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$WINDOWS_SCRIPT")
remote_command+=(-Repository "${WINDOWS_BUILD_ROOT}\\source")
remote_command+=(-RunDirectory "${WINDOWS_BUILD_ROOT}\\${RUN_ID}")
remote_command+=(-WorkspaceRoot "$WINDOWS_BUILD_ROOT")
remote_command+=(-ToolsDirectory "${WINDOWS_ROOT}\\.local\\kepos-tools")
remote_command+=(-RunId "$RUN_ID")
remote_command+=(-RootRevision "$root_revision")
remote_command+=(-BareNativeRevision "$bare_native_revision")
remote_command+=(-BareWinUiRevision "$bare_win_ui_revision")
remote_command+=(-BareAppKitRevision "$bare_app_kit_revision")
remote_powershell=""
for argument in "${remote_command[@]}"; do remote_powershell+=" $(shell_quote "$argument")"; done

remote_payload="set -euo pipefail
exec 9>$(shell_quote "$REMOTE_LOCK")
if ! flock -n 9; then
  printf '%s\\n' 'Another Kepos Windows workflow is already running on this host.' >&2
  exit 75
fi
rm -rf -- $(shell_quote "$REMOTE_SOURCE")
mkdir -p -- $(shell_quote "$REMOTE_SOURCE")
tar --extract --file=- --directory=$(shell_quote "$REMOTE_SOURCE")
$remote_powershell"

set +e
# shellcheck disable=SC2029 # The quoted payload is intentionally built locally.
ssh "$HOST" "bash -c $(shell_quote "$remote_payload")" < "$TRANSFER_ARCHIVE"
status=$?
set -e

scp -r "$HOST:${REMOTE_RUN}/logs" "$LOCAL_OUTPUT/" 2>/dev/null || true
if [[ $status -eq 0 ]]; then
  scp -r "$HOST:${REMOTE_RUN}/dist/desktop" "$LOCAL_OUTPUT/"
  printf 'Windows artifact: %s\n' "$LOCAL_OUTPUT/desktop"
elif [[ $status -eq 75 ]]; then
  printf 'Windows build refused: another invocation owns the host mutex\n' >&2
else
  printf 'Windows build failed; diagnostics: %s\n' "$LOCAL_OUTPUT/logs" >&2
fi
exit "$status"
