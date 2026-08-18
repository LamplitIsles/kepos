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
TRANSFER_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/kepos-windows-transfer.XXXXXX")"
readonly TRANSFER_ARCHIVE
PARTIAL_ARTIFACT=""

RELEASE_MODE="dogfood"
RELEASE_TAG=""
if [[ $# -gt 0 ]]; then
  if [[ $# -ne 1 && $# -ne 2 ]] || [[ ${2:-} != "--rehearsal" ]]; then
    printf '%s\n' 'usage: nuc-kep.sh [vMAJOR.MINOR.PATCH [--rehearsal]]' >&2
    exit 2
  fi
  RELEASE_TAG=$1
  if [[ ! $RELEASE_TAG =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    printf 'invalid release tag: %s\n' "$RELEASE_TAG" >&2
    exit 2
  fi
  RELEASE_MODE="release"
  [[ $# -eq 2 ]] && RELEASE_MODE="rehearsal"
fi
readonly RELEASE_MODE RELEASE_TAG
if [[ -n $RELEASE_TAG ]]; then
  if [[ $RELEASE_MODE == release ]]; then
    RELEASE_DIRECTORY="${LOCAL_ROOT}/dist/release/${RELEASE_TAG}"
  else
    RELEASE_DIRECTORY="${LOCAL_ROOT}/dist/release/rehearsal-${RELEASE_TAG}"
  fi
  readonly RELEASE_DIRECTORY
  readonly RELEASE_ARTIFACT_NAME="kepos-windows-x64.zip"
  if ! (
    cd "$LOCAL_ROOT"
    node --import tsx --input-type=module -e 'import { parseReleaseTag } from "./scripts/release-version.ts"; parseReleaseTag(process.argv[1], process.argv[2]);' "$RELEASE_TAG" "$RELEASE_MODE"
  ); then
    printf 'release tag is outside the shared artifact contract: %s\n' "$RELEASE_TAG" >&2
    exit 2
  fi
  PARTIAL_ARTIFACT="$RELEASE_DIRECTORY/${RELEASE_ARTIFACT_NAME}.partial"
else
  RELEASE_DIRECTORY=""
  RELEASE_ARTIFACT_NAME=""
fi

# shellcheck disable=SC2329 # Invoked indirectly by INT/TERM traps.
cleanup_interrupted_release() {
  if [[ -n $RELEASE_TAG ]]; then
    rm -f -- "$RELEASE_DIRECTORY/${RELEASE_ARTIFACT_NAME}.partial" "$RELEASE_DIRECTORY/$RELEASE_ARTIFACT_NAME"
  fi
}
if [[ -n $RELEASE_TAG ]]; then
  trap cleanup_interrupted_release INT TERM
fi

shell_quote() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

# shellcheck disable=SC2329 # Invoked indirectly by EXIT trap.
cleanup_local_temporary_files() {
  rm -f -- "$TRANSFER_ARCHIVE"
  if [[ -n $PARTIAL_ARTIFACT ]]; then rm -f -- "$PARTIAL_ARTIFACT"; fi
}
trap cleanup_local_temporary_files EXIT

require_clean_repository_tree() {
  local status_line
  while IFS= read -r status_line; do
    [[ -z "$status_line" ]] && continue
    printf 'root or submodule worktree is dirty (including second-column dirt): %s\n' "$status_line" >&2
    return 1
  done < <(git -C "$LOCAL_ROOT" status --porcelain=v1 --untracked-files=all --ignore-submodules=none)

  while IFS= read -r status_line; do
    [[ -z "$status_line" ]] && continue
    if [[ ${status_line:0:1} != " " ]]; then
      printf 'required submodule is not cleanly initialized: %s\n' "$status_line" >&2
      return 1
    fi
  done < <(git -C "$LOCAL_ROOT" submodule status --recursive)

  # foreach supplies the gitlink SHA as $sha1. This catches both a checked-out
  # nested commit that differs from the superproject index and dirty nested
  # indexes/worktrees, which a root-only status can otherwise summarize poorly.
  # shellcheck disable=SC2016 # $sha1 and $displaypath are git-submodule variables.
  if ! git -C "$LOCAL_ROOT" submodule foreach --recursive '
    if [[ "$(git rev-parse HEAD)" != "$sha1" ]]; then
      printf "cached/worktree submodule mismatch: %s (expected %s, got %s)\\n" "$displaypath" "$sha1" "$(git rev-parse HEAD)" >&2
      exit 1
    fi
    if [[ -n "$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none)" ]]; then
      printf "nested submodule worktree is dirty: %s\\n" "$displaypath" >&2
      exit 1
    fi
  '; then
    return 1
  fi
}

mkdir -p "$LOCAL_OUTPUT"
require_clean_repository_tree
if [[ -n $RELEASE_TAG ]]; then
  if [[ -e "$RELEASE_DIRECTORY/$RELEASE_ARTIFACT_NAME" ]]; then
    printf 'release output already exists: %s\n' "$RELEASE_DIRECTORY/$RELEASE_ARTIFACT_NAME" >&2
    exit 1
  fi
  if [[ -n $(git -C "$LOCAL_ROOT" status --porcelain) ]]; then
    printf '%s\n' 'release worktree must be clean' >&2
    exit 1
  fi
  if [[ -d "$RELEASE_DIRECTORY" ]]; then
    while IFS= read -r -d '' existing; do
      case "$(basename "$existing")" in
        "kepos-android-arm64.apk"|"kepos-macos-arm64.zip") ;;
        *) printf 'unexpected release output: %s\n' "$existing" >&2; exit 1 ;;
      esac
    done < <(find "$RELEASE_DIRECTORY" -mindepth 1 -maxdepth 1 -print0)
  else
    mkdir -p "$RELEASE_DIRECTORY"
  fi
  if [[ $RELEASE_MODE == release ]]; then
    if [[ $(git -C "$LOCAL_ROOT" cat-file -t "$RELEASE_TAG" 2>/dev/null) != tag ]]; then
      printf 'release tag must be an annotated tag: %s\n' "$RELEASE_TAG" >&2
      exit 1
    fi
    root_revision=$(git -C "$LOCAL_ROOT" rev-parse "$RELEASE_TAG^{commit}")
    head_revision=$(git -C "$LOCAL_ROOT" rev-parse HEAD)
    if [[ $root_revision != "$head_revision" ]]; then
      printf 'release tag %s does not resolve to local HEAD\n' "$RELEASE_TAG" >&2
      exit 1
    fi
  else
    root_revision=$(git -C "$LOCAL_ROOT" rev-parse HEAD)
  fi
else
  root_revision=$(git -C "$LOCAL_ROOT" rev-parse HEAD)
fi
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
if [[ -n $RELEASE_TAG ]]; then
  remote_origin=$(git -C "$LOCAL_ROOT" remote get-url origin)
  if [[ $remote_origin =~ ^https?://[^/]*@ || $remote_origin =~ ^[^:]+://[^/]*: ]]; then
    printf '%s\n' 'origin URL must not contain credentials' >&2
    exit 1
  fi
  remote_command+=(-Workflow release -ReleaseTag "$RELEASE_TAG" -ReleaseMode "$RELEASE_MODE" -RemoteOrigin "$remote_origin" -ReleaseArtifactName "$RELEASE_ARTIFACT_NAME")
fi
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

log_transfer_status=0
if ! scp -r "$HOST:${REMOTE_RUN}/logs" "$LOCAL_OUTPUT/" 2>/dev/null; then
  sleep 1
  if ! scp -r "$HOST:${REMOTE_RUN}/logs" "$LOCAL_OUTPUT/" 2>/dev/null; then
    log_transfer_status=1
    printf 'Windows log retrieval failed; remote diagnostics remain at %s/logs\n' "$REMOTE_RUN" >&2
  fi
fi
if [[ $status -eq 0 && $log_transfer_status -ne 0 ]]; then status=1; fi
if [[ $status -eq 0 ]]; then
  if [[ -n $RELEASE_TAG ]]; then
    # The name was validated when the release mode was parsed; keep the
    # cleanup paths derived from that contained value only.
    partial_artifact="$RELEASE_DIRECTORY/${RELEASE_ARTIFACT_NAME}.partial"
    final_artifact="$RELEASE_DIRECTORY/${RELEASE_ARTIFACT_NAME}"
    set +e
    scp "$HOST:${REMOTE_RUN}/${RELEASE_ARTIFACT_NAME}" "$partial_artifact"
    transfer_status=$?
    set -e
    if [[ $transfer_status -ne 0 ]]; then
      rm -f -- "$partial_artifact" "$final_artifact"
      printf 'Windows artifact transfer failed; removed partial output\n' >&2
      exit "$transfer_status"
    fi
    if ! unzip -tq "$partial_artifact" >/dev/null; then
      rm -f -- "$partial_artifact" "$final_artifact"
      printf '%s\n' 'remote Windows ZIP failed local archive verification' >&2
      exit 1
    fi
    mv -- "$partial_artifact" "$final_artifact"
    printf 'Windows release artifact: %s\n' "$final_artifact"
  else
    scp -r "$HOST:${REMOTE_RUN}/dist/desktop" "$LOCAL_OUTPUT/"
    printf 'Windows artifact: %s\n' "$LOCAL_OUTPUT/desktop"
  fi
elif [[ $status -eq 75 ]]; then
  printf 'Windows build refused: another invocation owns the host mutex\n' >&2
else
  if [[ -n $RELEASE_TAG ]]; then rm -f -- "$RELEASE_DIRECTORY/$RELEASE_ARTIFACT_NAME" "$RELEASE_DIRECTORY/${RELEASE_ARTIFACT_NAME}.partial"; fi
  printf 'Windows build failed; diagnostics: %s\n' "$LOCAL_OUTPUT/logs" >&2
fi
exit "$status"
