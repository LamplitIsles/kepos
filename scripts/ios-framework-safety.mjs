import { readFileSync } from "node:fs";

// This verifies build metadata only. It does not audit imported APIs.
export function requireExtensionSafe(file) {
  requirePlatformExtensionSafe(file, 2, 0x00110000, "iOS");
}

export function requireMacExtensionSafe(file) {
  requirePlatformExtensionSafe(file, 1, 0x000f0000, "macOS");
}

function requirePlatformExtensionSafe(file, platform, maximumVersion, name) {
  const data = readFileSync(file);
  const invalid = () => { throw new Error(`Invalid ${name} arm64 framework: ${file}`); };
  if (data.length < 32) invalid();
  let offset = 0, limit = data.length;
  if (data.readUInt32BE(0) === 0xcafebabe) {
    const count = data.readUInt32BE(4);
    if (!count || count > 32 || data.length < 8 + count * 20) invalid();
    let found = false;
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * 20;
      if (data.readUInt32BE(entry) !== 0x0100000c) continue;
      if (found) invalid();
      offset = data.readUInt32BE(entry + 8);
      const size = data.readUInt32BE(entry + 12);
      if (offset > data.length || size > data.length - offset) invalid();
      limit = offset + size;
      found = true;
    }
    if (!found) invalid();
  }
  if (offset > limit - 32 || data.readUInt32LE(offset) !== 0xfeedfacf ||
      data.readUInt32LE(offset + 4) !== 0x0100000c || data.readUInt32LE(offset + 12) !== 6) invalid();
  if ((data.readUInt32LE(offset + 24) & 0x02000000) === 0) {
    throw new Error(`Framework was not built for app extensions: ${file}. See docs/peer-vpn.md.`);
  }
  const count = data.readUInt32LE(offset + 16), bytes = data.readUInt32LE(offset + 20);
  let position = offset + 32;
  if (bytes > limit - position || count > Math.floor(bytes / 8)) invalid();
  const end = position + bytes;
  let iosVersion = null;
  for (let i = 0; i < count; i++) {
    if (position > end - 8) invalid();
    const command = data.readUInt32LE(position), size = data.readUInt32LE(position + 4);
    if (size < 8 || size > end - position) invalid();
    if (command === 0x32) { // LC_BUILD_VERSION
      if (size < 24 || data.readUInt32LE(position + 8) !== platform || iosVersion !== null) invalid();
      iosVersion = data.readUInt32LE(position + 12);
    } else if (command === 0x25) { // LC_VERSION_MIN_IPHONEOS
      if (platform !== 2) invalid();
      if (size < 16 || iosVersion !== null) invalid();
      iosVersion = data.readUInt32LE(position + 8);
    } else if (command === 0x24) { // LC_VERSION_MIN_MACOSX
      if (platform !== 1) invalid();
      if (size < 16 || iosVersion !== null) invalid();
      iosVersion = data.readUInt32LE(position + 8);
    }
    position += size;
  }
  if (position !== end || iosVersion === null || iosVersion === 0 || iosVersion > maximumVersion) invalid();
}
