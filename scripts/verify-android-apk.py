#!/usr/bin/env python3
"""Inspect a Kepos Android APK for architecture, packaging and signing.

Only reads the built artifact; it never contacts a device.
"""

import argparse
import os
import re
import struct
import shutil
import subprocess
import sys
import tempfile
import zipfile

VPN_SERVICE = "io.lamplitisles.kepos.vpn.KeposVpnService"
ALWAYS_ON_KEY = "android.net.VpnService.SUPPORTS_ALWAYS_ON"
EXPECTED_ADDONS = (
    "libbare-inspect.3.1.4.so",
    "libbare-type.1.4.0.so",
    "libsodium-native.5.1.0.so",
    "libudx-native.1.20.7.so",
)


def fail(message):
    print(f"FAIL {message}", file=sys.stderr)
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("apk")
    parser.add_argument("--no-signature", action="store_true", help="skip apksigner")
    arguments = parser.parse_args()
    apk = arguments.apk
    if not os.path.isfile(apk):
        fail(f"missing APK: {apk}")

    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        if "assets/kepos.bundle" not in names:
            fail("assets/kepos.bundle is missing")
        native = sorted(name for name in names if name.startswith("lib/"))
        architectures = sorted({name.split("/")[1] for name in native})
        if architectures != ["arm64-v8a"]:
            fail(f"unexpected native architectures: {architectures}")
        present = {name.split("/")[-1] for name in native}
        for addon in EXPECTED_ADDONS:
            if addon not in present:
                fail(f"missing linked addon: {addon}")
        if "libbare-kit.so" not in present:
            fail("libbare-kit.so is missing")
        if "AndroidManifest.xml" not in names:
            fail("AndroidManifest.xml is missing")
        bundle_bytes = archive.getinfo("assets/kepos.bundle").file_size
        total = os.path.getsize(apk)
        print(f"APK {apk}")
        print(f"  size          {total} bytes ({total / (1024 * 1024):.1f} MiB)")
        print(f"  bundle        assets/kepos.bundle {bundle_bytes} bytes")
        print(f"  architectures {', '.join(architectures)}")
        print(f"  native libs   {', '.join(sorted(present))}")

    verify_service_manifest(apk)
    verify_core_api_levels(apk)
    verify_native_dependencies(apk)

    if arguments.no_signature:
        return
    signer = shutil.which("apksigner")
    if signer is None:
        print("SKIP apksigner is not on PATH; signing was not verified")
        return
    result = subprocess.run(
        [signer, "verify", "--print-certs", apk],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"apksigner verify failed: {result.stderr.strip() or result.stdout.strip()}")
    for line in result.stdout.splitlines():
        if "certificate DN" in line or "Verified using" in line:
            print(f"  {line.strip()}")


DEX_METHOD_REF = re.compile(r"L([A-Za-z0-9/$_]+);\.([A-Za-z0-9_$<>]+):(\([^)]*\)[^ ]+)")
API_VERSIONS = "data/api-versions.xml"


def min_sdk(apk):
    aapt2 = shutil.which("aapt2")
    if aapt2 is None:
        fail("aapt2 is required to read the minimum SDK")
    result = subprocess.run([aapt2, "dump", "badging", apk], capture_output=True, text=True, check=False)
    match = re.search(r"^minSdkVersion:'(\d+)'$", result.stdout, re.MULTILINE)
    if not match:
        fail("the APK has no minSdkVersion")
    return int(match.group(1))


def api_versions_path():
    """The platform that compileSdk targets carries the API level database."""
    for home in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT")):
        if not home:
            continue
        for name in ("android-36", "android-37.0", "android-36.1"):
            candidate = os.path.join(home, "platforms", name, API_VERSIONS)
            if os.path.isfile(candidate):
                return candidate
    return None


def load_core_api_levels(path):
    """Map java/javax class members to the API level that introduced them."""
    text = open(path, encoding="utf-8").read()
    levels = {}
    for block in re.finditer(r'<class name="((?:java|javax)/[^"]+)"[^>]*>(.*?)</class>', text, re.S):
        owner, body = block.group(1), block.group(2)
        members = {}
        for member in re.finditer(r'<method name="([^"]+)"([^>]*)/>', body):
            since = re.search(r'since="(\d+)"', member.group(2))
            if since:
                members[member.group(1)] = int(since.group(1))
        if members:
            levels[owner] = members
    return levels


def verify_core_api_levels(apk):
    """Fail when a dex method reference needs a newer core API than minSdk.

    Lint's NewApi check covers android.* but not java.*, and compiling on a
    current JDK can resolve a JDK-only member such as Stream.toList, which then
    throws NoSuchMethodError on a device at minSdk.
    """
    path = api_versions_path()
    if path is None:
        fail("the platform api-versions.xml is required to check core API levels")
    levels = load_core_api_levels(path)
    if not levels:
        fail("no java or javax API levels were found in " + path)
    minimum = min_sdk(apk)
    dexdump = shutil.which("dexdump")
    if dexdump is None:
        fail("dexdump is required to check core API levels")
    violations = set()
    with zipfile.ZipFile(apk) as archive, tempfile.TemporaryDirectory(prefix="kepos-dex-") as directory:
        for name in archive.namelist():
            if not re.fullmatch(r"classes\d*\.dex", name):
                continue
            target = os.path.join(directory, os.path.basename(name))
            with open(target, "wb") as handle:
                handle.write(archive.read(name))
            # dexdump prints raw symbol bytes, so decode defensively.
            dump = subprocess.run([dexdump, "-d", target], capture_output=True, check=False)
            if dump.returncode != 0:
                fail(f"dexdump could not read {name}")
            for owner, method, descriptor in DEX_METHOD_REF.findall(dump.stdout.decode("utf-8", "replace")):
                # api-versions keys a method by its name plus descriptor.
                since = levels.get(owner, {}).get(method + descriptor)
                if since is not None and since > minimum:
                    violations.add(f"{owner}.{method} needs API {since}")
    if violations:
        fail("core APIs above minSdk " + str(minimum) + ": " + "; ".join(sorted(violations)))
    print(f"  core APIs     no java reference above minSdk {minimum}")


# Libraries the Android platform provides to every app, so they need not be
# packaged. This is the stable NDK surface the addons legitimately link to.
PLATFORM_LIBS = frozenset(
    {
        "libc.so",
        "libm.so",
        "libdl.so",
        "liblog.so",
        "libz.so",
        "libandroid.so",
        "libjnigraphics.so",
        "libEGL.so",
        "libGLESv1_CM.so",
        "libGLESv2.so",
        "libGLESv3.so",
        "libOpenSLES.so",
        "libOpenMAXAL.so",
        "libmediandk.so",
        "libcamera2ndk.so",
        "libnativewindow.so",
        "libvulkan.so",
        "libaaudio.so",
        "libamidi.so",
        "libneuralnetworks.so",
        "libsync.so",
        "libnativehelper.so",
        "libstdc++.so",
    }
)

DT_NEEDED = 1
DT_SONAME = 14
SHT_DYNAMIC = 6
EM_AARCH64 = 183


def elf_dynamic(data):
    """Return (machine, needed, soname) for a 64-bit little-endian ELF."""
    if data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
        fail("not a 64-bit little-endian ELF")
    machine = struct.unpack_from("<H", data, 18)[0]
    shoff = struct.unpack_from("<Q", data, 0x28)[0]
    shentsize, shnum = struct.unpack_from("<HH", data, 0x3A)
    dynamic = None
    for index in range(shnum):
        base = shoff + index * shentsize
        sh_type = struct.unpack_from("<I", data, base + 4)[0]
        if sh_type == SHT_DYNAMIC:
            dynamic = (
                struct.unpack_from("<Q", data, base + 0x18)[0],
                struct.unpack_from("<Q", data, base + 0x20)[0],
                struct.unpack_from("<I", data, base + 0x28)[0],
            )
            break
    if dynamic is None:
        return machine, [], None
    offset, size, link = dynamic
    strtab_offset = struct.unpack_from("<Q", data, shoff + link * shentsize + 0x18)[0]
    needed, soname = [], None
    for entry in range(offset, offset + size, 16):
        tag, value = struct.unpack_from("<qQ", data, entry)
        if tag == 0:
            break
        if tag not in (DT_NEEDED, DT_SONAME):
            continue
        # Only these tags hold a string table offset; other values are pointers.
        start = strtab_offset + value
        end = data.find(b"\0", start)
        if end < 0:
            fail("an ELF dynamic string is not terminated")
        name = data[start:end].decode("utf-8", "replace")
        if tag == DT_NEEDED:
            needed.append(name)
        else:
            soname = name
    return machine, needed, soname


def verify_native_dependencies(apk):
    """Every DT_NEEDED of a packaged library must resolve inside the APK.

    A prebuilt addon linked against the NDK C++ runtime cannot load when the APK
    omits libc++_shared.so; the failure only appears at runtime as
    AddonError: CANNOT_LOAD, so the closure is checked here instead.
    """
    with zipfile.ZipFile(apk) as archive:
        entries = {}
        for name in archive.namelist():
            match = re.fullmatch(r"lib/([^/]+)/([^/]+\.so)", name)
            if match:
                entries.setdefault(match.group(1), {})[match.group(2)] = archive.read(name)
    if not entries:
        fail("the APK has no packaged native libraries")
    for arch, libraries in sorted(entries.items()):
        unresolved = set()
        for name, data in sorted(libraries.items()):
            machine, needed, _ = elf_dynamic(data)
            if machine != EM_AARCH64:
                fail(f"lib/{arch}/{name} is not an AArch64 library")
            for dependency in needed:
                if dependency in libraries or dependency in PLATFORM_LIBS:
                    continue
                unresolved.add(f"{name} needs {dependency}")
        if unresolved:
            fail(f"unresolved native dependencies in lib/{arch}: " + "; ".join(sorted(unresolved)))
        print(f"  native deps   lib/{arch}: every DT_NEEDED resolves ({len(libraries)} libraries)")


def verify_service_manifest(apk):
    """The VPN service must declare the always-on opt-out."""
    aapt2 = shutil.which("aapt2")
    if aapt2 is None:
        fail("aapt2 is required to check the VPN service manifest metadata")
    result = subprocess.run(
        [aapt2, "dump", "xmltree", "--file", "AndroidManifest.xml", apk],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"aapt2 could not read the manifest: {result.stderr.strip()}")
    lines = result.stdout.splitlines()
    for index, line in enumerate(lines):
        if not line.strip().startswith("E: service"):
            continue
        indent = len(line) - len(line.lstrip())
        block = []
        for following in lines[index + 1:]:
            stripped = following.strip()
            following_indent = len(following) - len(following.lstrip())
            if stripped.startswith("E: ") and following_indent <= indent:
                break
            block.append(stripped)
        if not any(VPN_SERVICE in row for row in block):
            continue
        if not any(ALWAYS_ON_KEY in row for row in block):
            fail(f"the VPN service does not declare {ALWAYS_ON_KEY}")
        if not any(":value" in row and "false" in row for row in block):
            fail(f"{ALWAYS_ON_KEY} is not false")
        print(f"  service       {VPN_SERVICE} opts out of always-on")
        return
    fail(f"the VPN service {VPN_SERVICE} is missing")


if __name__ == "__main__":
    main()
