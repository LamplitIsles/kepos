// Builds the Android worklet bundle and the linked arm64 addons, then builds
// the debug APK. The bundle and the addons are generated files kept out of Git.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const android = path.join(root, "android");
const build = path.join(root, ".build", "android");
const bundle = path.join(android, "app", "src", "main", "assets", "kepos.bundle");
const addons = path.join(android, "app", "src", "main", "jniLibs");

// Locked versions from the root dependency graph; the bundle must reference
// exactly these and nothing else.
const expectedAddons = [
  "libbare-inspect.3.1.4.so",
  "libbare-type.1.4.0.so",
  "libsodium-native.5.1.0.so",
  "libudx-native.1.20.7.so",
];

// The udx-native and sodium-native prebuilds link the NDK C++ runtime, which
// Android does not provide to apps: it has to ship inside the APK or the addon
// fails to load at runtime.
const ANDROID_STL = { name: "libc++_shared.so", machine: 183 /* AArch64 */ };

const skipGradle = process.argv.includes("--no-gradle");

mkdirSync(build, { recursive: true });
mkdirSync(path.dirname(bundle), { recursive: true });
rmSync(addons, { recursive: true, force: true });

const entry = path.join(build, "worklet.cjs");
const bin = (name) => path.join(root, "node_modules", ".bin", name);
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

run(bin("esbuild"), [
  "src/vpn/worklet-entry.ts",
  "--platform=node",
  "--format=cjs",
  "--packages=external",
  "--bundle",
  "--minify-syntax",
  "--define:KEPOS_ACCEPTANCE_DIAGNOSTICS=false",
  `--outfile=${entry}`,
]);
run(bin("bare-pack"), ["--host", "android-arm64", "--linked", "--out", bundle, entry]);
run(bin("bare-link"), ["--host", "android-arm64", "--out", addons, entry]);

copyAndroidStl();

const Bundle = createRequire(import.meta.url)("bare-bundle");
const packed = Bundle.from(readFileSync(bundle));
const linked = packed.addons.map((addon) => {
  const match = /^linked:(lib[A-Za-z0-9._-]+\.so)$/u.exec(addon);
  if (!match) throw new Error(`Unsupported Android addon reference: ${addon}`);
  return match[1];
});
if (linked.length === 0) throw new Error("The Android worklet has no linked addons");
const sorted = [...linked].sort();
if (sorted.join(",") !== [...expectedAddons].sort().join(",")) {
  throw new Error(`Unexpected linked addons: ${sorted.join(", ")}`);
}
for (const name of linked) {
  const file = path.join(addons, "arm64-v8a", name);
  if (!existsSync(file)) throw new Error(`Missing linked addon: arm64-v8a/${name}`);
}
const architectures = new Set(readdirSync(addons));
if (architectures.size !== 1 || !architectures.has("arm64-v8a")) {
  throw new Error(`Expected only arm64-v8a addons, found: ${[...architectures].join(", ")}`);
}

process.stdout.write(`Android worklet bundle and addons are ready: ${linked.length} linked addons\n`);
if (skipGradle) process.exit(0);

run(path.join(android, "gradlew"), ["--project-dir", android, ":app:assembleDebug"]);
const apk = path.join(android, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!existsSync(apk)) throw new Error("The debug APK was not produced");
writeFileSync(path.join(build, "apk-path.txt"), `${apk}\n`);
process.stdout.write(`Debug APK: ${apk}\n`);

/**
 * Copies the NDK C++ runtime for arm64 into the packaged native libraries,
 * after verifying that it is an AArch64 ELF. The NDK is already installed for
 * this project; nothing is downloaded.
 */
function copyAndroidStl() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT is required to locate the NDK C++ runtime");
  const ndk = process.env.KEPOS_ANDROID_NDK ?? installedNdk(sdk);
  const source = path.join(
    ndk,
    "toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android",
    ANDROID_STL.name,
  );
  if (!existsSync(source)) throw new Error(`missing NDK C++ runtime: ${source}`);
  const header = readFileSync(source, { encoding: null }).subarray(0, 20);
  if (header.subarray(0, 4).toString("binary") !== "\x7fELF" || header[4] !== 2 || header[5] !== 1) {
    throw new Error(`not a 64-bit little-endian ELF: ${source}`);
  }
  if (header.readUInt16LE(18) !== ANDROID_STL.machine) {
    throw new Error(`not an AArch64 library: ${source}`);
  }
  copyFileSync(source, path.join(addons, "arm64-v8a", ANDROID_STL.name));
  process.stdout.write(`Packaged ${ANDROID_STL.name} from ${ndk}\n`);
}

function installedNdk(sdk) {
  const directory = path.join(sdk, "ndk");
  const candidates = existsSync(directory)
    ? readdirSync(directory).filter((name) => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(name)).sort(compareVersions)
    : [];
  if (candidates.length === 0) throw new Error(`no Android NDK found in ${directory}`);
  return path.join(directory, candidates[candidates.length - 1]);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
