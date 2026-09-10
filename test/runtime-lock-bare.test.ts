import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const bareEntry = fileURLToPath(
  new URL("./fixtures/runtime-lock-bare-entry.mjs", import.meta.url),
);

test("Bare linking exposes the fs-native-extensions production addon", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the available native-link smoke runs on Linux");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-bare-link-"));
  try {
    await execute(
      path.join(repository, "node_modules", ".bin", "bare-link"),
      [
        "--host",
        "linux-x64",
        "--out",
        root,
        path.join(repository, "node_modules", "fs-native-extensions"),
      ],
      { cwd: repository },
    );
    const entries = await readdir(path.join(root, "lib"));
    assert.ok(
      entries.some((entry) => entry.startsWith("libfs-native-extensions.")),
      `linked files did not include fs-native-extensions: ${entries.join(", ")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bare runtime acquires and releases a native runtime lock", async (t) => {
  const bare = bareRuntimePath();
  if (!bare) {
    t.skip("set KEPOS_BARE_RUNTIME to an available Bare executable");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-bare-lock-"));
  const moduleRoot = path.join(root, "module");
  const lockPath = path.join(root, "runtime.lock");
  try {
    await mkdir(moduleRoot);
    await symlink(
      path.join(repository, "node_modules"),
      path.join(moduleRoot, "node_modules"),
    );
    await writeFile(
      path.join(moduleRoot, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies: {
          "bare-fs": "4.7.4",
          "bare-path": "3.1.1",
          "fs-native-extensions": "1.5.1",
        },
        imports: {
          "node:fs/promises": {
            bare: "bare-fs/promises",
            default: "node:fs/promises",
          },
          "node:path": {
            bare: "bare-path",
            default: "node:path",
          },
        },
      }),
    );
    await writeFile(
      path.join(moduleRoot, "fs-native-extensions.d.ts"),
      'declare module "fs-native-extensions" { export function tryLock(fd: number): boolean; export function unlock(fd: number): void; }\n',
    );
    const source = path.join(moduleRoot, "runtime-lock.ts");
    const output = path.join(moduleRoot, "compiled");
    await copyFile(
      path.join(repository, "src/runtime/runtime-lock.ts"),
      source,
    );
    await mkdir(output);
    await execute(
      path.join(repository, "node_modules", ".bin", "tsc"),
      [
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--types",
        "node",
        "--skipLibCheck",
        "--outDir",
        output,
        source,
        path.join(moduleRoot, "fs-native-extensions.d.ts"),
      ],
      { cwd: repository },
    );
    await copyFile(
      path.join(output, "runtime-lock.js"),
      path.join(moduleRoot, "runtime-lock.js"),
    );
    await copyFile(bareEntry, path.join(moduleRoot, "index.mjs"));

    await execute(
      path.join(repository, "node_modules", ".bin", "bare-link"),
      [
        "--host",
        "linux-x64",
        "--out",
        root,
        path.join(repository, "node_modules", "fs-native-extensions"),
      ],
      { cwd: repository },
    );
    await execute(
      path.join(repository, "node_modules", ".bin", "bare-pack"),
      [
        "--base",
        moduleRoot,
        "--linked",
        "--host",
        "linux-x64",
        "--out",
        path.join(root, "runtime.bundle"),
        path.join(moduleRoot, "index.mjs"),
      ],
      { cwd: repository },
    );

    const result = await execute(
      bare,
      [path.join(moduleRoot, "index.mjs"), lockPath],
      {
        cwd: root,
        env: process.env,
      },
    );
    assert.match(result.stdout, /bare-acquired:/u);
    assert.match(result.stdout, /bare-released/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function bareRuntimePath(): string | undefined {
  const configured = process.env.KEPOS_BARE_RUNTIME;
  if (configured) return configured;
  const result = spawnSync("which", ["bare"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}
