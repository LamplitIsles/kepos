import type { Duplex } from "node:stream";

type ErrorStream = Pick<Duplex, "on" | "once" | "off">;

/**
 * Retain responsibility for a stream's errors until it terminates or another
 * owner explicitly takes over.
 */
export function retainStreamErrors(
  stream: ErrorStream,
  onError: (error: Error) => void,
): () => void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    stream.off("error", onError);
    stream.off("close", release);
  };

  stream.on("error", onError);
  stream.once("close", release);
  return release;
}
