#!/usr/bin/env python3
"""Run the real controller with a test-owned fake NetworkExtension on Linux."""
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[4]
tests = Path(__file__).resolve().parent
source = root / "apps/macos/Sources/KeposVPN"
cache = Path(os.environ.get("KEPOS_SWIFT_MODULE_CACHE", root / ".build/ios-deps/bare-kit-swift-v2.2.0/module-cache"))
swift = os.environ.get("KEPOS_SWIFTC", "swiftc")
if not cache.is_dir():
    raise SystemExit("Set KEPOS_SWIFT_MODULE_CACHE to an existing Swift module cache")

with tempfile.TemporaryDirectory(prefix="kepos-5626-") as temporary:
    directory = Path(temporary)
    app = directory / "Harness.app"
    app.mkdir()
    (app / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": "fixture.kepos", "CFBundleExecutable": "Harness",
        "KeposProviderBundleID": "fixture.kepos.tunnel",
    }))
    env = dict(os.environ, HOME=temporary, TMPDIR=temporary,
               CLANG_MODULE_CACHE_PATH=str(cache), SWIFT_MODULECACHE_PATH=str(cache))
    common = [swift, "-j", "1", "-module-cache-path", str(cache)]
    files = ["VPNControl", "ManagedStateMessage", "ProviderStatus", "StatusDiagnostics",
             "ConnectionMonitor", "TunnelLifecycle", "VPNController"]
    commands = [
        ("fake", common + ["-emit-library", "-emit-module", "-module-name", "NetworkExtension",
                           str(tests / "NetworkExtension.swift"), "-o", str(directory / "libNetworkExtension.so"),
                           "-emit-module-path", str(directory / "NetworkExtension.swiftmodule")]),
        ("controller", common + ["-swift-version", "5", "-parse-as-library", "-I", str(directory),
                                  "-L", str(directory), "-lNetworkExtension", "-Xlinker", "-rpath",
                                  "-Xlinker", str(directory)] +
         [str(source / (name + ".swift")) for name in files] +
         [str(tests / "main.swift"), "-o", str(app / "Harness")]),
        ("test", [str(app / "Harness")]),
    ]
    for name, command in commands:
        process = subprocess.Popen(["unshare", "-Urn", *command], cwd=root, env=env, start_new_session=True)
        peak_rss = peak_temp = 0
        stopped = False
        while process.poll() is None:
            rss = 0
            for item in Path("/proc").iterdir():
                if not item.name.isdecimal():
                    continue
                try:
                    if os.getpgid(int(item.name)) != process.pid:
                        continue
                    for line in (item / "status").read_text().splitlines():
                        if line.startswith("VmRSS:"):
                            rss += int(line.split()[1])
                            break
                except (OSError, ValueError):
                    pass
            size = 0
            for file in directory.rglob("*"):
                try:
                    if file.is_file():
                        size += file.stat().st_size
                except FileNotFoundError:
                    pass
            peak_rss = max(peak_rss, rss)
            peak_temp = max(peak_temp, size)
            if rss > 450 * 1024 or size > 28 * 1024 * 1024:
                os.killpg(process.pid, signal.SIGTERM)
                stopped = True
                break
            time.sleep(0.05)
        code = process.wait()
        print(f"{name}: exit={code} sampled_group_rss_kib={peak_rss} sampled_temp_bytes={peak_temp}", flush=True)
        if stopped:
            raise SystemExit("Stopped at resource threshold")
        if code:
            raise SystemExit(code)
