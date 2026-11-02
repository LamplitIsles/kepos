import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.resolve(root, ".build/macos-unsigned");
const team = process.env.KEPOS_TEAM_ID;
const bundle = process.env.KEPOS_BUNDLE_ID ?? "io.lamplitisles.kepos";
// Diagnostic and ordinary binaries have different versions; increment both for later updates.
const diagnostics = process.env.KEPOS_STATUS_DIAGNOSTICS === "1";
const acceptanceDiagnostics = process.env.KEPOS_ACCEPTANCE_DIAGNOSTICS === "1";
if (diagnostics && acceptanceDiagnostics) throw new Error("Choose one diagnostic build mode");
const buildVersion = acceptanceDiagnostics ? "13" : diagnostics ? "14" : "15";
if (!team || !/^[A-Z0-9]{10}$/.test(team) || !/^[A-Za-z0-9.-]+$/.test(bundle)) {
  throw new Error("Set KEPOS_TEAM_ID to a 10-character team ID and KEPOS_BUNDLE_ID to the intended app identifier");
}
if (existsSync(output)) throw new Error(`Build output already exists: ${output}; preserve or remove it before rebuilding`);
const kitRoot = path.resolve(root, ".build/macos-deps/BareKit.xcframework/macos-arm64_x86_64/BareKit.framework");
if (!existsSync(path.join(kitRoot, "Headers/BareKit.h"))) throw new Error("BareKit macOS framework is missing");
const app = path.join(output, "Kepos.app/Contents");
const extensionID = `${bundle}.tunnel`;
const ext = path.join(app, "Library/SystemExtensions", `${extensionID}.systemextension/Contents`);
for (const dir of [output, path.join(app, "MacOS"), path.join(ext, "MacOS"), path.join(ext, "Resources"), path.join(ext, "Frameworks")]) {
  mkdirSync(dir, { recursive: true });
}
function run(command, args) { execFileSync(command, args, { cwd: root, stdio: "inherit" }); }
const npmBin = (name) => path.join(root, "node_modules/.bin", name);
const worklet = path.join(output, "macos-worklet.cjs");
run(npmBin("esbuild"), ["src/vpn/worklet-entry.ts", "--platform=node", "--format=cjs", "--packages=external", "--bundle", "--minify-syntax",
  `--define:KEPOS_ACCEPTANCE_DIAGNOSTICS=${acceptanceDiagnostics}`, `--outfile=${worklet}`]);
run(npmBin("bare-pack"), ["--host", "darwin-arm64", "--linked", "--out", path.join(ext, "Resources/macos-worklet.bundle"), worklet]);
run(npmBin("bare-link"), ["--host", "darwin-arm64", "--out", path.join(ext, "Frameworks"), worklet]);

// The release contains both a universal root binary and an arm64 Versions/A
// binary. This application targets arm64; reconstruct standard framework links.
const framework = path.join(ext, "Frameworks/BareKit.framework");
mkdirSync(path.join(framework, "Versions/A"), { recursive: true });
for (const name of ["BareKit", "Headers", "Resources"]) {
  cpSync(path.join(kitRoot, "Versions/A", name), path.join(framework, "Versions/A", name), { recursive: true });
  symlinkSync(`Versions/Current/${name}`, path.join(framework, name));
}
symlinkSync("A", path.join(framework, "Versions/Current"));

const swift = process.env.SWIFTC ?? "swiftc";
let flags = ["-target", "arm64-apple-macosx15.0"];
if (diagnostics) flags.push("-D", "KEPOS_STATUS_DIAGNOSTICS");
if (acceptanceDiagnostics) flags.push("-D", "KEPOS_ACCEPTANCE_DIAGNOSTICS");
if (process.platform === "linux") {
  const configured = execFileSync("swift", ["sdk", "configure", "darwin", "arm64-apple-macosx", "--show-configuration"], { encoding: "utf8" });
  const config = Object.fromEntries(configured.split("\n").map((line) => line.split(/: (.*)/s).slice(0, 2)).filter((pair) => pair.length === 2));
  if (!config.sdkRootPath || !config.swiftResourcesPath || !existsSync(npmBin("ld64.lld"))) throw new Error("Darwin SDK or npm ld64.lld unavailable");
  const sdkVersion = path.basename(config.sdkRootPath).match(/^MacOSX([0-9]+(?:\.[0-9]+)*)\.sdk$/)?.[1];
  if (!sdkVersion) throw new Error("Could not determine the macOS SDK version");
  flags.push("-sdk", config.sdkRootPath, "-resource-dir", config.swiftResourcesPath, `-use-ld=${npmBin("ld64.lld")}`,
    "-Xlinker", "-platform_version", "-Xlinker", "macos", "-Xlinker", "15.0", "-Xlinker", sdkVersion);
} else if (process.platform !== "darwin") {
  throw new Error("macOS cross-build is supported on Linux or macOS hosts");
}
const source = (name) => `apps/macos/Sources/KeposVPN/${name}.swift`;
run(swift, [...flags, "-module-name", "Kepos",
  ...["VPNControl", "ExistingIdentity", "PeerIdentityCrypto", "IdentityStore", "ProviderStatus", "StatusDiagnostics", "ConnectionMonitor", "TunnelLifecycle", "ExtensionReplacement", "VPNController", "MenuPresentation", "KeposMenuBar"].map(source),
  "apps/macos/App/AppMain.swift", "-o", path.join(app, "MacOS/Kepos")]);
run(swift, [...flags, "-module-name", "KeposTunnel", "-import-objc-header", path.join(kitRoot, "Headers/BareKit.h"),
  "-F", path.dirname(kitRoot), "-framework", "BareKit", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
  ...["ExistingIdentity", "PeerIdentityCrypto", "WorkletFrames", "WorkletStartup", "StatusDiagnostics", "AcceptanceDiagnostics", "PacketTunnelProvider"].map(source),
  "apps/macos/Provider/main.swift", "-o", path.join(ext, "MacOS/KeposTunnel")]);

const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
const field = (key, value) => `<key>${key}</key><string>${xml(value)}</string>`;
const usage = field("NSSystemExtensionUsageDescription", "Kepos uses a network extension to connect your configured peers.");
writeFileSync(path.join(app, "Info.plist"), plist(
  field("CFBundleIdentifier", bundle) + field("CFBundleName", "Kepos") + field("CFBundleExecutable", "Kepos") +
  field("CFBundlePackageType", "APPL") + field("CFBundleShortVersionString", "0.1") + field("CFBundleVersion", buildVersion) +
  field("LSMinimumSystemVersion", "15.0") + field("KeposProviderBundleID", extensionID) +
  usage + "<key>LSUIElement</key><true/>"));
writeFileSync(path.join(ext, "Info.plist"), plist(
  field("CFBundleIdentifier", extensionID) + field("CFBundleName", "KeposTunnel") + field("CFBundleExecutable", "KeposTunnel") +
  field("CFBundlePackageType", "SYSX") + field("CFBundleShortVersionString", "0.1") + field("CFBundleVersion", buildVersion) +
  field("LSMinimumSystemVersion", "15.0") + usage + "<key>NetworkExtension</key><dict>" +
  field("NEMachServiceName", `${team}.${bundle}.service`) + "<key>NEProviderClasses</key><dict>" +
  field("com.apple.networkextension.packet-tunnel", "KeposTunnel.PacketTunnelProvider") + "</dict></dict>"));
const groups = `<key>com.apple.security.application-groups</key><array><string>${xml(`${team}.${bundle}`)}</string></array>`;
const network = "<key>com.apple.developer.networking.networkextension</key><array><string>packet-tunnel-provider</string></array>";
writeFileSync(path.join(output, "app.entitlements"), plist(field("com.apple.application-identifier", `${team}.${bundle}`) + groups + network + "<key>com.apple.developer.system-extension.install</key><true/>"));
writeFileSync(path.join(output, "provider.entitlements"), plist(groups + network + "<key>com.apple.security.network.client</key><true/><key>com.apple.security.network.server</key><true/><key>com.apple.security.cs.allow-jit</key><true/>"));
const verifier = path.join(output, "verify-bundle");
run(swift, ["apps/macos/Tests/Bundle/main.swift", "-o", verifier]);
run(verifier, [path.join(output, "Kepos.app"), path.join(output, "app.entitlements"), team]);
console.log(`Unsigned build: ${path.join(output, "Kepos.app")}`);
console.log("Not signed, provisioned, installed, activated, or tested on macOS.");
