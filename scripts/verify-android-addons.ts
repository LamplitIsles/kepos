import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Bundle from "bare-bundle";
import extractZip from "extract-zip";

export async function verifyAndroidAddonFiles(
  bundlePath: string,
  addonDirectory: string,
): Promise<void> {
  // bare-bundle runs with Node's Buffer, but declares its Bare Buffer type.
  const source = await readFile(bundlePath);
  const bundle = Bundle.from(source as unknown as Parameters<typeof Bundle.from>[0]);
  for (const addon of bundle.addons) {
    if (!/^linked:lib[^/\\:]+\.so$/u.test(addon)) {
      throw new Error(`Unsupported Android addon reference: ${addon}`);
    }
    const name = addon.slice("linked:".length);
    const metadata = await lstat(path.join(addonDirectory, name)).catch(() => undefined);
    if (!metadata?.isFile() || metadata.size === 0) {
      throw new Error(`Android linked addon is missing or invalid: ${name}`);
    }
  }
}

export async function verifyAndroidApkAddons(apkPath: string): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kepos-android-addons-"));
  try {
    await extractZip(apkPath, { dir: directory });
    await verifyAndroidAddonFiles(
      path.join(directory, "assets/kepos.bundle"),
      path.join(directory, "lib/arm64-v8a"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
