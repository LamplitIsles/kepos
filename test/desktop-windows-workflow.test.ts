import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powerShellOnWsl = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const buildScript = path.join(repository, "scripts", "windows", "build-kepos.ps1");
const controlScript = path.join(repository, "scripts", "windows", "nuc-kep.sh");

function windowsPath(file: string): string | undefined {
  if (process.platform === "win32") return file;
  if (!existsSync(powerShellOnWsl)) return undefined;
  const result = spawnSync("wslpath", ["-w", file], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

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
