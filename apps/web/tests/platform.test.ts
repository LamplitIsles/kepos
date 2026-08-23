import { describe, expect, it } from "vitest";

import { recommendPlatform } from "../src/platform";

describe("platform recommendation", () => {
  it("recognizes supported browser environments", () => {
    expect(
      recommendPlatform({
        platform: "Linux armv8l",
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
      }),
    ).toBe("android");
    expect(
      recommendPlatform({
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe("macos");
    expect(
      recommendPlatform({
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      }),
    ).toBe("windows");
  });

  it("does not turn misleading or unsupported platforms into a recommendation", () => {
    expect(
      recommendPlatform({
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
      }),
    ).toBe("unknown");
    expect(
      recommendPlatform({
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows Phone 10.0; Android 4.2)",
      }),
    ).toBe("unknown");
    expect(
      recommendPlatform({
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      }),
    ).toBe("unknown");
  });
});
