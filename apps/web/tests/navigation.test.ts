import { describe, expect, it } from "vitest";

import { findActiveSectionId } from "../src/navigation";

describe("section navigation", () => {
  it("keeps an upward scroll target active when it aligns below the header", () => {
    const sections = [
      { id: "top", top: -2_900 },
      { id: "why", top: 80 },
      { id: "how", top: 1_100 },
    ];

    expect(findActiveSectionId(sections, 80)).toBe("why");
  });

  it("uses the last section that has crossed the activation line", () => {
    const sections = [
      { id: "why", top: -1_000 },
      { id: "how", top: 80 },
      { id: "source", top: 900 },
    ];

    expect(findActiveSectionId(sections, 80)).toBe("how");
  });
});
