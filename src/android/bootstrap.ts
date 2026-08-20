import { parseBootstrapAsset } from "../bootstrap-asset.js";
import type { DhtAddress } from "../mux/hyperdht.js";

export function parseAndroidBootstrapAsset(
  source: string,
): DhtAddress[] | undefined {
  try {
    return parseBootstrapAsset(source);
  } catch {
    throw new Error("invalid Android bootstrap asset");
  }
}
