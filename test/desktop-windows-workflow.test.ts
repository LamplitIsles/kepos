import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powerShellOnWsl = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const buildScript = path.join(repository, "scripts", "windows", "build-kepos.ps1");
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

test("Windows control script passes bash syntax validation", (t) => {
  const result = spawnSync("bash", ["-n", controlScript], { encoding: "utf8" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("bash is unavailable");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
