#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
cache="${KEPOS_SWIFT_MODULE_CACHE:?Set KEPOS_SWIFT_MODULE_CACHE to an existing approved Swift module cache}"
[[ "$(uname -s)" == Linux && -d "$cache" ]] || { echo 'Linux and an existing approved module cache are required.' >&2; exit 1; }
cache="$(cd "$cache" && pwd)"
work=$(mktemp -d "${TMPDIR:-/tmp}/kepos-vpn-manager-test.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
export TMPDIR="$work" CLANG_MODULE_CACHE_PATH="$cache" SWIFT_MODULECACHE_PATH="$cache"
mkdir "$work/KeposHarness.app"
cp "$repo/apps/macos/Tests/Manager/Info.plist" "$work/KeposHarness.app/Info.plist"
common=(swiftc -swift-version 5 -j 1 -module-cache-path "$cache")
unshare -Ur -n "${common[@]}" -emit-library -emit-module -module-name NetworkExtension \
  "$repo/apps/macos/Tests/Manager/NetworkExtension.swift" -o "$work/libNetworkExtension.so" \
  -emit-module-path "$work/NetworkExtension.swiftmodule"
sources=(VPNControl ManagedStateMessage ProviderStatus StatusDiagnostics ConnectionMonitor TunnelLifecycle VPNController)
for name in "${!sources[@]}"; do sources[$name]="$repo/apps/macos/Sources/KeposVPN/${sources[$name]}.swift"; done
unshare -Ur -n "${common[@]}" -parse-as-library -I "$work" -L "$work" -lNetworkExtension \
  -Xlinker -rpath -Xlinker "$work" "${sources[@]}" \
  "$repo/apps/macos/Tests/Manager/main.swift" -o "$work/KeposHarness.app/KeposHarness"
unshare -Ur -n "$work/KeposHarness.app/KeposHarness"
