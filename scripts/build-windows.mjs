// Builds the self-contained Windows x64 package for the Kepos peer VPN.
//
// Inputs, all already in the repository or its ignored build directories:
//   .build/bare-kit/3.0.1/windows-x64/bare-kit.dll   official Bare Kit 3 native library
//   .build/wintun-0.14.1.zip                         verified Wintun release archive
//   node_modules                                     addon prebuilds and the bundling tools
//
// Output: apps/windows/target/package/kepos-windows-x64/
//   KeposVPN.exe, bare-kit.dll, the four addon DLLs, kepos-worklet.bundle,
//   wintun.dll, and the licences/notices for everything shipped.
//
// The executable must re-export the bare/js/uv symbols because the prebuilt
// addons delay-load and resolve them against the host executable; that is what
// the generated forwarder `.def` does. The manifest requests administrator
// rights, which the overlay device needs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const windows = path.join(root, "apps/windows");
const target = path.join(windows, "target");
const generated = path.join(root, ".build/windows-package");
const output = path.join(target, "package/kepos-windows-x64");
const kit = path.join(root, ".build/bare-kit/3.0.1/windows-x64/bare-kit.dll");
const wintun = path.join(root, ".build/wintun-0.14.1.zip");
const wintunSha = "07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51";
const exe = path.join(target, "x86_64-pc-windows-msvc/release/kepos-tray.exe");

const bin = (name) => path.join(root, "node_modules/.bin", name);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
const outputOf = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8", ...options });

for (const input of [kit, wintun, path.join(path.dirname(kit), "LICENSE"), path.join(path.dirname(kit), "NOTICE")]) {
  if (!existsSync(input)) throw new Error(`Missing build input: ${input}`);
}

// The fixed package output is this project's own build product. Replace it only
// when it is recognisably ours: every entry must be a file this script writes.
// Anything else means another operation owns the directory, so stop instead of
// deleting data.
const packageFiles = new Set([
  "KeposVPN.exe", "bare-kit.dll", "bare-kit.PROVENANCE.md", "bare-kit.LICENSE",
  "bare-kit.NOTICE", "kepos-worklet.bundle", "wintun.dll", "wintun.LICENSE.txt",
  "LICENSE", "THIRD-PARTY.md", "README.txt",
  // Written by earlier versions of this script.
  "LICENSE.txt",
  "Kepos.exe", "wintun.LICENSE.txt",
  "bare-inspect-3.1.4.dll", "bare-type-1.4.0.dll", "sodium-native-5.1.0.dll",
  "udx-native-1.20.7.dll",
  "LICENSE.bare-inspect", "LICENSE.bare-type", "LICENSE.sodium-native", "LICENSE.udx-native",
  // The crate licence inventory this script writes, one directory per crate.
  "licenses", "install.cmd",
]);
if (existsSync(output)) {
  const unknown = readdirSync(output).filter((name) => !packageFiles.has(name));
  if (unknown.length > 0) {
    throw new Error(`Refusing to replace ${output}: unexpected entries ${unknown.join(", ")}`);
  }
  rmSync(output, { recursive: true, force: true });
}
const archive = readFileSync(wintun);
if (createHash("sha256").update(archive).digest("hex") !== wintunSha) {
  throw new Error("The Wintun archive does not match the published SHA-256");
}

// The scratch directory is created only when absent and is removed only by this
// run, so a directory another operation created is never emptied.
const ownsGenerated = !existsSync(generated);
if (ownsGenerated) mkdirSync(generated, { recursive: true });
mkdirSync(output, { recursive: true });

// 1. Import library and the host's forwarder exports, both derived from the
//    library that actually ships.
const exports = outputOf(bin("llvm-readobj"), ["--coff-exports", kit])
  .split("\n")
  .filter((line) => line.includes("Name: "))
  .map((line) => line.slice(line.indexOf("Name: ") + 6).trim())
  .filter(Boolean)
  .sort();
const forward = exports.filter((name) => /^(bare_|js_|napi_|uv_)/u.test(name));
if (!forward.includes("bare_module_find")) throw new Error("bare-kit.dll does not export bare_module_find");
writeFileSync(
  path.join(generated, "bare-kit.def"),
  ["LIBRARY bare-kit.dll", "EXPORTS", ...exports.map((name) => `  ${name}`)].join("\n") + "\n",
);
writeFileSync(
  path.join(generated, "kepos-host.def"),
  ["EXPORTS", ...forward.map((name) => `  ${name} = bare-kit.${name}`)].join("\n") + "\n",
);
run("llvm-dlltool", ["-m", "i386:x86-64", "-d", path.join(generated, "bare-kit.def"), "-l", path.join(generated, "bare-kit.lib")]);

// 2. The worklet bundle and the four linked addons.
const entry = path.join(generated, "worklet.cjs");
run(bin("esbuild"), [
  "src/vpn/worklet-entry.ts", "--platform=node", "--format=cjs", "--packages=external",
  "--bundle", "--minify-syntax", "--define:KEPOS_ACCEPTANCE_DIAGNOSTICS=false", `--outfile=${entry}`,
]);
run(bin("bare-pack"), ["--host", "win32-x64", "--linked", "--out", path.join(output, "kepos-worklet.bundle"), entry]);
run(bin("bare-link"), ["--host", "win32-x64", "--out", output, entry]);

// 3. The executable: static CRT, the forwarder table, and an administrator manifest.
run(
  cargo(),
  ["+1.99.1", "xwin", "rustc", "--release", "--target", "x86_64-pc-windows-msvc", "--offline",
    "-p", "kepos-tray", "--",
    "-L", `native=${generated}`,
    "-C", `link-arg=/DEF:${path.join(generated, "kepos-host.def")}`,
    "-C", "link-arg=/MANIFEST:EMBED",
    "-C", "link-arg=/MANIFESTUAC:level='requireAdministrator' uiAccess='false'"],
  { cwd: windows, env: { ...process.env, RUSTFLAGS: "-C target-feature=+crt-static" } },
);
if (!existsSync(exe)) throw new Error("The release executable was not produced");
copyFileSync(exe, path.join(output, "KeposVPN.exe"));

// 4. The runtime library, the Wintun driver and the licences.
const kitDir = path.dirname(kit);
copyFileSync(kit, path.join(output, "bare-kit.dll"));
copyFileSync(path.join(kitDir, "PROVENANCE.md"), path.join(output, "bare-kit.PROVENANCE.md"));
copyFileSync(path.join(kitDir, "LICENSE"), path.join(output, "bare-kit.LICENSE"));
copyFileSync(path.join(kitDir, "NOTICE"), path.join(output, "bare-kit.NOTICE"));
run("unzip", ["-o", "-j", wintun, "wintun/bin/amd64/wintun.dll", "-d", output]);
// The archive's licence keeps the name Wintun ships it under.
run("unzip", ["-o", "-j", wintun, "wintun/LICENSE.txt", "-d", path.join(generated, "wintun")]);
copyFileSync(path.join(generated, "wintun/LICENSE.txt"), path.join(output, "wintun.LICENSE.txt"));
// Each addon ships its own licence in its package.
for (const addon of ["bare-inspect", "bare-type", "sodium-native", "udx-native"]) {
  copyFileSync(path.join(root, "node_modules", addon, "LICENSE"), path.join(output, `LICENSE.${addon}`));
}
copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
writeFileSync(
  path.join(output, "README.txt"),
  [
    "Kepos Windows peer VPN (personal test build)",
    "",
    "Install: double-click install.cmd. It copies these files into",
    "%LOCALAPPDATA%\\Programs\\Kepos VPN and starts Kepos VPN, which asks for",
    "administrator rights itself. Close Clash TUN before connecting.",
    "",
    "The installer never touches %LOCALAPPDATA%\\Kepos\\windows, where the app keeps",
    "its identity and configuration, and it does not touch any other folder.",
    "install.cmd refuses a folder that already exists. The setup upgrades an",
    "installation it owns: it stages the new files next to the target, keeps the",
    "previous copy, and refuses a non-empty folder that lacks its ownership",
    "marker.",
    "",
    "Pair from the tray with \"Pair with invitation...\": paste or type the",
    "invitation into the field and confirm. The invitation is never read from the",
    "clipboard automatically. If a pairing outcome is reported as unknown, inspect",
    "the receiver's authorized devices before acknowledging it; the invitation is",
    "never replayed automatically.",
    "",
    "To remove Kepos: quit it, then run its uninstaller (Start menu > Kepos VPN,",
    "Settings > Apps > Kepos VPN, or uninstall.exe in the folder the setup created).",
    "It deletes only the files it installed plus its shortcut and registry entry,",
    "and never the identity in %LOCALAPPDATA%\\Kepos\\windows.",
    "",
    "Bundled third-party components:",
    "- bare-kit 3.0.1 (Apache-2.0, Copyright 2024 Holepunch Inc) - see bare-kit.LICENSE, bare-kit.NOTICE",
    "- worklet addons - see LICENSE.bare-inspect, LICENSE.bare-type, LICENSE.sodium-native, LICENSE.udx-native",
    "- Wintun 0.14.1 prebuilt wintun.dll (WireGuard LLC prebuilt binaries licence) - see wintun.LICENSE.txt",
    "- Kepos (Apache-2.0) - see LICENSE; the full crate list is in THIRD-PARTY.md and licenses/",
    "",
  ].join("\n"),
);
collectLicenses();
writeInstaller();
buildSetup();

// 4b. Licence inventory for the crates actually linked into the executable.
//     Only files already present in the local cargo registry are copied; nothing
//     is downloaded and no new dependency directory is created.
function collectLicenses() {
  const metadata = JSON.parse(
    outputOf(cargo(), ["+1.99.1", "metadata", "--format-version", "1", "--offline",
      "--filter-platform", "x86_64-pc-windows-msvc"], { cwd: windows }),
  );
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((entry) => [entry.id, entry]));
  const roots = metadata.packages.filter((entry) => entry.name === "kepos-tray").map((entry) => entry.id);
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const kinds = new Set((dep.dep_kinds ?? []).map((kind) => kind.kind ?? "normal"));
      if (kinds.size === 1 && kinds.has("dev")) continue;
      queue.push(dep.pkg);
    }
  }
  const licences = path.join(output, "licenses");
  mkdirSync(licences, { recursive: true });
  const rows = [];
  const uncovered = [];
  for (const id of [...seen].sort()) {
    const entry = packages.get(id);
    const dir = path.dirname(entry.manifest_path);
    const files = readdirSync(dir)
      .filter((name) => /^(LICEN[SC]E|COPYING|NOTICE|UNLICENSE)/iu.test(name))
      .sort();
    const target = path.join(licences, `${entry.name}-${entry.version}`);
    if (files.length === 0) {
      uncovered.push(`${entry.name} ${entry.version} (${entry.license ?? "no licence field"})`);
      rows.push(`| ${entry.name} | ${entry.version} | ${entry.license ?? "unknown"} | covered by the project LICENSE |`);
      continue;
    }
    mkdirSync(target, { recursive: true });
    for (const file of files) copyFileSync(path.join(dir, file), path.join(target, file));
    rows.push(`| ${entry.name} | ${entry.version} | ${entry.license ?? "see files"} | licenses/${entry.name}-${entry.version}/ |`);
  }
  writeFileSync(
    path.join(output, "THIRD-PARTY.md"),
    [
      "# Third-party components in this package",
      "",
      "Licence texts are copied from the exact crate versions in `apps/windows/Cargo.lock`",
      "that are linked into `KeposVPN.exe`, from the local cargo registry. Nothing was",
      "downloaded for this list.",
      "",
      "| Component | Version | Licence (from Cargo metadata) | Files |",
      "| --- | --- | --- | --- |",
      "| bare-kit | 3.0.1 | Apache-2.0 | bare-kit.LICENSE, bare-kit.NOTICE |",
      "| bare-inspect | 3.1.4 | see file | LICENSE.bare-inspect |",
      "| bare-type | 1.4.0 | see file | LICENSE.bare-type |",
      "| sodium-native (libsodium) | 5.1.0 | see file | LICENSE.sodium-native |",
      "| udx-native | 1.20.7 | see file | LICENSE.udx-native |",
      "| Wintun prebuilt wintun.dll | 0.14.1 | WireGuard LLC prebuilt binaries licence | wintun.LICENSE.txt |",
      "",
      "## Rust crates linked into KeposVPN.exe",
      "",
      "| Crate | Version | Licence | Files |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
      ...(uncovered.length === 0
        ? []
        : [
            "### Crates without a licence file in their package",
            "",
            "These are the Kepos crates themselves, covered by the project `LICENSE`.",
            "",
            ...uncovered.map((entry) => `- ${entry}`),
            "",
          ]),
    ].join("\n"),
  );
  if (uncovered.some((entry) => !entry.startsWith("kepos-"))) {
    throw new Error(`Missing licence files for third-party crates: ${uncovered.join(", ")}`);
  }
}

// The installer copies the unpacked package into the per-user programs folder and
// starts the application, whose manifest asks for elevation. It never reads or
// writes the application state in %LOCALAPPDATA%\Kepos\windows, and it refuses to
// touch an existing installation.
function writeInstaller() {
  const runtime = [
    "KeposVPN.exe",
    "bare-kit.dll",
    "bare-inspect-3.1.4.dll",
    "bare-type-1.4.0.dll",
    "sodium-native-5.1.0.dll",
    "udx-native-1.20.7.dll",
    "kepos-worklet.bundle",
    "wintun.dll",
  ];
  const extra = [
    "README.txt",
    "THIRD-PARTY.md",
    "LICENSE",
    "bare-kit.LICENSE",
    "bare-kit.NOTICE",
    "bare-kit.PROVENANCE.md",
    "wintun.LICENSE.txt",
    "LICENSE.bare-inspect",
    "LICENSE.bare-type",
    "LICENSE.sodium-native",
    "LICENSE.udx-native",
  ];
  const list = (names) => names.join(" ");
  const lines = [
    "@echo off",
    // No delayed expansion: a user path may contain "!" and this script must not
    // mangle it. Everything below works with ordinary expansion only.
    "setlocal EnableExtensions",
    "rem Installs Kepos VPN from this folder into",
    "rem   %LOCALAPPDATA%\\Programs\\Kepos VPN",
    "rem It never reads or writes %LOCALAPPDATA%\\Kepos\\windows, where the application",
    "rem keeps its identity and configuration, and it does not touch any other folder,",
    "rem including an unrelated %LOCALAPPDATA%\\Programs\\Kepos.",
    "",
    'set "SOURCE=%~dp0"',
    'set "TARGET=%LOCALAPPDATA%\\Programs\\Kepos VPN"',
    'set "CREATED="',
    "",
    "echo Kepos VPN installer",
    "echo.",
    "",
    "if not defined LOCALAPPDATA (",
    "  echo Cannot find LOCALAPPDATA. Run this from your own desktop session.",
    "  goto fail",
    ")",
    "",
    `for %%F in (${list(runtime)}) do if not exist "%SOURCE%%%F" (`,
    "  echo Missing %%F next to install.cmd.",
    "  echo Unpack the whole package first, then run install.cmd again.",
    "  goto fail",
    ")",
    "",
    'if exist "%TARGET%" (',
    "  echo Kepos VPN is already installed in:",
    "  echo   %TARGET%",
    "  echo Nothing was changed. Remove or rename that folder first if you want a",
    "  echo fresh install. Your identity in %LOCALAPPDATA%\\Kepos\\windows is kept.",
    "  goto fail",
    ")",
    "",
    'mkdir "%TARGET%" 2>nul',
    "if errorlevel 1 (",
    "  echo Could not create %TARGET%",
    "  echo Nothing was changed.",
    "  goto fail",
    ")",
    'set "CREATED=1"',
    "",
    'echo Copying Kepos VPN into "%TARGET%"',
    // /XC /XN /XO: never overwrite a file that already exists in the target, so a
    // file that appears after the folder was created is left alone. Exit codes
    // below 8 are success.
    `robocopy "%SOURCE%." "%TARGET%" ${list(runtime)} /XC /XN /XO /R:0 /W:0 /NJH /NJS /NP /NDL /NFL >nul`,
    "if errorlevel 8 (",
    "  echo Could not copy the Kepos files.",
    "  goto rollback",
    ")",
    'if exist "%SOURCE%licenses" (',
    '  robocopy "%SOURCE%licenses" "%TARGET%\\licenses" *.* /E /XC /XN /XO /R:0 /W:0 /NJH /NJS /NP /NDL /NFL >nul',
    "  if errorlevel 8 (",
    "    echo Could not copy the licence files.",
    "    goto rollback",
    "  )",
    ")",
    `robocopy "%SOURCE%." "%TARGET%" ${list(extra)} /XC /XN /XO /R:0 /W:0 /NJH /NJS /NP /NDL /NFL >nul`,
    "",
    "rem Every required file must be present before the application is started.",
    `for %%F in (${list(runtime)}) do if not exist "%TARGET%\\%%F" (`,
    "  echo %%F did not arrive.",
    "  goto rollback",
    ")",
    "",
    "echo.",
    "echo Installed. Starting Kepos VPN; Windows will ask for administrator",
    "echo rights, which the VPN needs.",
    'start "" "%TARGET%\\KeposVPN.exe"',
    "echo.",
    "echo Kepos VPN is installed in %TARGET%",
    "echo To remove it, quit it and delete that folder. Your identity stays in",
    "echo %LOCALAPPDATA%\\Kepos\\windows and is not touched by this installer.",
    "echo.",
    "pause",
    "exit /b 0",
    "",
    ":rollback",
    "if defined CREATED (",
    "  rem Only a folder this run created may be removed.",
    "  echo Installation failed; removing the incomplete copy in %TARGET%",
    '  rmdir /s /q "%TARGET%"',
    ")",
    "goto fail",
    "",
    ":fail",
    "echo.",
    "pause",
    "exit /b 1",
    "",
  ];
  writeFileSync(path.join(output, "install.cmd"), lines.join("\r\n"), { encoding: "ascii" });
}

// A standard per-user NSIS setup built with the locally installed makensis. It
// installs into its own folder, registers an uninstall entry, refuses a folder it
// does not own, and never touches the application state or the old Kepos folder.
function buildSetup() {
  const testBuild = process.env.KEPOS_TEST_BUILD === "1";
  const payloadDir = path.join(target, "diagnostics", "payload");
  if (testBuild) {
    mkdirSync(payloadDir, { recursive: true });
    // KeposVPN.exe is a fake text file: the install section requires the name,
    // and nothing ever executes it.
    for (const name of ["KeposVPN.exe", "fake-one.txt", "fake-two.txt"]) {
      writeFileSync(path.join(payloadDir, name), "fake payload, not an executable\n");
    }
  }
  const version = /^version = "([0-9.]+)"/mu.exec(
    readFileSync(path.join(windows, "Cargo.toml"), "utf8"),
  )?.[1];
  if (!version) throw new Error("Cannot read the workspace version");
  const work = path.join(target, "installer");
  mkdirSync(work, { recursive: true });

  // The uninstaller deletes exactly these files; nothing recurses into a folder
  // this installer does not own.
  const payload = [];
  const directories = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}\\${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        directories.push(relative);
        walk(path.join(dir, entry.name), relative);
      } else if (entry.name !== "install.cmd") payload.push(relative);
    }
  };
  // The test build packs its own payload folder, so the file list that the
  // installer and uninstaller delete has to come from that same folder.
  walk(testBuild ? payloadDir : output, "");
  // Deepest first: a directory can only be removed once it is empty.
  directories.sort((left, right) => right.split("\\").length - left.split("\\").length);

  const setupName = `KeposVPN-${version}-setup.exe`;
  const lines = [
    "Unicode true",
    "SetCompressor /SOLID lzma",
    ...(testBuild ? ["!define KEPOS_TEST_BUILD 1"] : []),
    '!include "MUI2.nsh"',
    ...(testBuild ? ['!include "FileFunc.nsh"', "Var TESTROOT"] : []),
    `!define LOGDIR "${testBuild ? "$TESTROOT\\log" : "$LOCALAPPDATA\\Kepos VPN Setup"}"`,
    `!include "${path.join(work, "decide-running.nsh")}"`,
    'Name "Kepos VPN"',
    `OutFile "${testBuild ? path.join(target, "diagnostics", "kepos-vpn-test-setup.exe") : path.join(work, setupName)}"`,
    `InstallDir "${testBuild ? "$TESTROOT\\install" : "$LOCALAPPDATA\\Programs\\Kepos VPN"}"`,
    "RequestExecutionLevel user",
    `VIProductVersion "${version}.0"`,
    'VIAddVersionKey "ProductName" "Kepos VPN"',
    'VIAddVersionKey "FileDescription" "Kepos VPN setup"',
    `VIAddVersionKey "FileVersion" "${version}"`,
    `VIAddVersionKey "ProductVersion" "${version}"`,
    "",
    '!define OWNER_MARKER ".kepos-vpn-owner"',
    '!define OWNER_TEXT "kepos-vpn-install-v1"',
    '!define APP_EXE "KeposVPN.exe"',
    '!define UNINST_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KeposVpn"',
    `!define STAGE "${testBuild ? "$TESTROOT\\stage" : "$LOCALAPPDATA\\Programs\\.kepos-vpn-stage"}"`,
    `!define BACKUP "${testBuild ? "$TESTROOT\\previous" : "$LOCALAPPDATA\\Programs\\.kepos-vpn-previous"}"`,
    "",
    "!macro DeleteOwned BASE",
    ...payload.map((relative) => '  Delete "${BASE}\\' + relative + '"'),
    ...directories.map((relative) => '  RMDir "${BASE}\\' + relative + '"'),
    '  Delete "${BASE}\\uninstall.exe"',
    '  Delete "${BASE}\\${OWNER_MARKER}"',
    '  RMDir "${BASE}"',
    "!macroend",
    "",
    '!insertmacro MUI_PAGE_WELCOME',
    '!insertmacro MUI_PAGE_INSTFILES',
    // Standard finish page: the run checkbox is ticked by default and starts the
    // installed application, whose own manifest asks for administrator rights.
    "  ; MUI's default run action uses Exec (CreateProcess), which cannot start a",
    "  ; program whose manifest requires elevation; the shell can. ExecShell also",
    "  ; matches what the Start Menu shortcut does.",
    '!define MUI_FINISHPAGE_RUN "$INSTDIR\\${APP_EXE}"',
    '!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp',
    '!define MUI_FINISHPAGE_RUN_TEXT "Launch Kepos VPN"',
    '!insertmacro MUI_PAGE_FINISH',
    '!insertmacro MUI_LANGUAGE "English"',
    '!insertmacro MUI_LANGUAGE "SimpChinese"',
    "",
    "Var UPGRADE",
    "",
    "Function LaunchApp",
    "  !ifdef KEPOS_TEST_BUILD",
    "  Return",
    "  !endif",
    "  ClearErrors",
    '  ExecShell "open" "$INSTDIR\\${APP_EXE}"',
    "  IfErrors launchFailed",
    '  !insertmacro Log "launch: requested through the shell"',
    "  Return",
    "  launchFailed:",
    '  !insertmacro Log "launch: shell request failed"',
    "  IfSilent +2",
    '  MessageBox MB_ICONINFORMATION "已安装。如果 Kepos VPN 没有自动打开，请从开始菜单启动。"',
    "  Return",
    "FunctionEnd",
    "",
    "Function .onGUIEnd",
    "  ; Close the log last, so finish-page and cancel paths still write to it.",
    "  Call LogClose",
    "FunctionEnd",
    "",
    "Function .onInit",
    ...(testBuild
      ? [
          "  ; Test build: every path must come from this run's own root.",
          "  ${GetParameters} $0",
          '  ${GetOptions} $0 "/TESTROOT=" $1',
          '  StrCmp $1 "" testRootMissing',
          '  StrCpy $2 $1 1',
          '  StrCmp $2 "$\\"" 0 +2',
          '  StrCpy $1 $1 -1 1',
          '  StrCpy $2 $1 1 -1',
          '  StrCmp $2 "$\\"" 0 +2',
          '  StrCpy $1 $1 -1',
          "  StrCpy $TESTROOT $1",
          '  StrCpy $INSTDIR "$TESTROOT\\install"',
          "  Goto testRootDone",
          "  testRootMissing:",
          "  IfSilent +2",
          '  MessageBox MB_ICONSTOP "Test build: /TESTROOT=<path> is required."',
          "  Abort",
          "  testRootDone:",
        ]
      : []),
    "  Call LogOpen",
    '  !insertmacro Log "start: checking target and running state"',
    '  !insertmacro Log "log: $LOGPATH"',
    '  StrCpy $UPGRADE ""',
    "  ; 1) Only this installer's own folder, or a new/empty one may be used.",
    '  StrCpy $R0 "$INSTDIR"',
    "  Call DirHasEntries",
    '  StrCmp $R1 "" checkRunning',
    '  IfFileExists "$INSTDIR\\${OWNER_MARKER}" 0 foreign',
    '  FileOpen $0 "$INSTDIR\\${OWNER_MARKER}" r',
    "  FileRead $0 $2",
    "  FileClose $0",
    '  StrCmp $2 "${OWNER_TEXT}" owned foreign',
    "  foreign:",
    '  !insertmacro Log "target: foreign folder refused"',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "目标文件夹已存在且不属于 Kepos VPN：$INSTDIR"',
    "  Abort",
    "  owned:",
    '  StrCpy $UPGRADE "1"',
    "  checkRunning:",
    "  ; 2) Refuse while the app is running. DecideRunning is shared with the",
    "  ;    regression probe, so both use exactly the same branches.",
    '  StrCpy $R0 "$INSTDIR\\${APP_EXE}"',
    "  Call DecideRunning",
    '  StrCmp $R1 "running:32" running',
    '  StrCmp $R1 "continue" notInstalled',
    '  StrCmp $R1 "continue:2" notInstalled',
    '  StrCmp $R1 "continue:3" notInstalled',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "无法确认 Kepos VPN 是否正在运行（$R1），未做任何改动。"',
    "  Abort",
    "  running:",
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "Kepos VPN 正在运行，请先退出后再安装。"',
    "  Abort",
    "  notInstalled:",
    "FunctionEnd",
    "",
    'Section "Install"',
    "  ; Nothing in $INSTDIR is touched until a complete copy exists in a folder",
    "  ; this installer created for this run.",
    '  IfFileExists "${STAGE}" 0 stageAbsent',
    '  !insertmacro Log "stage: already present, nothing changed"',
    "  IfSilent +2",
    '    MessageBox MB_ICONSTOP "临时目录已存在：${STAGE}，未做任何改动。请检查并移除它后重试。"',
    "    Abort",
    "  stageAbsent:",
    "  ; CreateDirectoryW is the atomic ownership test: 183 means it already exists.",
    '  System::Call \'kernel32::CreateDirectoryW(w "${STAGE}", p 0) i .r2 ?e\'',
    "  Pop $3",
    "  ; BOOL 0 is failure; the last error is only meaningful in that branch.",
    '  StrCmp $2 "0" 0 stageCreated',
    "  Goto stageBlocked",
    "  stageCreated:",
    "  ; Only a folder this run created and that stayed empty is ours to clean.",
    '  StrCpy $R0 "${STAGE}"',
    "  Call DirHasEntries",
    '  StrCmp $R1 "" stageOwned',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "临时目录里出现了其他内容（$R1）：${STAGE}$\\r$\\n没有删除或覆盖任何内容。请检查后自行移除它再重试。"',
    "  Abort",
    "  stageOwned:",
    '  SetOutPath "${STAGE}"',
    "  ClearErrors",
    `  File /r /x install.cmd "${testBuild ? payloadDir : output}\\*.*"`,
    "  IfErrors stageFailed",
    '  IfFileExists "${STAGE}\\${APP_EXE}" 0 stageFailed',
    "  ClearErrors",
    '  FileOpen $0 "${STAGE}\\${OWNER_MARKER}" w',
    "  IfErrors stageFailed",
    "  FileWrite $0 \"${OWNER_TEXT}\"",
    "  IfErrors markerFailed",
    "  FileClose $0",
    "  ; The working directory is still the stage folder; move it out first or the",
    "  ; rename and the cleanup below fail with a sharing violation.",
    '  SetOutPath "$PLUGINSDIR"',
    '  StrCmp $UPGRADE "1" upgrade firstInstall',
    "  firstInstall:",
    "  ; The folder is absent or empty. An empty folder must be removed first:",
    "  ; Rename would fail, and a non-recursive RMDir only succeeds when empty.",
    '  StrCpy $R0 "$INSTDIR"',
    "  Call DirHasEntries",
    '  StrCmp $R1 "" firstTargetEmpty',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "安装目录不是空的：$INSTDIR"',
    "  Abort",
    "  firstTargetEmpty:",
    '  RMDir "$INSTDIR"',
    "  ClearErrors",
    '  Rename "${STAGE}" "$INSTDIR"',
    "  IfErrors firstFailed",
    "  Goto installed",
    "  firstFailed:",
    '  !insertmacro Log "install: rename into place failed"',
    '  SetOutPath "$PLUGINSDIR"',
    '  !insertmacro DeleteOwned "${STAGE}"',
    '  IfFileExists "${STAGE}" 0 stageClean',
    '  !insertmacro Log "cleanup: staging folder still present: ${STAGE}"',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "安装未完成，临时文件未能完全清理：${STAGE}$\\r$\\n请查看日志：$LOGPATH"',
    "  Abort",
    "  stageClean:",
    '  StrCmp $LOGPATH "" stageCleanSilent',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "安装未完成，已清理本次的临时文件，原有内容未改动。$\\r$\\n日志：$LOGPATH"',
    "  stageCleanSilent:",
    "  Abort",
    "  upgrade:",
    '  IfFileExists "${BACKUP}" 0 upgradeSwap',
    "  IfSilent +2",
    '    MessageBox MB_ICONSTOP "存在上次升级留下的备份，请先检查：${BACKUP}"',
    "    Abort",
    "  upgradeSwap:",
    "  ; Keep the current installation until the new one is verified.",
    "  ClearErrors",
    '  Rename "$INSTDIR" "${BACKUP}"',
    "  IfErrors upgradeBlocked",
    "  ClearErrors",
    "  !ifdef KEPOS_TEST_BUILD",
    '  ReadEnvStr $R3 "KEPOS_TEST_FAULT"',
    '  StrCmp $R3 "swap" testSwapInject',
    '  StrCmp $R3 "swap-restore" 0 +2',
    "  testSwapInject:",
    "  Goto swapFailed",
    "  !endif",
    '  Rename "${STAGE}" "$INSTDIR"',
    "  IfErrors swapFailed",
    "  !ifdef KEPOS_TEST_BUILD",
    '  StrCmp $R3 "verify" testVerifyInject',
    '  StrCmp $R3 "verify-restore" 0 +2',
    "  testVerifyInject:",
    "  Goto verifyFailed",
    "  !endif",
    '  IfFileExists "$INSTDIR\\${APP_EXE}" 0 verifyFailed',
    '  !insertmacro DeleteOwned "${BACKUP}"',
    "  Goto installed",
    "  upgradeBlocked:",
    '  !insertmacro Log "upgrade: could not move the current installation aside"',
    '  !insertmacro DeleteOwned "${STAGE}"',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "无法暂存当前安装，未做任何改动。"',
    "  Abort",
    "  swapFailed:",
    '  !insertmacro Log "upgrade: staged tree could not be moved into place"',
    "  ; $INSTDIR does not exist here: the current installation is still in BACKUP.",
    "  ; It is renamed straight back; nothing is deleted unless that succeeds.",
    "  !ifdef KEPOS_TEST_BUILD",
    '  ReadEnvStr $R3 "KEPOS_TEST_FAULT"',
    '  StrCmp $R3 "swap-restore" 0 testRename',
    "  SetErrors",
    "  Goto testRenameDone",
    "  testRename:",
    "  !endif",
    "  ClearErrors",
    '  Rename "${BACKUP}" "$INSTDIR"',
    "  !ifdef KEPOS_TEST_BUILD",
    "  testRenameDone:",
    "  !endif",
    "  IfErrors restoreFailed",
    '  IfFileExists "$INSTDIR\\${APP_EXE}" 0 restoreFailed',
    '  !insertmacro DeleteOwned "${STAGE}"',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "更新未完成，已恢复原有安装。"',
    "  Abort",
    "  verifyFailed:",
    '  !insertmacro Log "upgrade: new tree failed verification"',
    "  ; The staged tree reached $INSTDIR: move it aside first, then rename BACKUP back.",
    "  !ifdef KEPOS_TEST_BUILD",
    '  ReadEnvStr $R3 "KEPOS_TEST_FAULT"',
    '  StrCmp $R3 "verify-restore" 0 testVerifyRename',
    "  SetErrors",
    "  Goto testVerifyRenameDone",
    "  testVerifyRename:",
    "  !endif",
    "  ClearErrors",
    '  Rename "$INSTDIR" "${STAGE}"',
    "  !ifdef KEPOS_TEST_BUILD",
    "  testVerifyRenameDone:",
    "  !endif",
    "  IfErrors restoreFailed",
    "  ClearErrors",
    '  Rename "${BACKUP}" "$INSTDIR"',
    "  IfErrors restoreFailed",
    '  IfFileExists "$INSTDIR\\${APP_EXE}" 0 restoreFailed',
    '  !insertmacro DeleteOwned "${STAGE}"',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "更新未完成，已恢复原有安装。"',
    "  Abort",
    "  restoreFailed:",
    '  !insertmacro Log "upgrade: restore failed, trees left in place"',
    '  IfFileExists "${BACKUP}\\*.*" 0 restoreFailedNoBackup',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "更新失败且无法自动恢复。原安装仍在：${BACKUP}$\\r$\\n请同时检查：$INSTDIR、${STAGE}$\\r$\\n请查看日志：$LOGPATH"',
    "  Abort",
    "  restoreFailedNoBackup:",
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "更新失败且无法自动恢复。原安装可能已复位到：$INSTDIR 但未通过校验，请一并检查：$INSTDIR、${STAGE}$\\r$\\n日志：$LOGPATH"',
    "  Abort",
    "  stageBlocked:",
    '  !insertmacro Log "stage: could not be created"',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "无法创建临时目录：${STAGE}，未做任何改动。"',
    "  Abort",
    "  markerFailed:",
    "  FileClose $0",
    "  stageFailed:",
    '  !insertmacro Log "stage: copy or marker failed"',
    "  ; The working directory may still be the stage folder; move out before",
    "  ; deleting it.",
    '  SetOutPath "$PLUGINSDIR"',
    '  !insertmacro DeleteOwned "${STAGE}"',
    '  IfFileExists "${STAGE}" 0 stageClean',
    '  !insertmacro Log "cleanup: staging folder still present: ${STAGE}"',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "安装未完成，临时文件未能完全清理：${STAGE}$\\r$\\n请查看日志：$LOGPATH"',
    '  StrCmp $LOGPATH "" +2',
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "安装未完成，已清理本次的临时文件，原有内容未改动。$\\r$\\n日志：$LOGPATH"',
    "  Abort",
    "  installed:",
    '  SetOutPath "$INSTDIR"',
    "  ClearErrors",
    '  WriteUninstaller "$INSTDIR\\uninstall.exe"',
    "  IfErrors uninstallerFailed",
    '  !insertmacro Log "uninstaller: written"',
    "  Goto uninstallerDone",
    "  uninstallerFailed:",
    '  !insertmacro Log "uninstaller: could not be written"',
    "  IfSilent +2",
    '  MessageBox MB_ICONEXCLAMATION "已安装，但卸载程序未写入：$INSTDIR"',
    "  uninstallerDone:",
    "  !ifndef KEPOS_TEST_BUILD",
    '  CreateDirectory "$SMPROGRAMS\\Kepos VPN"',
    '  CreateShortCut "$SMPROGRAMS\\Kepos VPN\\Kepos VPN.lnk" "$INSTDIR\\${APP_EXE}"',
    "  !endif",
    "  !ifndef KEPOS_TEST_BUILD",
    '  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Kepos VPN"',
    `  WriteRegStr HKCU "\${UNINST_KEY}" "DisplayVersion" "${version}"`,
    '  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Lamplit Isles"',
    '  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\\${APP_EXE}"',
    '  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"',
    `  WriteRegStr HKCU "\${UNINST_KEY}" "UninstallString" '"$INSTDIR\\uninstall.exe"'`,
    `  WriteRegStr HKCU "\${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\\uninstall.exe" /S'`,
    '  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1',
    '  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1',
    '  WriteRegStr HKCU "Software\\Kepos\\KeposVpn" "InstallDir" "$INSTDIR"',
    '  ReadRegStr $5 HKCU "${UNINST_KEY}" "DisplayName"',
    '  StrCmp $5 "Kepos VPN" registryVerified',
    '  !insertmacro Log "registry: uninstall entry could not be verified"',
    "  IfSilent +2",
    '  MessageBox MB_ICONEXCLAMATION "已安装，但卸载项未写入；详见日志。"',
    "  registryVerified:",
    "  !endif",
    '  !insertmacro Log "installed: $INSTDIR"',
    '  StrCmp $LOGERROR "" logErrorDone',
    "  IfSilent +2",
    '  MessageBox MB_ICONEXCLAMATION "安装日志写入不完整（错误 $LOGERROR）：$LOGPATH"',
    "  logErrorDone:",
    "  !ifndef KEPOS_TEST_BUILD",
    '  IfFileExists "$SMPROGRAMS\\Kepos VPN\\Kepos VPN.lnk" 0 shortcutFailed',
    '  !insertmacro Log "shortcut: ok"',
    "  Goto registryDone",
    "  shortcutFailed:",
    '  !insertmacro Log "shortcut: could not be created (error flag set)"',
    "  registryDone:",
    "  !endif",
    "SectionEnd",
    "",
    'Section "Uninstall"',
    "  ; Refuse to delete anything that is not this installer's own folder.",
    '  IfFileExists "$INSTDIR\\${OWNER_MARKER}" 0 foreign',
    '  FileOpen $0 "$INSTDIR\\${OWNER_MARKER}" r',
    "  FileRead $0 $1",
    "  FileClose $0",
    '  StrCmp $1 "${OWNER_TEXT}" owned foreign',
    "  foreign:",
    "  IfSilent +2",
    '  MessageBox MB_ICONSTOP "该文件夹不属于 Kepos VPN，未删除任何内容：$INSTDIR"',
    "  Abort",
    "  owned:",
    "  ; Only the files this package installed are deleted, and only inside its own",
    "  ; folder. The identity in %LOCALAPPDATA%\\Kepos\\windows is never touched.",
    '  !insertmacro DeleteOwned "$INSTDIR"',
    "  !ifndef KEPOS_TEST_BUILD",
    '  Delete "$SMPROGRAMS\\Kepos VPN\\Kepos VPN.lnk"',
    '  RMDir "$SMPROGRAMS\\Kepos VPN"',
    '  DeleteRegKey HKCU "${UNINST_KEY}"',
    '  DeleteRegKey HKCU "Software\\Kepos\\KeposVpn"',
    "  !endif",
    "SectionEnd",
    "",
  ];
  const decision = path.join(work, "decide-running.nsh");
  writeFileSync(
    decision,
    [
      "!ifndef KEPOS_DECIDE_RUNNING",
      "!define KEPOS_DECIDE_RUNNING",
      "Var LOGH",
      "Var LOGTEXT",
      "Var LOGLEN",
      "Var LOGFAILED",
      "Var LOGERROR",
      "Var LOGPATH",
      "",
      "; Opens a per-run log under %LOCALAPPDATA%\\Kepos VPN Setup. Only steps,",
      "; results and error codes are written: never invitations, seeds or identity.",
      "Function LogOpen",
      '  CreateDirectory "${LOGDIR}"',
      '  StrCpy $LOGH ""',
      '  StrCpy $LOGFAILED ""',
      '  StrCpy $LOGERROR ""',
      "  ; .r8 writes NSIS $8, so the name below uses $8 too.",
      "  System::Call 'kernel32::GetCurrentProcessId() i .r8'",
      '  StrCpy $LOGPATH ""',
      "  StrCpy $9 0",
      "  logTry:",
      "  IntOp $9 $9 + 1",
      "  IntCmp $9 1 logPlain logSuffix logSuffix",
      "  logPlain:",
      '  StrCpy $LOGPATH "${LOGDIR}\\install-$8.log"',
      "  Goto logCreate",
      "  logSuffix:",
      '  StrCpy $LOGPATH "${LOGDIR}\\install-$8-$9.log"',
      "  logCreate:",
      "  ; CREATE_NEW is the exclusive test: 183 means the name is taken.",
      '  System::Call \'kernel32::CreateFileW(w "$LOGPATH", i 0x40000000, i 0x1, p 0, i 1, i 0x80, p 0) p .r7 ?e\'',
      "  Pop $6",
      '  StrCmp $7 "-1" 0 logCreated',
      '  StrCmp $6 "183" 0 logNone',
      "  IntCmp $9 9 logNone logTry logTry",
      "  logCreated:",
      "  ; The handle is kept for every line, so no path is reopened.",
      '  StrCpy $LOGH $7',
      "  ; UTF-16LE BOM so Notepad reads the file correctly.",
      "  System::Alloc 2",
      "  Pop $0",
      "  System::Call '*$0(&i2 0xFEFF)'",
      '  System::Call \'kernel32::WriteFile(p $LOGH, p $0, i 2, *i .r5, p 0) i .r6 ?e\'',
      "  Pop $7",
      "  System::Free $0",
      '  StrCmp $6 "0" logBomFailed',
      '  StrCmp $5 "2" logDone logBomFailed',
      "  logBomFailed:",
      '  StrCpy $LOGFAILED "1"',
      '  StrCpy $LOGERROR "$7"',
      "  Goto logDone",
      "  logNone:",
      '  StrCpy $LOGPATH ""',
      "  logDone:",
      '  StrCpy $LOGTEXT "Kepos VPN setup"',
      "  Call LogLine",
      "FunctionEnd",
      "",
      "; Appends $LOGTEXT as one line through the CreateFileW handle. A failed or",
      "; short write is recorded once and later lines are skipped; the handle stays",
      "; open so LogClose can still close it.",
      "Function LogLine",
      '  StrCmp $LOGFAILED "" +2',
      "  Return",
      '  StrCmp $LOGH "" 0 +2',
      "  Return",
      '  StrCpy $LOGTEXT "$LOGTEXT$\\r$\\n"',
      "  StrLen $LOGLEN $LOGTEXT",
      "  IntOp $LOGLEN $LOGLEN * 2",
      '  System::Call \'kernel32::WriteFile(p $LOGH, w "$LOGTEXT", i $LOGLEN, *i .r5, p 0) i .r6 ?e\'',
      "  Pop $7",
      '  StrCmp $6 "0" logFailed',
      '  StrCmp $5 "$LOGLEN" logDone logFailed',
      "  logFailed:",
      '  StrCpy $LOGFAILED "1"',
      '  StrCpy $LOGERROR "$7"',
      "  logDone:",
      "  Return",
      "FunctionEnd",
      "",
      "Function LogClose",
      '  StrCmp $LOGH "" +3',
      '  StrCmp $LOGH "-1" +2',
      "  System::Call 'kernel32::CloseHandle(p $LOGH)'",
      '  StrCpy $LOGH ""',
      "FunctionEnd",
      "",
      "!macro Log TEXT",
      '  StrCpy $LOGTEXT "${TEXT}"',
      "  Call LogLine",
      "!macroend",
      "",
      "!macro LogFail TEXT",
      '  !insertmacro Log "${TEXT}"',
      '  StrCmp $LOGPATH "" +2',
      "  IfSilent +2",
      '  MessageBox MB_ICONSTOP "${TEXT}$\\r$\\n$\\r$\\nLog: $LOGPATH"',
      '  StrCmp $LOGPATH "" 0 +2',
      "  IfSilent +2",
      '  MessageBox MB_ICONSTOP "${TEXT}$\\r$\\n$\\r$\\nThe log could not be created."',
      "!macroend",
      "; Input:  $R0 = full path of the application executable.",
      "; Output: $R1 = continue | continue:2 | continue:3 | running:32 | abort:<code>",
      "; A loaded image is mapped and held against write access, so the open fails",
      "; with 32 while it runs. The error comes from the plug-in's ?e form: a",
      "; separate GetLastError() returned a stale code (80) in the isolated probe.",
      "Function DecideRunning",
      "  ; System::Call writes to the NSIS register named by .rN: .r2 is $2, not $R2.",
      "  ; $2 and $3 are scratch registers, clobbered by this function.",
      '  System::Call \'kernel32::CreateFileW(w "$R0", i 0x40000000, i 0x1, p 0, i 3, i 0x80, p 0) p .r2 ?e\'',
      "  Pop $3",
      '  StrCmp $2 "-1" drInvalid drOpen',
      "  drInvalid:",
      '  StrCmp $3 "32" drRunning',
      '  StrCmp $3 "2" drMissing',
      '  StrCmp $3 "3" drMissing',
      '  StrCpy $R1 "abort:$3"',
      "  Return",
      "  drRunning:",
      '  StrCpy $R1 "running:32"',
      "  Return",
      "  drMissing:",
      '  StrCpy $R1 "continue:$3"',
      "  Return",
      "  drOpen:",
      "  System::Call 'kernel32::CloseHandle(p $2)'",
      '  StrCpy $R1 "continue"',
      "  Return",
      "FunctionEnd",
      "",
      "; Input:  $R0 = directory. Output: $R1 = first real entry name, or empty.",
      "; Skips the . and .. entries that directory enumeration may return.",
      "Function DirHasEntries",
      '  FindFirst $2 $3 "$R0\\*"',
      "  dheLoop:",
      '  StrCmp $3 "" dheNone',
      '  StrCmp $3 "." dheNext',
      '  StrCmp $3 ".." dheNext',
      "  FindClose $2",
      "  StrCpy $R1 $3",
      "  Return",
      "  dheNext:",
      "  FindNext $2 $3",
      "  Goto dheLoop",
      "  dheNone:",
      "  FindClose $2",
      '  StrCpy $R1 ""',
      "  Return",
      "FunctionEnd",
      "!endif",
      "",
    ].join("\n"),
  );
  const script = path.join(work, "kepos-vpn.nsi");
  writeFileSync(script, lines.join("\n"));
  run("makensis", ["-V2", script]);
  // The test build writes its setup to the diagnostics folder; report and check
  // that path instead of the release one.
  const setup = testBuild
    ? path.join(target, "diagnostics", "kepos-vpn-test-setup.exe")
    : path.join(work, setupName);
  if (!existsSync(setup)) throw new Error("makensis did not produce the setup executable");
  process.stdout.write(`Setup: ${setup}\n`);
}

function cargo() {
  return path.join(process.env.CARGO_HOME ?? path.join(process.env.HOME ?? "", ".cargo"), "bin/cargo");
}

// 5. Static checks only: this does not run anything on Windows.
const imports = outputOf(bin("llvm-readobj"), ["--coff-imports", path.join(output, "KeposVPN.exe")]);
if (!imports.includes("bare-kit.dll")) throw new Error("The executable does not import bare-kit.dll");
const exported = outputOf(bin("llvm-readobj"), ["--coff-exports", path.join(output, "KeposVPN.exe")]);
if (!exported.includes("bare_module_find")) throw new Error("The executable does not re-export bare_module_find");
if (!readFileSync(path.join(output, "KeposVPN.exe")).includes("requireAdministrator")) {
  throw new Error("The administrator manifest is missing from the executable");
}
for (const addon of ["bare-inspect-3.1.4.dll", "bare-type-1.4.0.dll", "sodium-native-5.1.0.dll", "udx-native-1.20.7.dll"]) {
  if (!existsSync(path.join(output, addon))) throw new Error(`Missing linked addon: ${addon}`);
}

if (ownsGenerated) rmSync(generated, { recursive: true, force: true });
console.log(`Package: ${output}`);
console.log("Static checks passed; nothing has been run on Windows.");
