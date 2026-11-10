import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requireExtensionSafe, requireMacExtensionSafe } from "../scripts/ios-framework-safety.mjs";

function framework({ cpu = 0x0100000c, safe = true, platform = 2, minOS = 0x00110000 } = {}) {
  const data = Buffer.alloc(56);
  data.writeUInt32LE(0xfeedfacf, 0);
  data.writeUInt32LE(cpu, 4);
  data.writeUInt32LE(6, 12); // MH_DYLIB
  data.writeUInt32LE(1, 16);
  data.writeUInt32LE(24, 20);
  data.writeUInt32LE(safe ? 0x02000000 : 0, 24);
  data.writeUInt32LE(0x32, 32); // LC_BUILD_VERSION
  data.writeUInt32LE(24, 36);
  data.writeUInt32LE(platform, 40);
  data.writeUInt32LE(minOS, 44);
  return data;
}

test("framework metadata must describe an extension-safe iOS arm64 dylib usable on iOS 17", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kepos-framework-test-"));
  const file = path.join(dir, "framework");
  const check = (data) => { writeFileSync(file, data); return () => requireExtensionSafe(file); };
  try {
    assert.doesNotThrow(check(framework()));
    assert.throws(check(framework({ safe: false })), /not built for app extensions/);
    assert.throws(check(framework({ cpu: 0x01000007 })), /Invalid/);
    assert.throws(check(framework({ platform: 7 })), /Invalid/); // simulator
    assert.throws(check(framework({ minOS: 0x00120000 })), /Invalid/);
    assert.throws(check(framework().subarray(0, 40)), /Invalid/);

    const fat = Buffer.alloc(28 + 56);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(1, 4);
    fat.writeUInt32BE(0x0100000c, 8);
    fat.writeUInt32BE(28, 16);
    fat.writeUInt32BE(56, 20);
    framework().copy(fat, 28);
    assert.doesNotThrow(check(fat));
    fat.writeUInt32BE(55, 20);
    assert.throws(check(fat), /Invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("macOS extension framework must be arm64, marked safe and usable on macOS 15", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kepos-mac-framework-test-"));
  const file = path.join(dir, "framework");
  const check = (data) => { writeFileSync(file, data); return () => requireMacExtensionSafe(file); };
  try {
    assert.doesNotThrow(check(framework({ platform: 1, minOS: 0x000f0000 })));
    assert.throws(check(framework({ platform: 1, minOS: 0x000f0000, safe: false })), /not built for app extensions/);
    assert.throws(check(framework({ platform: 2, minOS: 0x000f0000 })), /Invalid/);
    assert.throws(check(framework({ platform: 1, minOS: 0x00100000 })), /Invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("framework Info.plist is valid for embedding", { skip: process.platform === "win32" }, () => {
  execFileSync("python3", ["test/test_ios_framework_info.py"], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "pipe",
  });
});
