#!/usr/bin/env bash
set -euo pipefail

# Offline rebuild from the pinned, already prepared sources and prebuilds.
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
tools="$repo/scripts/ios-extension-safe"
v3="$tools/v3"
deps="$repo/.build/ios-deps"
base="$deps/bare-kit-swift-v2.2.0"
sources="$base/src"
case "${1:-}" in
  ios) target=ios-arm64; system=iOS; sdk_target=arm64-apple-ios; minimum=17.0; build="$base/build/cmake"; out="$base/extension-safe" ;;
  macos) target=darwin-arm64; system=Darwin; sdk_target=arm64-apple-macosx; minimum=15.0; build="$base/build/cmake-macos"; out="$base/extension-safe-macos" ;;
  *) echo 'Usage: build.sh ios|macos' >&2; exit 1 ;;
esac

[[ "$(uname -s)" == Linux ]] || { echo 'A Linux cross-build environment is required.' >&2; exit 1; }
usage=$(du -sb "$deps" "$HOME/.npm" | awk '{total += $1} END {print total}')
((usage + 1024 * 1024 * 1024 < 8 * 1024 * 1024 * 1024)) || {
  echo 'The build requires at least 1 GiB of the 8 GiB dependency budget free.' >&2; exit 1;
}
cmp -s "$v3/package-lock.json" "$base/tools/package-lock.json" || { echo 'The pinned build tools are missing.' >&2; exit 1; }
(cd "$base/archives" && sha256sum -c "$v3/source-archives.sha256")
(cd "$deps/src/archives" && sha256sum -c "$tools/source-archives.sha256")
(cd "$base/prebuilds" && grep "  $target/" "$v3/prebuilds.sha256" | sha256sum -c)
(cd "$deps/build/bare-kit/cmake/ucd/17.0.0" && sha256sum -c "$tools/unicode-17.sha256")
for name in bare-kit-swift bare-kit bare; do
  if ! patch -s -d "$sources/$name" -p1 --batch --reverse --dry-run < "$v3/$name.patch"; then
    echo "Expected patch is missing from $name; prepare the pinned source first." >&2; exit 1
  fi
done
patch -s -d "$base/tools/node_modules/cmake-ucd" -p1 --batch --reverse --dry-run < "$v3/cmake-ucd.patch" || {
  echo 'The offline Unicode generator patch is missing.' >&2; exit 1;
}
[[ "$(readlink -f "$base/build/bin/npm")" == /usr/bin/false && "$(readlink -f "$base/build/bin/npx")" == /usr/bin/false ]] || {
  echo 'The no-npm build tool wrappers are required.' >&2; exit 1;
}
sdk_config=$(swift sdk configure darwin "$sdk_target" --show-configuration)
sdk=$(printf '%s\n' "$sdk_config" | sed -n 's/^sdkRootPath: //p')
sdk_version=$(basename "$sdk" | sed -nE 's/^(iPhoneOS|MacOSX)([0-9.]+)\.sdk$/\2/p')
[[ -n "$sdk_version" && -d "$sdk" ]] || { echo 'A configured Apple SDK is required.' >&2; exit 1; }
swift_root=$(swiftc -print-target-info | python3 -c 'import json,sys; from pathlib import Path; print(Path(json.load(sys.stdin)["paths"]["runtimeResourcePath"]).parents[1])')
mkdir -p "$build/ucd/17.0.0"
while read -r _ file; do
  [[ -e "$build/ucd/17.0.0/$file" ]] || ln -s "$deps/build/bare-kit/cmake/ucd/17.0.0/$file" "$build/ucd/17.0.0/$file"
done < "$tools/unicode-17.sha256"
(cd "$build/ucd/17.0.0" && sha256sum -c "$tools/unicode-17.sha256")
if [[ -e "$build/project-version.cmake" ]]; then
  [[ "$(cat "$build/project-version.cmake")" == 'set(PROJECT_VERSION 2.2.0)' ]] || {
    echo 'Existing project version override differs.' >&2; exit 1;
  }
else
  printf 'set(PROJECT_VERSION 2.2.0)\n' > "$build/project-version.cmake"
fi
export PATH="$base/build/bin:$base/tools/node_modules/.bin:$deps/node_modules/.bin:$PATH"
export NODE_PATH="$base/tools/node_modules" NODE_OPTIONS=--max-old-space-size=512
export KEPOS_LD64="$repo/node_modules/.bin/ld64.lld" KEPOS_IOS_SDK_VERSION="$sdk_version"
if [[ "$system" == iOS ]]; then
  linker="$tools/ios-ld"; platform_flags=''; extra_cxx="--target=arm64-apple-ios$minimum -isysroot $sdk -miphoneos-version-min=$minimum"
else
  linker="$KEPOS_LD64"; platform_flags="-Wl,-platform_version,macos,$minimum,$sdk_version"; extra_cxx="--target=arm64-apple-macosx$minimum -isysroot $sdk -mmacosx-version-min=$minimum"
fi
sources_args=()
for name in bare-kit bare libuv libjs libnapi libbase64 libhex libidna libjstl liblog libnormalize libpunycode librlimit libudx liburl libutf boringssl libsodium; do
  owner=HOLEPUNCHTO; source="$deps/src/$name"
  case "$name" in libuv) owner=LIBUV ;; boringssl) owner=GOOGLE ;; libsodium) owner=JEDISCT1 ;; esac
  case "$name" in bare-kit|bare|libuv|libjs|libnapi) source="$sources/$name" ;; esac
  sources_args+=("-DFETCHCONTENT_SOURCE_DIR_GITHUB+${owner}+${name^^}=$source")
done
limit=(prlimit --as=3221225472 --fsize=536870912)
offline=(unshare -Ur -n)
"${limit[@]}" "${offline[@]}" "$deps/node_modules/.bin/cmake" -S "$sources/bare-kit-swift" -B "$build" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$deps/node_modules/.bin/ninja" -DCMAKE_SYSTEM_NAME="$system" -DCMAKE_SYSTEM_PROCESSOR=arm64 \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_SYSROOT="$sdk" -DCMAKE_OSX_DEPLOYMENT_TARGET="$minimum" \
  -DCMAKE_C_COMPILER="$swift_root/bin/clang" -DCMAKE_CXX_COMPILER="$swift_root/bin/clang++" -DCMAKE_OBJC_COMPILER="$swift_root/bin/clang" \
  -DCMAKE_C_COMPILER_TARGET="$sdk_target$minimum" -DCMAKE_CXX_COMPILER_TARGET="$sdk_target$minimum" \
  -DCMAKE_OBJC_COMPILER_TARGET="$sdk_target$minimum" -DCMAKE_ASM_COMPILER_TARGET="$sdk_target$minimum" \
  '-DCMAKE_C_FLAGS=-fapplication-extension' "-DCMAKE_CXX_FLAGS=$extra_cxx -fapplication-extension" \
  '-DCMAKE_OBJC_FLAGS=-fapplication-extension' "-DCMAKE_ASM_FLAGS=--target=$sdk_target$minimum -fapplication-extension" \
  "-DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=$linker $platform_flags -Wl,-fatal_warnings" \
  "-DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=$linker $platform_flags -Wl,-application_extension -Wl,-fatal_warnings" \
  -DCMAKE_INSTALL_NAME_TOOL=/bin/false -DCMAKE_CXX_SCAN_FOR_MODULES=OFF \
  "-DCMAKE_PREFIX_PATH=$base/tools/node_modules;$deps/node_modules" -DFETCHCONTENT_FULLY_DISCONNECTED=ON \
  -DFETCHCONTENT_UPDATES_DISCONNECTED=ON "-DCMAKE_PROJECT_bare_kit_swift_INCLUDE=$build/project-version.cmake" \
  "-Dcmake-ucd_DIR=$base/tools/node_modules/cmake-ucd" -Dnpm=/bin/false \
  "${sources_args[@]}" -DKEPOS_LOCAL_PREBUILDS="$base/prebuilds" -DKEPOS_EXTENSION_ONLY=ON \
  -DKEPOS_ADDON_ROOT="$repo/node_modules" -DBUILD_TESTING=OFF
"${limit[@]}" "${offline[@]}" "$deps/node_modules/.bin/cmake" --build "$build" \
  --target bare_kit_framework kepos_bare_inspect kepos_bare_type kepos_sodium_native kepos_udx_native --parallel 2

frameworks=(BareKit bare-inspect.3.1.4 bare-type.1.4.0 sodium-native.5.1.0 udx-native.1.20.7)
for name in "${frameworks[@]}"; do
  src="$build/$name.framework"; dest="$out/addons/$name.framework"
  if [[ "$name" == BareKit ]]; then
    dest="$out/$name.framework"
    if [[ "$system" == Darwin ]]; then
      mkdir -p "$src/Versions/A/Headers"
      cp "$sources/bare-kit/include/bare-kit.h" "$src/Versions/A/Headers/bare-kit.h"
      [[ -L "$src/Headers" ]] || ln -s Versions/Current/Headers "$src/Headers"
    else
      mkdir -p "$src/Headers"
      cp "$sources/bare-kit/include/bare-kit.h" "$src/Headers/bare-kit.h"
    fi
  fi
  if [[ "$system" == iOS ]]; then python3 "$repo/scripts/check-ios-frameworks.py" "$src"; fi
  node --input-type=module - "$repo" "$src/$name" "$system" <<'JS'
const safety = await import(`${process.argv[2]}/scripts/ios-framework-safety.mjs`)
;(process.argv[4] === 'iOS' ? safety.requireExtensionSafe : safety.requireMacExtensionSafe)(process.argv[3])
JS
  if [[ -e "$dest" ]]; then
    diff -qr "$src" "$dest" >/dev/null || { echo "Existing $dest differs; refusing to replace it." >&2; exit 1; }
  else
    mkdir -p "$(dirname "$dest")"; cp -a "$src" "$dest"
  fi
done
echo "Built $system extension frameworks in $out; native runtime validation remains separate."
