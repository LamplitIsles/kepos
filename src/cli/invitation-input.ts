import process from "node:process";

/** Read a bearer invitation from a terminal without echoing it or accepting argv. */
export async function readInvitation(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error("Invitation requires an interactive terminal");
  output.write("Invitation (input hidden): ");
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 3 || byte === 4) { cleanup(); reject(new Error("Invitation input cancelled")); return; }
          if (byte === 10 || byte === 13) { cleanup(); resolve(value); return; }
          if (byte === 127 || byte === 8) value = value.slice(0, -1);
          else if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
          if (value.length > 4096) { cleanup(); reject(new Error("Invitation too long")); return; }
        }
      };
      const onError = (): void => { cleanup(); reject(new Error("Cannot read invitation")); };
      const onEnd = (): void => { cleanup(); reject(new Error("Invitation input ended")); };
      const cleanup = (): void => { input.off("data", onData); input.off("error", onError); input.off("end", onEnd); };
      input.on("data", onData);
      input.once("error", onError);
      input.once("end", onEnd);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    output.write("\n");
  }
}
