# Building the Apple extension frameworks

The iOS and macOS packet extensions use Bare Kit 3. Both require an
extension-safe runtime and the four linked native addons. The official
[bare-kit-swift v2.2.0 release](https://github.com/holepunchto/bare-kit-swift/releases/tag/v2.2.0)
does not provide suitable extension binaries: its iOS binary uses UIApplication
and its macOS binary lacks `MH_APP_EXTENSION_SAFE`. An extension-safety flag
alone is not a complete API audit.

The offline Linux cross-build below targets iOS 17 arm64 and macOS 15 arm64. It
uses an existing Apple SDK, Clang, CMake, Ninja and the workspace's ld64.lld;
it does not build V8. Frameworks and addon sources must be built for each
platform. The iOS build omits Bare Kit's UIApplication background-task code;
the macOS build uses the upstream non-iOS suspension implementation. Both
compile with application-extension restrictions and link with extension checks
and fatal linker warnings enabled. Generated Bare headers are isolated in each
platform's build directory so a Mac build cannot silently change an iOS build.

The following fixed inputs must be prepared under `.build/ios-deps` before
running the script:

* The six new source archives and extracted trees under
  `bare-kit-swift-v2.2.0/{archives,src}`, pinned by
  `scripts/ios-extension-safe/v3/source-archives.sha256`. They are upstream
  GitHub codeload archives for bare-kit-swift v2.2.0, bare-kit v3.0.1, bare
  v1.36.2, libuv, libjs and libnapi; the filename contains each full commit.
  Extract only after verifying archive hashes and paths. Apply the matching
  patches in `scripts/ios-extension-safe/v3/` to the three named source trees.
* The shared source archives and trees recorded in
  `scripts/ios-extension-safe/source-archives.sha256`, including the existing
  BoringSSL and libjstl patches in `scripts/ios-extension-safe/patches/`. The root
  `node_modules` supplies the locked worklet and addon sources. The isolated
  `bare-kit-swift-v2.2.0/tools/node_modules` must match the checked-in v3
  package lock. The existing `cmake-ucd` copy there must have the v3 offline
  patch applied. `build/bin/npm` and `build/bin/npx` must point to `/bin/false`;
  the build itself must not invoke npm or download dependencies.
* `prebuilds/{ios-arm64,darwin-arm64}/{libc++.a,libjs.a,libv8.a}` beneath
  `bare-kit-swift-v2.2.0`. Bare v1.36.2 pins public Hyperdrive
  `krmguqnh75rud4iieqgmzyqoza415cbu68payoww65ii9fzt5n4o`, checkout 198;
  validate each platform's entries, content key, block ranges and byte lengths
  before downloading. The observed content key is
  `03c74edd29aee76b0efa107df827eee1ef41342464c56f2f548c1bb8f3ca464f`.
  `scripts/ios-extension-safe/v3/prebuilds.sha256` records local hashes of the
  acquired files, not independently published upstream digests. Do not assume
  matching file names or sizes prove identical content. The current tree reuses
  the previously verified iOS libc++ and V8 files by symlink.
* The seven Unicode 17.0.0 inputs in
  `build/bare-kit/cmake/ucd/17.0.0`, checked against
  `scripts/ios-extension-safe/unicode-17.sha256`. The build creates per-build
  links to those files, and fails rather than fetching missing inputs.

The v3 source and prebuilt acquisition procedure is not yet automated by the
checked-in scripts. The build command assumes the above inputs have already
been prepared and patched; it does not install dependencies. Existing source
and dependency directories must not be replaced to follow these instructions.
Any acquisition or new cache is subject to the local resource rules. In
particular, npm versions may clean old logs even with logging disabled; do not
run npm against an existing user cache without checking its actual effects.

Run one platform at a time:

```sh
bash scripts/ios-extension-safe/v3/build.sh ios
bash scripts/ios-extension-safe/v3/build.sh macos
```

The script verifies pinned source archives, prebuilds, Unicode files and tool
lock, requires the offline patches, disables FetchContent and uses a network
namespace, prohibits npm, and uses at most two compile jobs. Its output is
`bare-kit-swift-v2.2.0/extension-safe` or `extension-safe-macos`, respectively.
It compares existing frameworks against a rebuild and refuses to overwrite a
different one. Artifact hashes can change when build inputs or toolchains
change; investigate differences before replacing any existing output.

The current iOS and Mac source-built frameworks passed architecture,
platform, minimum-version, extension-flag, plist, selected forbidden-import
and selector checks. Their actual worklet addon names matched the four built
frameworks; the providers cross-linked with extension checks and fatal warnings.
These are Linux cross-build results, not an exhaustive prohibited-API proof.
Apple's native Xcode linker, provisioning, signing, actual extension loading,
V8 policy, runtime memory and real-device VPN behavior remain separate checks.

The runtime still imports `fork`, `execvp`, `posix_spawn`, `dlopen`, `dlsym`,
`mmap` and `mprotect`; the fork/exec/spawn imports are present in the compiled
libuv process object. The Mac runtime also imports
`pthread_jit_write_protect_np`. Imports alone do not show that the worklet
uses those paths or that the sandbox permits them. The inspected iPhoneOS 27.1
headers do not mark `fork`, `execvp` or `posix_spawn` unavailable to iOS app
extensions; that is not evidence that subprocess creation will work in the
sandbox. Apple restricts APIs marked
unavailable to extensions, and Mac hardened-runtime JIT needs its own
[entitlement and memory-protection rules](https://developer.apple.com/documentation/apple-silicon/porting-just-in-time-compilers-to-apple-silicon).
The Mac extension retains its existing `allow-jit` entitlement. In the current
iOS binary, the file-backed bytes for V8's `FLAGDEFAULT_jitless`,
`FLAGDEFAULT_lite_mode` and `FlagValues::jitless` are `01`; that is static
initialization evidence, not a runtime trace or proof of execution without JIT.
No iOS JIT entitlement or successful JIT-less execution is inferred from it.
