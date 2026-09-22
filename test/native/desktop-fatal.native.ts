import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test(
  "native desktop persists redacted Bare fatal events",
  {
    skip: process.platform !== "darwin" || process.arch !== "arm64",
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kepos-native-fatal-"));
    const executable = path.resolve(
      "dist/desktop/Kepos.app/Contents/MacOS/Kepos",
    );
    try {
      for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
        const home = path.join(root, kind);
        await assert.rejects(
          execute(executable, ["--smoke-test", "--smoke-home", home], {
            timeout: 30_000,
            killSignal: "SIGKILL",
            env: {
              ...process.env,
              HOME: home,
              XDG_CONFIG_HOME: path.join(home, "config"),
              XDG_STATE_HOME: path.join(home, "state"),
              KEPOS_DESKTOP_FATAL_TEST: kind,
            },
          }),
          (error: NodeJS.ErrnoException) => Number(error.code) === 1,
        );
        const fatal = await readFile(
          path.join(home, "state", "kepos-neo", "diagnostics", "fatal.json"),
          "utf8",
        );
        assert.match(fatal, new RegExp(`"kind":"${kind}"`));
        assert.doesNotMatch(fatal, /native-raw-token|[a-f]{64}/i);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
