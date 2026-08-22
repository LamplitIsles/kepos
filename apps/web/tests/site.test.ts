import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const publicPages = ["index.html", "docs/index.html", "docs/verify/index.html"] as const;

function readProjectFile(path: string): string | null {
  const fullPath = resolve(root, path);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : null;
}

function readProjectBuffer(path: string): Buffer | null {
  const fullPath = resolve(root, path);
  return existsSync(fullPath) ? readFileSync(fullPath) : null;
}

function page(path: (typeof publicPages)[number]): string {
  const html = readProjectFile(path);
  if (html === null) throw new Error(`missing public page: ${path}`);
  return html;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.subarray(1, 4).toString("ascii") !== "PNG") return null;

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readMetaContent(html: string, key: string): string | undefined {
  return html.match(new RegExp(`<meta\\s+(?:property|name)="${key}"\\s+content="([^"]+)"`))?.[1];
}

function iconName(icon: string): string {
  return icon
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

describe("Kepos public website", () => {
  it("registers every Lucide icon used across the public pages", () => {
    const main = readProjectFile("src/main.ts");

    expect(main).not.toBeNull();
    if (!main) return;

    for (const path of publicPages) {
      const html = page(path);
      const iconNames = [...html.matchAll(/data-lucide="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((icon): icon is string => icon !== undefined)
        .map(iconName);

      for (const name of iconNames) expect(main).toMatch(new RegExp(`\\b${name},`));
    }
  });

  it("keeps local fragment and accessible-label references connected", () => {
    for (const path of publicPages) {
      const html = page(path);
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
      const fragments = [...html.matchAll(/\shref="#([^"]+)"/g)].map((match) => match[1]);
      const labelReferences = [...html.matchAll(/\saria-labelledby="([^"]+)"/g)].flatMap(
        (match) => match[1]?.split(/\s+/) ?? [],
      );

      for (const fragment of fragments) expect(ids).toContain(fragment);
      for (const reference of labelReferences) expect(ids).toContain(reference);
    }
  });

  it("protects external links opened in new tabs", () => {
    for (const path of publicPages) {
      const html = page(path);
      const externalLinks = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map((match) => match[0]);

      for (const link of externalLinks) expect(link).toMatch(/\srel="[^"]*noreferrer[^"]*"/);
    }
  });

  it("keeps all three platform artifacts visible on the landing page", () => {
    const html = page("index.html");
    const css = readProjectFile("src/styles.css");

    expect(css).not.toBeNull();
    if (!css) return;

    const downloads = [
      ["kepos-android-arm64.apk", /android/i],
      ["kepos-macos-arm64.zip", /mac(?:os)?/i],
      ["kepos-windows-x64.zip", /windows/i],
    ] as const;
    for (const [artifact, platform] of downloads) {
      expect(html).toContain(`https://github.com/LamplitIsles/kepos/releases/latest/download/${artifact}`);
      const anchors = [...html.matchAll(new RegExp(`<a\\b[^>]*href="[^"]*${artifact}"[^>]*>`, "g"))];
      expect(anchors.length).toBeGreaterThanOrEqual(1);
      for (const [anchor] of anchors) {
        const accessibleName = anchor.match(/\saria-label="([^"]+)"/i)?.[1];
        expect(accessibleName).toMatch(platform);
      }
    }

    expect(html).toMatch(/data-platform-download="android"/);
    expect(html).toMatch(/data-platform-download="macos"/);
    expect(html).toMatch(/data-platform-download="windows"/);
    expect(html).toMatch(/data-platform-role="subscriber"/);
    expect(html.match(/data-platform-role="publisher-subscriber"/g)?.length).toBe(2);
    expect(html).toMatch(/href="\/docs\/"/);
    expect(html).not.toMatch(/releases\/download\/v/);
    expect(css).not.toContain('content: "SIGNED RELEASE"');
    expect(html).not.toContain("#verify-a-downloaded-release");
  });

  it("builds and indexes the public documentation routes", () => {
    const docs = page("docs/index.html");
    const sitemap = readProjectFile("public/sitemap.xml");
    const builtDocs = readProjectFile("dist/docs/index.html");
    const builtVerify = readProjectFile("dist/docs/verify/index.html");

    expect(sitemap).not.toBeNull();
    expect(builtDocs).not.toBeNull();
    expect(builtVerify).not.toBeNull();
    if (!sitemap || !builtDocs || !builtVerify) return;

    expect(sitemap).toContain("https://kepos.guion.io/docs/");
    expect(sitemap).toContain("https://kepos.guion.io/docs/verify/");
    expect(docs).toMatch(/href="\/"[^>]*aria-label="Kepos home"/);

    const ids = new Set([...docs.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    for (const target of [
      "subscriber",
      "publisher-desktop",
      "publisher-cli",
      "trust",
      "philosophy",
      "holesail",
      "troubleshooting",
    ]) {
      expect(ids).toContain(target);
    }

    expect(docs.match(/data-platform-download="(?:android|macos|windows)"/g)?.length).toBe(3);
    expect(docs).not.toMatch(/data-section-link="verify"|href="#verify"/);
    expect(docs.match(/href="\/docs\/verify\/"/g)?.length).toBe(1);
  });

  it("keeps documentation navigation targets connected to sections", () => {
    const docs = page("docs/index.html");
    const sectionIds = new Set(
      [...docs.matchAll(/<[a-z]+\b[^>]*\sid="([^"]+)"[^>]*data-section="([^"]+)"/g)].flatMap((match) =>
        match[1] && match[2] ? [match[1], match[2]] : [],
      ),
    );
    const navigationTargets = [...docs.matchAll(/<a\b[^>]*>/g)].flatMap((match) => {
      const tag = match[0] ?? "";
      const section = tag.match(/\sdata-section-link="([^"]+)"/)?.[1];
      const target = tag.match(/\shref="#([^"]+)"/)?.[1];
      return section && target ? [{ section, target }] : [];
    });

    expect(navigationTargets.length).toBeGreaterThan(0);
    expect(navigationTargets.every(({ section, target }) => section === target && sectionIds.has(target))).toBe(true);
    expect(docs).toMatch(/aria-current="location"/);
  });

  it("publishes indexable docs metadata and a home link", () => {
    const html = page("docs/index.html");

    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/<meta\s+name="description"\s+content="[^"]+"/);
    expect(html).toContain('href="https://kepos.guion.io/docs/"');
    expect(html).toContain('property="og:url" content="https://kepos.guion.io/docs/"');
    expect(html).toMatch(/href="\/"[^>]*aria-label="Kepos home"/);
  });

  it("shows the real desktop and Android product instead of endpoint mockups", () => {
    const html = page("index.html");
    const desktopScreenshot = readProjectBuffer("public/kepos-desktop.png");
    const androidScreenshot = readProjectBuffer("public/kepos-android.png");

    expect(desktopScreenshot).not.toBeNull();
    expect(androidScreenshot).not.toBeNull();
    if (!desktopScreenshot || !androidScreenshot) return;

    expect(html).toContain('class="product-showcase product-showcase-overlap"');
    expect(html).toContain('class="access-chapter page-chapter access-product-layout"');
    expect(html).toContain('class="product-screen product-device-shell"');
    expect(html).toContain('src="/kepos-desktop.png"');
    expect(html).toContain('src="/kepos-android.png"');
    const productShowcase = html.match(/<div class="product-showcase[\s\S]*?<\/section>/)?.[0];
    expect(productShowcase).not.toMatch(/<figcaption\b/);
    expect(html).not.toContain('class="endpoint-grid"');
    expect(desktopScreenshot.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(androidScreenshot.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("keeps the desktop capture Retina-sharp at its declared display size", () => {
    const html = page("index.html");
    const css = readProjectFile("src/styles.css");
    const desktopScreenshot = readProjectBuffer("public/kepos-desktop.png");

    expect(css).not.toBeNull();
    expect(desktopScreenshot).not.toBeNull();
    if (!css || !desktopScreenshot) return;

    const dimensions = readPngDimensions(desktopScreenshot);
    expect(dimensions).not.toBeNull();
    if (!dimensions) return;

    expect(dimensions.width).toBeGreaterThanOrEqual(1440);
    expect(dimensions.height).toBeGreaterThanOrEqual(1800);
    const desktopFrameMaxWidth = Number(css.match(/\.product-frame-desktop\s*\{[^}]*max-width:\s*(\d+)px/s)?.[1]);
    expect(desktopFrameMaxWidth).toBeLessThanOrEqual(dimensions.width / 2);
    expect(html).toMatch(
      new RegExp(
        `src="/kepos-desktop\\.png"[\\s\\S]*?width="${dimensions.width}"[\\s\\S]*?height="${dimensions.height}"`,
      ),
    );
  });

  it("stacks the product composition before its columns can overflow", () => {
    const css = readProjectFile("src/styles.css");

    expect(css).not.toBeNull();
    if (!css) return;

    const breakpoint = css.match(
      /@media \(max-width: (\d+)px\) \{[\s\S]*?\.access-product-layout \{\s*display: block;/,
    )?.[1];

    expect(Number(breakpoint)).toBeGreaterThanOrEqual(1020);
  });

  it("redirects legacy pages to live homepage fragments", () => {
    const redirects = readProjectFile("public/_redirects");
    const sitemap = readProjectFile("public/sitemap.xml");

    expect(redirects).not.toBeNull();
    expect(sitemap).not.toBeNull();
    if (!redirects || !sitemap) return;

    expect(redirects).toContain("/blog/why-kepos /#why 301");
    expect(redirects).toContain("/blog/how-kepos-works /#how 301");
    expect(sitemap).not.toContain("/blog/");
    expect(readProjectFile("blog/why-kepos.html")).toBeNull();
    expect(readProjectFile("blog/how-kepos-works.html")).toBeNull();
  });

  it("publishes metadata, reduced motion, and a social preview", () => {
    const html = page("index.html");
    const css = readProjectFile("src/styles.css");
    const image = readProjectBuffer("public/og-image.png");

    expect(css).not.toBeNull();
    expect(image).not.toBeNull();
    if (!css || !image) return;

    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/<meta\s+name="description"\s+content="[^"]+"/);
    expect(html).toContain('href="https://kepos.guion.io"');
    expect(html).toMatch(/<a\s+class="skip-link"\s+href="#[^"]+">/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");

    const imageUrl = "https://kepos.guion.io/og-image.png";
    expect(readMetaContent(html, "og:image")).toBe(imageUrl);
    expect(readMetaContent(html, "og:image:type")).toBe("image/png");
    expect(readMetaContent(html, "og:image:width")).toBe("1200");
    expect(readMetaContent(html, "og:image:height")).toBe("630");
    expect(readMetaContent(html, "twitter:image")).toBe(imageUrl);
    const imageAlt = readMetaContent(html, "og:image:alt");
    expect(imageAlt).toBeTruthy();
    expect(readMetaContent(html, "twitter:image:alt")).toBe(imageAlt);
    expect(image.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(image.readUInt32BE(16)).toBe(1200);
    expect(image.readUInt32BE(20)).toBe(630);
  });

  it("deploys static assets to the custom domain", () => {
    const configSource = readProjectFile("wrangler.jsonc");

    expect(configSource).not.toBeNull();
    if (!configSource) return;

    const config = JSON.parse(configSource);
    expect(config.assets.directory).toBe("./dist");
    expect(config.assets.html_handling).toBe("drop-trailing-slash");
    expect(config.compatibility_flags).toContain("nodejs_compat");
    expect(config.observability.enabled).toBe(true);
    expect(config.routes).toContainEqual({
      pattern: "kepos.guion.io",
      custom_domain: true,
    });
  });
});
