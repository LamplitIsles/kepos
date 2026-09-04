import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { generateBootstrapAsset } from "../scripts/generate-bootstrap-asset.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powerShellOnWsl = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const buildScript = path.join(repository, "scripts", "windows", "build-kepos.ps1");
const pchCacheScript = path.join(repository, "scripts", "windows", "pch-cache.ps1");
const peArchitectureScript = path.join(repository, "scripts", "windows", "assert-pe64.ps1");
const windowsInstallerScripts = [
  "assert-pe64.ps1",
  "icon-resources.ps1",
  "install.ps1",
  "uninstall.ps1",
  "installer-acceptance.ps1",
];
const controlScript = path.join(repository, "scripts", "windows", "nuc-kep.sh");
const trackedManifestScript = path.join(
  repository,
  "scripts",
  "windows",
  "tracked-manifest.sh",
);

const isolatedGitEnvironment = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_WORK_TREE: undefined,
};

function windowsPath(file: string): string | undefined {
  if (process.platform === "win32") return file;
  if (!existsSync(powerShellOnWsl)) return undefined;
  const result = spawnSync("wslpath", ["-w", file], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: isolatedGitEnvironment,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("Windows host input is sanitized and required generation rejects missing config", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kepos-windows-bootstrap-input-"));
  const configHome = path.join(root, "config-home");
  const configDirectory = path.join(configHome, "kepos");
  const outputPath = path.join(root, "run", "kepos-bootstrap.json");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    path.join(configDirectory, "config.toml"),
    [
      "[network]",
      'bootstrap = ["bootstrap-one.example:49737"]',
      "",
      "[publisher]",
      'display_name = "must not cross the NUC boundary"',
      "subscribers = []",
      "services = []",
      "",
      "[subscriber]",
      "enabled = true",
      "services = []",
      "",
    ].join("\n"),
  );

  try {
    await generateBootstrapAsset([outputPath, "required"], {
      XDG_CONFIG_HOME: configHome,
    });
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), [
      { host: "bootstrap-one.example", port: 49_737 },
    ]);
    assert.doesNotMatch(readFileSync(outputPath, "utf8"), /publisher|subscriber|must not cross/);

    await assert.rejects(
      generateBootstrapAsset([
        path.join(root, "missing", "kepos-bootstrap.json"),
        "required",
      ], {
        XDG_CONFIG_HOME: path.join(root, "missing-config"),
      }),
      /required.*empty/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows NUC transfer keeps the bootstrap input separate from tracked source", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kepos-windows-transfer-seam-"));
  const fakeBin = path.join(root, "fake-bin");
  const fakeState = path.join(root, "fake-state");
  mkdirSync(path.join(root, "scripts", "windows"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(fakeState, { recursive: true });

  for (const file of [
    "scripts/windows/nuc-kep.sh",
    "scripts/windows/tracked-manifest.sh",
    "scripts/generate-bootstrap-asset.ts",
  ]) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repository, file), target);
    if (file.endsWith(".sh")) chmodSync(target, 0o755);
  }
  writeFileSync(
    path.join(root, ".gitignore"),
    ".env\nlive-config.toml\nunrelated-untracked.txt\ndist/\nvendor/\nfake-bin/\nfake-state/\n",
  );
  writeFileSync(path.join(root, "tracked.txt"), "tracked\n");
  writeFileSync(path.join(root, ".env"), "credential=not-for-transfer\n");
  writeFileSync(path.join(root, "live-config.toml"), "complete config\n");
  writeFileSync(path.join(root, "unrelated-untracked.txt"), "unrelated\n");

  for (const name of ["bare-native", "bare-win-ui", "bare-app-kit"]) {
    const directory = path.join(root, "vendor", "holepunch", name);
    mkdirSync(directory, { recursive: true });
    runGit(directory, ["init", "--quiet"]);
    runGit(directory, ["config", "user.email", "test@example.invalid"]);
    runGit(directory, ["config", "user.name", "Workflow Test"]);
    writeFileSync(path.join(directory, "tracked.txt"), `${name}\n`);
    runGit(directory, ["add", "tracked.txt"]);
    runGit(directory, ["commit", "--quiet", "-m", "fixture"]);
  }

  const fakeNode = path.join(fakeBin, "node");
  writeFileSync(
    fakeNode,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ \${FAKE_NODE_FAIL:-0} == 1 ]]; then exit 91; fi
if [[ "\${3:-}" == "scripts/generate-bootstrap-asset.ts" ]]; then
  printf '%s\n' '[{"host":"bootstrap.example","port":49737}]' > "\${4}"
  exit 0
fi
if [[ "\${3:-}" == "--input-type=module" && "\${6:-}" == "v0.3.0-beta.1" ]]; then
  if [[ "\${7:-}" == "rehearsal" ]]; then
    printf '%s\n' 'dist/release/rehearsal-v0.3.0-beta.1\tkepos-windows-x64.zip'
  elif [[ "\${7:-}" == "release" ]]; then
    printf '%s\n' 'dist/release/v0.3.0-beta.1\tkepos-windows-x64.zip'
  else
    exit 92
  fi
  exit 0
fi
printf '%s\n' 'unexpected fake node invocation' >&2
exit 92
`,
  );
  chmodSync(fakeNode, 0o755);
  const fakeSsh = path.join(fakeBin, "ssh");
  writeFileSync(
    fakeSsh,
    `#!/usr/bin/env bash
set -euo pipefail
count_file="\${FAKE_ROOT}/ssh-count"
count=0
if [[ -f "\${count_file}" ]]; then count="\$(cat "\${count_file}")"; fi
count="\$((count + 1))"
printf '%s' "\${count}" > "\${count_file}"
printf '%s\n' "\${*:2}" > "\${FAKE_ROOT}/ssh-command-\${count}"
cat > "\${FAKE_ROOT}/ssh-input-\${count}"
if (( count % 2 == 0 )); then cp "\${FAKE_ROOT}/ssh-input-\${count}" "\${FAKE_ROOT}/archive-\${count}.tar"; fi
if (( count % 2 == 0 )); then printf '%s\n' 'remote workflow signal'; fi
`,
  );
  chmodSync(fakeSsh, 0o755);
  const fakeScp = path.join(fakeBin, "scp");
  writeFileSync(
    fakeScp,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ \${1:-} == -r ]]; then shift; fi
source="\${1}"
destination="\${2}"
if [[ "\${destination}" == *kepos-bootstrap.json ]]; then
  cp "\${source}" "\${FAKE_ROOT}/remote-bootstrap.json"
elif [[ "\${source}" == */logs ]]; then
  destination="\${destination%/}"
  mkdir -p "\${destination}/logs"
  printf '%s\n' 'logs' > "\${destination}/logs/transfer.marker"
elif [[ "\${source}" == */dist/desktop ]]; then
  destination="\${destination%/}"
  mkdir -p "\${destination}/desktop"
  printf '%s\n' 'desktop' > "\${destination}/desktop/transfer.marker"
elif [[ "\${source}" == *kepos-windows-x64.zip ]]; then
  destination="\${destination%/}"
  temporary="\$(mktemp -d)"
  printf '%s\n' 'windows artifact' > "\${temporary}/payload.txt"
  (cd "\${temporary}" && zip -q "\${destination}" payload.txt)
  rm -rf "\${temporary}"
else
  printf '%s\n' 'unexpected fake scp invocation' >&2
  exit 93
fi
`,
  );
  chmodSync(fakeScp, 0o755);

  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "test@example.invalid"]);
  runGit(root, ["config", "user.name", "Workflow Test"]);
  runGit(root, ["add", ".gitignore", "tracked.txt", "scripts"]);
  runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  runGit(root, ["remote", "add", "origin", "https://example.invalid/kepos.git"]);

  const environment = {
    ...isolatedGitEnvironment,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    WINDOWS_USER: "test",
    FAKE_ROOT: fakeState,
  };
  try {
    const result = spawnSync("bash", ["scripts/windows/nuc-kep.sh"], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const archiveListing = spawnSync("tar", ["-tf", path.join(fakeState, "archive-2.tar")], {
      encoding: "utf8",
    });
    assert.equal(archiveListing.status, 0, archiveListing.stderr);
    assert.match(archiveListing.stdout, /tracked\.txt/);
    assert.doesNotMatch(archiveListing.stdout, /\.env|live-config|unrelated-untracked|kepos-bootstrap/);
    assert.equal(
      readFileSync(path.join(fakeState, "remote-bootstrap.json"), "utf8"),
      '[{"host":"bootstrap.example","port":49737}]\n',
    );
    const windowsRuns = readdirSync(path.join(root, "dist", "windows"));
    assert.ok(windowsRuns.length > 0);
    assert.match(
      readFileSync(
        path.join(root, "dist", "windows", windowsRuns[0]!, "remote-command.log"),
        "utf8",
      ),
      /remote workflow signal/,
    );

    const beta = spawnSync(
      "bash",
      ["scripts/windows/nuc-kep.sh", "v0.3.0-beta.1", "--rehearsal"],
      { cwd: root, encoding: "utf8", env: environment },
    );
    assert.equal(beta.status, 0, beta.stderr || beta.stdout);
    assert.equal(
      existsSync(
        path.join(
          root,
          "dist/release/rehearsal-v0.3.0-beta.1/kepos-windows-x64.zip",
        ),
      ),
      true,
    );
    runGit(root, ["tag", "-a", "v0.3.0-beta.1", "-m", "v0.3.0-beta.1"]);
    const formalBeta = spawnSync(
      "bash",
      ["scripts/windows/nuc-kep.sh", "v0.3.0-beta.1"],
      { cwd: root, encoding: "utf8", env: environment },
    );
    assert.equal(formalBeta.status, 0, formalBeta.stderr || formalBeta.stdout);
    assert.equal(
      existsSync(
        path.join(root, "dist/release/v0.3.0-beta.1/kepos-windows-x64.zip"),
      ),
      true,
    );

    const dogfoodCommand = readFileSync(path.join(fakeState, "ssh-command-2"), "utf8");
    const rehearsalCommand = readFileSync(path.join(fakeState, "ssh-command-4"), "utf8");
    const formalCommand = readFileSync(path.join(fakeState, "ssh-command-6"), "utf8");
    assert.match(dogfoodCommand, /C:\\kb\\runs\\test/);
    assert.match(rehearsalCommand, /C:\\kb\\runs\\test/);
    assert.doesNotMatch(rehearsalCommand, /C:\\kb\\runs\\formal/);
    assert.match(formalCommand, /C:\\kb\\runs\\formal/);
    assert.match(formalCommand, /BootstrapAsset/);
    assert.match(formalCommand, /kepos-bootstrap\.json/);

    const failed = spawnSync("bash", ["scripts/windows/nuc-kep.sh"], {
      cwd: root,
      encoding: "utf8",
      env: { ...environment, FAKE_NODE_FAIL: "1" },
    });
    assert.notEqual(failed.status, 0);
    assert.equal(existsSync(path.join(fakeState, "ssh-command-7")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows transfer manifest includes tracked submodule files and no live state", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kepos-windows-manifest-"));
  const submodule = path.join(root, "submodule-source");
  const checkout = path.join(root, "checkout");
  mkdirSync(submodule);
  mkdirSync(checkout);

  try {
    runGit(submodule, ["init", "--quiet"]);
    runGit(submodule, ["config", "user.email", "test@example.invalid"]);
    runGit(submodule, ["config", "user.name", "Workflow Test"]);
    writeFileSync(path.join(submodule, "tracked-submodule.txt"), "tracked\n");
    runGit(submodule, ["add", "tracked-submodule.txt"]);
    runGit(submodule, ["commit", "--quiet", "-m", "fixture"]);

    runGit(checkout, ["init", "--quiet"]);
    runGit(checkout, ["config", "user.email", "test@example.invalid"]);
    runGit(checkout, ["config", "user.name", "Workflow Test"]);
    writeFileSync(path.join(checkout, ".gitignore"), ".env\n.npmrc\nlive-state.json\n");
    writeFileSync(path.join(checkout, "tracked\nname.txt"), "tracked\n");
    writeFileSync(path.join(checkout, ".env"), "secret=not-for-transfer\n");
    writeFileSync(path.join(checkout, ".npmrc"), "//registry.example.invalid/:_authToken=secret\n");
    writeFileSync(path.join(checkout, "live-state.json"), "live\n");
    runGit(checkout, ["add", ".gitignore", "tracked\nname.txt"]);
    runGit(checkout, ["commit", "--quiet", "-m", "root-fixture"]);
    const addSubmodule = spawnSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", submodule, "vendor/sample"],
      { cwd: checkout, encoding: "utf8", env: isolatedGitEnvironment },
    );
    assert.equal(addSubmodule.status, 0, addSubmodule.stderr || addSubmodule.stdout);
    runGit(checkout, ["add", ".gitmodules", "vendor/sample"]);
    runGit(checkout, ["commit", "--quiet", "-m", "submodule-fixture"]);

    const result = spawnSync("bash", [trackedManifestScript, checkout], {
      encoding: "buffer",
      env: isolatedGitEnvironment,
    });
    assert.equal(result.status, 0, result.stderr.toString() || result.stdout.toString());
    const manifest = result.stdout.toString("utf8").split("\0").filter(Boolean);
    assert.ok(manifest.includes("tracked\nname.txt"));
    assert.ok(manifest.includes("vendor/sample/tracked-submodule.txt"));
    assert.ok(!manifest.includes(".env"));
    assert.ok(!manifest.includes(".npmrc"));
    assert.ok(!manifest.includes("live-state.json"));
    assert.equal(readFileSync(path.join(submodule, "tracked-submodule.txt"), "utf8"), "tracked\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows workflow rejects dirty recursive submodules before transfer", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kepos-windows-dirty-submodule-"));
  const submodule = path.join(root, "submodule-source");
  const checkout = path.join(root, "checkout");
  mkdirSync(submodule);
  mkdirSync(checkout);
  try {
    runGit(submodule, ["init", "--quiet"]);
    runGit(submodule, ["config", "user.email", "test@example.invalid"]);
    runGit(submodule, ["config", "user.name", "Workflow Test"]);
    writeFileSync(path.join(submodule, "tracked.txt"), "clean\\n");
    runGit(submodule, ["add", "tracked.txt"]);
    runGit(submodule, ["commit", "--quiet", "-m", "fixture"]);
    runGit(checkout, ["init", "--quiet"]);
    runGit(checkout, ["config", "user.email", "test@example.invalid"]);
    runGit(checkout, ["config", "user.name", "Workflow Test"]);
    writeFileSync(path.join(checkout, ".gitignore"), "dist/\\n");
    runGit(checkout, ["add", ".gitignore"]);
    runGit(checkout, ["commit", "--quiet", "-m", "root"]);
    const addSubmodule = spawnSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", submodule, "vendor/sample"],
      { cwd: checkout, encoding: "utf8", env: isolatedGitEnvironment },
    );
    assert.equal(addSubmodule.status, 0, addSubmodule.stderr || addSubmodule.stdout);
    runGit(checkout, ["commit", "--quiet", "-am", "submodule"]);
    writeFileSync(path.join(checkout, "vendor/sample", "tracked.txt"), "dirty\\n");
    mkdirSync(path.join(checkout, "scripts", "windows"), { recursive: true });
    writeFileSync(
      path.join(checkout, "scripts", "windows", "nuc-kep.sh"),
      readFileSync(controlScript),
    );
    const result = spawnSync("bash", ["scripts/windows/nuc-kep.sh"], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...isolatedGitEnvironment, WINDOWS_USER: "test" },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\\n${result.stderr}`, /dirty/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows build PowerShell parses with the supported Windows PowerShell", (t) => {
  const script = windowsPath(buildScript);
  if (!script) {
    t.skip("the exact Windows PowerShell executable is unavailable");
    return;
  }

  const escapedScript = script.replace(/'/g, "''");
  const command = [
    "$tokens = $null",
    "$errors = $null",
    `[System.Management.Automation.Language.Parser]::ParseFile('${escapedScript}', [ref]$tokens, [ref]$errors) > $null`,
    "if ($errors.Count -gt 0) { $errors | Out-Host; exit 1 }",
  ].join("; ");
  const result = spawnSync(
    process.platform === "win32" ? "powershell.exe" : powerShellOnWsl,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Windows installer and icon PowerShell scripts parse with Windows PowerShell", (t) => {
  const scripts = [buildScript, ...windowsInstallerScripts.map((name) => path.join(repository, "scripts", "windows", name))];
  const windowsScripts = scripts.map(windowsPath);
  if (windowsScripts.some((script) => !script)) {
    t.skip("the exact Windows PowerShell executable is unavailable");
    return;
  }

  const powershell = process.platform === "win32" ? "powershell.exe" : powerShellOnWsl;
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const command = windowsScripts
    .map((script) => `[System.Management.Automation.Language.Parser]::ParseFile(${quote(script!)}, [ref]$tokens, [ref]$errors) > $null; if ($errors.Count -gt 0) { $errors | Out-Host; exit 1 }`)
    .join("; ");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", `$tokens = $null; $errors = $null; ${command}`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Windows PE architecture gate accepts x64 and rejects another machine", (t) => {
  const script = windowsPath(peArchitectureScript);
  if (!script) {
    t.skip("the exact Windows PowerShell executable is unavailable");
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "kepos-windows-pe64-"));
  const x64 = path.join(root, "x64.exe");
  const x86 = path.join(root, "x86.exe");
  const createPe = (machine: number): Buffer => {
    const bytes = Buffer.alloc(70);
    bytes.writeInt32LE(64, 0x3c);
    bytes.write("PE\0\0", 64, "binary");
    bytes.writeUInt16LE(machine, 68);
    return bytes;
  };
  writeFileSync(x64, createPe(0x8664));
  writeFileSync(x86, createPe(0x014c));

  try {
    const powershell = process.platform === "win32" ? "powershell.exe" : powerShellOnWsl;
    const x64Path = windowsPath(x64);
    const x86Path = windowsPath(x86);
    assert.ok(x64Path && x86Path);
    const accepted = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-File", script, "-Executable", x64Path],
      { encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

    const rejected = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-File", script, "-Executable", x86Path],
      { encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0, rejected.stderr || rejected.stdout);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /must be x64.*0x014c/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows PCH cache probe removes only generated hxx outputs", (t) => {
  const script = windowsPath(pchCacheScript);
  if (!script) {
    t.skip("the exact Windows PowerShell executable is unavailable");
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "kepos-windows-pch-cache-"));
  const cache = path.join(root, "cache", "winui", "CMakeFiles");
  const outside = path.join(root, "outside");
  const powershell = process.platform === "win32" ? "powershell.exe" : powerShellOnWsl;
  const toWindowsPath = (value: string): string => {
    const converted = windowsPath(value);
    assert.ok(converted, `could not convert test path to Windows form: ${value}`);
    return converted;
  };
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const generated = [
    path.join(cache, "cmake_pch.hxx.obj"),
    path.join(cache, "cmake_pch.hxx.pch"),
    path.join(cache, "nested", "cmake_pch.hxx.obj.d"),
  ];

  mkdirSync(path.join(cache, "nested"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  for (const file of generated) writeFileSync(file, "generated\n");
  writeFileSync(path.join(cache, "cmake_pch.cxx.pch"), "legacy\n");
  writeFileSync(path.join(cache, "other.pch"), "unrelated\n");
  writeFileSync(path.join(outside, "cmake_pch.hxx.pch"), "outside\n");

  try {
    const command = [
      `. ${quote(toWindowsPath(script))}`,
      `Remove-CachedCMakePchOutputs ${quote(toWindowsPath(cache))} | Out-Null`,
    ].join("; ");
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const file of generated) assert.equal(existsSync(file), false, file);
    assert.equal(existsSync(path.join(cache, "cmake_pch.cxx.pch")), true);
    assert.equal(existsSync(path.join(cache, "other.pch")), true);
    assert.equal(existsSync(path.join(outside, "cmake_pch.hxx.pch")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows workflow rejects reparse-point run directories", (t) => {
  const script = windowsPath(buildScript);
  if (!script) {
    t.skip("the exact Windows PowerShell executable is unavailable");
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "kepos-windows-reparse-point-"));
  const workspace = path.join(root, "workspace");
  const repositorySnapshot = path.join(workspace, "repository");
  const runDirectory = path.join(workspace, "20260101T000000Z");
  const outside = path.join(root, "outside");
  const tools = path.join(root, "tools");
  const sentinel = path.join(outside, "sentinel.txt");
  const powershell = process.platform === "win32" ? "powershell.exe" : powerShellOnWsl;
  const toWindowsPath = (value: string): string => {
    const converted = windowsPath(value);
    assert.ok(converted, `could not convert test path to Windows form: ${value}`);
    return converted;
  };
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

  mkdirSync(repositorySnapshot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(sentinel, "test-owned sentinel\n");

  try {
    const junction = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `New-Item -ItemType Junction -Path ${quote(toWindowsPath(runDirectory))} -Target ${quote(toWindowsPath(outside))} | Out-Null`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(junction.status, 0, junction.stderr || junction.stdout);

    const result = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        script,
        "-Repository",
        toWindowsPath(repositorySnapshot),
        "-RunDirectory",
        toWindowsPath(runDirectory),
        "-WorkspaceRoot",
        toWindowsPath(workspace),
        "-ToolsDirectory",
        toWindowsPath(tools),
        "-RunId",
        "20260101T000000Z",
        "-RootRevision",
        "root",
        "-BareNativeRevision",
        "native",
        "-BareWinUiRevision",
        "win-ui",
        "-BareAppKitRevision",
        "app-kit",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /reparse point/i);
    assert.equal(readFileSync(sentinel, "utf8"), "test-owned sentinel\n");
    assert.equal(existsSync(path.join(outside, ".kepos-windows-workflow-run")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows release preserves pre-existing output when it rejects the run", (t) => {
  const script = windowsPath(buildScript);
  if (!script) {
    t.skip("the exact Windows PowerShell executable is unavailable");
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "kepos-windows-existing-release-"));
  const workspace = path.join(root, "workspace");
  const repositorySnapshot = path.join(workspace, "repository");
  const runDirectory = path.join(workspace, "20260101T000001Z");
  const tools = path.join(root, "tools");
  const artifactName = "kepos-windows-x64.zip";
  const artifact = path.join(runDirectory, artifactName);
  const toWindowsPath = (value: string): string => {
    const converted = windowsPath(value);
    assert.ok(converted, `could not convert test path to Windows form: ${value}`);
    return converted;
  };

  mkdirSync(repositorySnapshot, { recursive: true });
  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(artifact, "pre-existing artifact\n");

  try {
    const result = spawnSync(
      process.platform === "win32" ? "powershell.exe" : powerShellOnWsl,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        script,
        "-Repository",
        toWindowsPath(repositorySnapshot),
        "-RunDirectory",
        toWindowsPath(runDirectory),
        "-WorkspaceRoot",
        toWindowsPath(workspace),
        "-ToolsDirectory",
        toWindowsPath(tools),
        "-RunId",
        "20260101T000001Z",
        "-RootRevision",
        "root",
        "-BareNativeRevision",
        "native",
        "-BareWinUiRevision",
        "win-ui",
        "-BareAppKitRevision",
        "app-kit",
        "-Workflow",
        "release",
        "-ReleaseTag",
        "v1.2.3",
        "-ReleaseMode",
        "rehearsal",
        "-RemoteOrigin",
        "https://example.invalid/kepos.git",
        "-ReleaseArtifactName",
        artifactName,
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /release output already exists/i);
    assert.equal(readFileSync(artifact, "utf8"), "pre-existing artifact\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows control script passes bash syntax validation", (t) => {
  const result = spawnSync("bash", ["-n", controlScript], { encoding: "utf8" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("bash is unavailable");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
