import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";

const read = (path: string) => readFile(path, "utf8");

test("Nix flake exports a package, app, and Home Manager module", async () => {
  const flake = await read("flake.nix");

  assert.match(flake, /packages\s*=/);
  assert.match(flake, /apps\s*=/);
  assert.match(flake, /homeManagerModules\.default/);
  assert.match(flake, /x86_64-linux/);
  assert.match(flake, /aarch64-linux/);
});

test("Nix package carries its own Node runtime", async () => {
  const packageSource = await read("nix/package.nix");

  assert.match(packageSource, /importNpmLock\.buildNodeModules/);
  assert.match(packageSource, /removeAttrs rootPackage \["devDependencies" "workspaces"\]/);
  assert.match(packageSource, /!lib\.hasPrefix "apps\/" path/);
  assert.match(packageSource, /nodejs_24/);
  assert.doesNotMatch(packageSource, /sourceDir/);
  assert.doesNotMatch(packageSource, /\.\.\/home|cp -r home/);
});

test("Home Manager module evaluates its generated config and service", async () => {
  const { stdout } = await promisify(execFile)(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      ".#checks.x86_64-linux.home-manager-module",
    ],
    { cwd: process.cwd(), maxBuffer: 64 * 1024 },
  );
  assert.match(stdout, /\/nix\/store\/[a-z0-9]+-kepos-home-manager-module-check/);
});

test("CI builds the Nix flake", async () => {
  const workflow = await read(".github/workflows/check.yml");

  assert.match(workflow, /DeterminateSystems\/determinate-nix-action@[0-9a-f]{40}/);
  assert.match(workflow, /nix flake check/);
});
