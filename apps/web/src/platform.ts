export type RecommendedPlatform = "android" | "macos" | "windows" | "unknown";

export interface BrowserPlatformInfo {
  platform?: string;
  userAgent?: string;
  userAgentDataPlatform?: string;
}

export function recommendPlatform(info: BrowserPlatformInfo): RecommendedPlatform {
  const hints = [info.userAgentDataPlatform, info.platform, info.userAgent]
    .filter((hint): hint is string => typeof hint === "string")
    .map((hint) => hint.toLowerCase());
  const userAgent = info.userAgent?.toLowerCase() ?? "";

  if (/(windows phone|iphone|ipad|ipod)/.test(userAgent)) return "unknown";
  if (hints.some((hint) => hint.includes("android"))) return "android";
  if (hints.some((hint) => hint.includes("windows") || hint === "win32" || hint === "win64")) {
    return "windows";
  }
  if (
    hints.some(
      (hint) => hint.includes("macos") || hint.includes("mac os x") || hint === "macintel" || hint === "macppc",
    )
  ) {
    return "macos";
  }
  return "unknown";
}
