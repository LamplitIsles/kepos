#!/usr/bin/env bash
set -euo pipefail

# Build the checked-out Kepos tree on the designated Windows host. WSL is only
# the control plane; all Node, Bare, CMake, and MSVC work happens in PowerShell.
readonly HOST="nuc-kep"
readonly POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
readonly WINDOWS_USER="${WINDOWS_USER:?set WINDOWS_USER to the Windows account used for dogfood}"
readonly WINDOWS_HOME="/mnt/c/Users/${WINDOWS_USER}"
readonly WINDOWS_TOOLS="${WINDOWS_HOME}/.local/kepos-tools"
readonly WINDOWS_BUILDS="${WINDOWS_HOME}/.local/kepos-build"
readonly WINDOWS_ROOT="C:\\Users\\${WINDOWS_USER}"
readonly SCRIPT_NAME="build-kepos.ps1"
readonly LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly LOCAL_OUTPUT="${LOCAL_ROOT}/dist/windows/${RUN_ID}"
readonly REMOTE_RUN="${WINDOWS_BUILDS}/${RUN_ID}"
readonly WINDOWS_SCRIPT="${WINDOWS_TOOLS}/${SCRIPT_NAME}"

shell_quote() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

mkdir -p "$LOCAL_OUTPUT"

# Keep the transfer bounded to source and checked-in native submodules. Build
# output, caches, credentials, and live state never cross the SSH boundary.
tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.build' \
  --exclude='*/build' \
  --exclude='*/prebuilds' \
  -cf - -C "$LOCAL_ROOT" . |
  ssh "$HOST" "rm -rf '$REMOTE_RUN/source' && mkdir -p '$REMOTE_RUN/source' && tar -xf - -C '$REMOTE_RUN/source'"

scp "$LOCAL_ROOT/scripts/windows/$SCRIPT_NAME" \
  "$HOST:$WINDOWS_SCRIPT"

root_revision=$(git -C "$LOCAL_ROOT" rev-parse HEAD)
bare_native_revision=$(git -C "$LOCAL_ROOT/vendor/holepunch/bare-native" rev-parse HEAD)
bare_win_ui_revision=$(git -C "$LOCAL_ROOT/vendor/holepunch/bare-win-ui" rev-parse HEAD)
bare_app_kit_revision=$(git -C "$LOCAL_ROOT/vendor/holepunch/bare-app-kit" rev-parse HEAD)

remote_command=(
  "$POWERSHELL" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$WINDOWS_SCRIPT"
  -Repository "${WINDOWS_ROOT}\\.local\\kepos-build\\${RUN_ID}\\source"
  -RunDirectory "${WINDOWS_ROOT}\\.local\\kepos-build\\${RUN_ID}"
  -WorkspaceRoot "${WINDOWS_ROOT}\\.local\\kepos-build"
  -ToolsDirectory "${WINDOWS_ROOT}\\.local\\kepos-tools"
  -RunId "$RUN_ID"
  -RootRevision "$root_revision"
  -BareNativeRevision "$bare_native_revision"
  -BareWinUiRevision "$bare_win_ui_revision"
  -BareAppKitRevision "$bare_app_kit_revision"
)
remote_string=""
for argument in "${remote_command[@]}"; do
  remote_string+=" $(shell_quote "$argument")"
done

set +e
ssh "$HOST" "$remote_string"
status=$?
set -e

# Retrieval is deliberately limited to this run's owned directory. Keep logs
# on failure so a missing Windows tool is actionable from the Mac.
scp -r "$HOST:${REMOTE_RUN}/logs" "$LOCAL_OUTPUT/" 2>/dev/null || true
if [[ $status -eq 0 ]]; then
  scp -r "$HOST:${REMOTE_RUN}/dist/desktop" "$LOCAL_OUTPUT/"
  printf 'Windows artifact: %s\n' "$LOCAL_OUTPUT/desktop"
else
  printf 'Windows build failed; diagnostics: %s\n' "$LOCAL_OUTPUT/logs" >&2
fi
exit "$status"
