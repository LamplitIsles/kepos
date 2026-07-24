import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("Nix flake exports a package, app, and Home Manager module", async () => {
  const flake = await read("flake.nix");

  assert.match(flake, /packages\s*=/);
  assert.match(flake, /apps\s*=/);
  assert.match(flake, /homeManagerModules\.default/);
  assert.match(flake, /x86_64-linux/);
  assert.match(flake, /aarch64-linux/);
});

test("Nix package is locked and carries its own Node runtime", async () => {
  const packageSource = await read("nix/package.nix");

  assert.match(packageSource, /importNpmLock\.buildNodeModules/);
  assert.match(packageSource, /removeAttrs rootPackage \["devDependencies" "workspaces"\]/);
  assert.match(packageSource, /!lib\.hasPrefix "apps\/" path/);
  assert.match(packageSource, /nodejs_22/);
  assert.doesNotMatch(packageSource, /sourceDir/);
});

test("Home Manager module owns policy but keeps identity in mutable state", async () => {
  const moduleSource = await read("nix/home-manager-module.nix");

  for (const option of [
    "stateDir",
    "bootstrap",
    "displayName",
    "allow",
    "services",
  ]) {
    assert.match(moduleSource, new RegExp(option));
  }
  assert.match(moduleSource, /formats\.toml/);
  assert.match(moduleSource, /systemd\.user\.services/);
  assert.match(moduleSource, /strMatching "\[0-9a-f\]\{64\}"/);
  assert.match(moduleSource, /ints\.between 1 65535/);
  assert.match(moduleSource, /serviceIdPattern/);
  assert.match(moduleSource, /id != "home"/);
  assert.match(moduleSource, /publisher\.manifest\.json/);
  assert.match(moduleSource, /Restart/);
  assert.doesNotMatch(moduleSource, /seed\s*=|privateKey\s*=/);
});

test("CI builds the locked Nix flake", async () => {
  const workflow = await read(".github/workflows/check.yml");

  assert.match(workflow, /DeterminateSystems\/determinate-nix-action@[0-9a-f]{40}/);
  assert.match(workflow, /nix flake check/);
});
