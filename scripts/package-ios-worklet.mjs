// Xcode invokes this inside each target before signing it.
// All intermediate files belong to this invocation; dependencies are read-only.
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireExtensionSafe } from "./ios-framework-safety.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { PLATFORM_NAME, DERIVED_FILE_DIR, TARGET_BUILD_DIR, WRAPPER_NAME,
  EXPANDED_CODE_SIGN_IDENTITY, CODE_SIGNING_ALLOWED } = process.env;
const mode = process.argv[2];
if (mode !== "extension" && mode !== "host") throw new Error("Expected extension or host mode");
if (PLATFORM_NAME !== "iphoneos") throw new Error("Kepos currently builds for iOS devices only (ios-arm64)");
if (!DERIVED_FILE_DIR || !TARGET_BUILD_DIR || !WRAPPER_NAME) throw new Error("Run this script from the Kepos Xcode target");
const product = path.join(TARGET_BUILD_DIR, WRAPPER_NAME);
const safeArtifacts = path.join(root, ".build/ios-deps/bare-kit-swift-v2.2.0/extension-safe");
const kit = path.join(safeArtifacts, "BareKit.framework");
if (!existsSync(path.join(kit, "Headers/bare-kit.h"))) throw new Error("An extension-safe iOS arm64 BareKit framework is required; see docs/peer-vpn.md");

requireExtensionSafe(path.join(kit, "BareKit"));
execFileSync("python3", [path.join(root, "scripts/check-ios-frameworks.py"), kit], { stdio: "inherit" });

// The entry must remain below the workspace so Bare's resolver can find the
// existing root node_modules. It is removed after this invocation.
const temp = mkdtempSync(path.join(root, ".build/ios-worklet-"));
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
const bin = (name) => path.join(root, "node_modules/.bin", name);
try {
  if (mode === "extension") {
    const entry = path.join(temp, "worklet.cjs");
    run(bin("esbuild"), ["src/vpn/worklet-entry.ts", "--platform=node", "--format=cjs", "--packages=external", "--bundle", "--minify-syntax", "--define:KEPOS_ACCEPTANCE_DIAGNOSTICS=false", `--outfile=${entry}`]);
    mkdirSync(product, { recursive: true });
    run(bin("bare-pack"), ["--host", "ios-arm64", "--linked", "--out", path.join(product, "ios-worklet.bundle"), entry]);
  } else {
    // These must be built from the current locked addon graph with extension
    // safety enabled. bare-link on the ordinary npm prebuilds would silently
    // recreate non-extension-safe frameworks here.
    const linked = path.join(safeArtifacts, "addons");
    if (!existsSync(linked)) throw new Error("Extension-safe iOS addon frameworks are required; see docs/peer-vpn.md");
    const bundlePath = path.join(product, "PlugIns/KeposTunnel.appex/ios-worklet.bundle");
    const bundle = createRequire(import.meta.url)("bare-bundle").from(readFileSync(bundlePath));
    if (bundle.addons.length === 0) throw new Error("The iOS worklet has no linked addons");
    for (const addon of bundle.addons) {
      const match = /^linked:([A-Za-z0-9._-]+\.framework)\/([A-Za-z0-9._-]+)$/.exec(addon);
      if (!match || !existsSync(path.join(linked, match[1], match[2]))) {
        throw new Error(`Missing iOS linked addon: ${addon}`);
      }
    }
    const addonFrameworks = [];
    for (const name of readdirSync(linked)) {
      if (!name.endsWith(".framework")) throw new Error(`Unexpected linked artifact: ${name}`);
      requireExtensionSafe(path.join(linked, name, name.slice(0, -".framework".length)));
      addonFrameworks.push(path.join(linked, name));
    }
    run("python3", ["scripts/check-ios-frameworks.py", ...addonFrameworks]);
    const frameworks = path.join(product, "Frameworks");
    mkdirSync(frameworks, { recursive: true });
    cpSync(kit, path.join(frameworks, "BareKit.framework"), { recursive: true });
    for (const name of readdirSync(linked)) {
      if (!name.endsWith(".framework")) throw new Error(`Unexpected linked artifact: ${name}`);
      cpSync(path.join(linked, name), path.join(frameworks, name), { recursive: true });
    }
    if (CODE_SIGNING_ALLOWED !== "NO") {
      if (!EXPANDED_CODE_SIGN_IDENTITY) throw new Error("Xcode did not provide a signing identity for embedded frameworks");
      for (const name of readdirSync(frameworks)) {
        if (name.endsWith(".framework")) run("/usr/bin/codesign", ["--force", "--sign", EXPANDED_CODE_SIGN_IDENTITY, "--timestamp=none", path.join(frameworks, name)]);
      }
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
