export async function cleanupAll(
  steps: ReadonlyArray<() => Promise<unknown> | unknown>,
): Promise<void> {
  const results = await Promise.allSettled(
    steps.map((step) => Promise.resolve().then(step)),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}
