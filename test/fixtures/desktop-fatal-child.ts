import process from "node:process";
import { installDesktopFatalCapture } from "../../apps/desktop/src/fatal.js";

const [directory, mode] = process.argv.slice(2);
if (!directory || !mode)
  throw new Error("fatal child requires directory and mode");
const capture = installDesktopFatalCapture({
  directory,
  runId: "0123456789abcdef",
  snapshot: () => undefined,
  exit: (code) => process.exit(code),
});
if (mode === "throw")
  setTimeout(() => {
    throw new Error(
      "Bearer raw-token-value Authorization: Bearer secret-value seed=" +
        "ab".repeat(32),
    );
  }, 0);
else if (mode === "reject") Promise.reject(new Error("token=secret-value"));
else if (mode === "startup") capture("startup", new Error("startup failed"));
else if (mode === "write-failure")
  capture("startup", new Error("write failed"));
