import process from "node:process";

import { acquireRuntimeLock } from "../../src/runtime/runtime-lock.js";

const [mode, lockPath] = process.argv.slice(2);
if (!mode || !lockPath) {
  throw new Error("runtime lock child requires a mode and lock path");
}

const conflictMessage = "runtime lock is already owned";
let lock: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;

try {
  lock = await acquireRuntimeLock({
    lockPath,
    conflictMessage,
    description: "test runtime lock",
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

if (!lock) {
  // Keep the failure path above synchronous from the caller's perspective.
} else if (mode === "once") {
  process.stdout.write(`acquired:${process.pid}\n`);
  await lock.release();
  process.stdout.write(`released:${process.pid}\n`);
} else if (mode === "hold") {
  process.stdout.write(`ready:${process.pid}\n`);
  const keepAlive = setInterval(() => undefined, 1_000);
  const stop = async (): Promise<void> => {
    clearInterval(keepAlive);
    await lock?.release();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await new Promise<void>(() => undefined);
} else {
  throw new Error(`unknown runtime lock child mode: ${mode}`);
}
