export async function waitForSignal(
  stop: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let stopping: Promise<void> | undefined;
  let requestStop!: () => void;
  let cancel!: () => void;
  const stopped = new Promise<void>((resolve, reject) => {
    cancel = resolve;
    requestStop = () => {
      stopping ??= stop();
      stopping.then(resolve, reject);
    };
  });
  const signals =
    process.platform === "win32"
      ? (["SIGINT", "SIGTERM", "SIGBREAK"] as const)
      : (["SIGINT", "SIGTERM"] as const);
  for (const signal of signals) process.once(signal, requestStop);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    await stopped;
  } finally {
    for (const signal of signals) process.off(signal, requestStop);
    signal?.removeEventListener("abort", cancel);
  }
}
