const lockPath = Bare.argv.at(-1);
if (!lockPath) throw new Error("runtime lock Bare smoke requires a lock path");

try {
  const { acquireRuntimeLock } = await import("./runtime-lock.js");
  const lock = await acquireRuntimeLock({
    lockPath,
    conflictMessage: "Bare runtime lock is already owned",
  });
  console.log(`bare-acquired:${lockPath}`);
  await lock.release();
  console.log("bare-released");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Bare.exit(1);
}
