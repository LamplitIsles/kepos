export async function waitForSignal(
  stop: () => Promise<void>,
): Promise<void> {
  let stopping: Promise<void> | undefined;
  let requestStop!: () => void;
  const stopped = new Promise<void>((resolve, reject) => {
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
  try {
    await stopped;
  } finally {
    for (const signal of signals) process.off(signal, requestStop);
  }
}
