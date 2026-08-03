import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bytesPerMebibyte = 1024 * 1024;

export function formatApkSizeComparison(
  debugBytes: number,
  releaseBytes: number,
): string {
  if (releaseBytes >= debugBytes) {
    throw new Error("release APK must be smaller than debug");
  }
  const savedBytes = debugBytes - releaseBytes;
  const savedPercent = (savedBytes / debugBytes) * 100;
  return [
    "Android APK sizes",
    `debug: ${(debugBytes / bytesPerMebibyte).toFixed(2)} MiB (${debugBytes} bytes)`,
    `release: ${(releaseBytes / bytesPerMebibyte).toFixed(2)} MiB (${releaseBytes} bytes)`,
    `saved: ${(savedBytes / bytesPerMebibyte).toFixed(2)} MiB (${savedPercent.toFixed(1)}%)`,
  ].join("\n");
}

export async function reportAndroidApkSizes(
  repository: string,
  releaseApk: string,
): Promise<string> {
  const outputs = path.join(repository, "android", "app", "build", "outputs", "apk");
  const [debug, release] = await Promise.all([
    stat(path.join(outputs, "debug", "app-debug.apk")),
    stat(releaseApk),
  ]);
  return formatApkSizeComparison(debug.size, release.size);
}

const repository = fileURLToPath(new URL("..", import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const releaseApk = process.argv[2];
  if (!releaseApk) throw new Error("signed release APK path is required");
  process.stdout.write(`${await reportAndroidApkSizes(repository, releaseApk)}\n`);
}
