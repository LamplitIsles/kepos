import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function readProjectFile(path: string): string | null {
  const fullPath = resolve(root, path);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : null;
}

function readProjectBuffer(path: string): Buffer | null {
  const fullPath = resolve(root, path);
  return existsSync(fullPath) ? readFileSync(fullPath) : null;
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

describe("Kepos landing page", () => {
  it("registers every icon used by the page", () => {
    const html = readProjectFile("index.html");
    const main = readProjectFile("src/main.ts");

    expect(html).not.toBeNull();
    expect(main).not.toBeNull();
    if (!html || !main) return;

    const iconNames = [...html.matchAll(/data-lucide="([^"]+)"/g)].map((match) =>
      match[1]
        .split("-")
        .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
        .join(""),
    );

    for (const iconName of iconNames) {
      expect(main).toMatch(new RegExp(`\\b${iconName},`));
    }
  });

  it("keeps fragment links and labelled regions connected", () => {
    const html = readProjectFile("index.html");

    expect(html).not.toBeNull();
    if (!html) return;

    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    const fragments = [...html.matchAll(/\shref="#([^"]+)"/g)].map((match) => match[1]);
    const labelReferences = [...html.matchAll(/\saria-labelledby="([^"]+)"/g)].flatMap((match) =>
      match[1].split(/\s+/),
    );

    for (const fragment of fragments) expect(ids).toContain(fragment);
    for (const reference of labelReferences) expect(ids).toContain(reference);
  });

  it("keeps the hero focused on one product position", () => {
    const html = readProjectFile("index.html");

    expect(html).not.toBeNull();
    if (!html) return;

    expect(html).not.toContain('class="hero-manifesto"');
  });

  it("protects external links opened in new tabs", () => {
    const html = readProjectFile("index.html");

    expect(html).not.toBeNull();
    if (!html) return;

    const externalLinks = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map((match) => match[0]);

    expect(externalLinks.length).toBeGreaterThan(0);
    for (const link of externalLinks) expect(link).toMatch(/\srel="[^"]*noreferrer[^"]*"/);
    expect(html).toMatch(/<a\b[^>]*href="https:\/\/github\.com\/LamplitIsles\/kepos"/);
  });

  it("puts accessible direct downloads on every intended surface", () => {
    const html = readProjectFile("index.html");
    const css = readProjectFile("src/styles.css");

    expect(html).not.toBeNull();
    expect(css).not.toBeNull();
    if (!html || !css) return;

    const heroDownloads = html.indexOf('class="hero-downloads"');
    const heroProof = html.indexOf('class="hero-proof"');
    expect(heroDownloads).toBeGreaterThan(-1);
    expect(heroDownloads).toBeLessThan(heroProof);

    const downloads = [
      ["kepos-android-arm64.apk", /android/i],
      ["kepos-macos-arm64.zip", /mac(?:os)?/i],
      ["kepos-windows-x64.zip", /windows/i],
    ] as const;
    for (const [artifact, platform] of downloads) {
      expect(html).toContain(`https://github.com/LamplitIsles/kepos/releases/latest/download/${artifact}`);
      const anchors = [...html.matchAll(new RegExp(`<a\\b[^>]*href="[^"]*${artifact}"[^>]*>`, "g"))];
      expect(anchors.length).toBeGreaterThanOrEqual(2);
      for (const [anchor] of anchors) {
        const accessibleName = anchor.match(/\saria-label="([^"]+)"/i)?.[1];
        expect(accessibleName).toMatch(platform);
      }
    }
    expect(html).not.toMatch(/releases\/download\/v/);
    expect(html).not.toContain("ANDROID / ARM64");
    expect(html).not.toContain("APPLE SILICON");
    expect(css).not.toContain('content: "SIGNED RELEASE"');
    expect(html).not.toContain("#verify-a-downloaded-release");
  });

  it("shows the real desktop and Android product instead of endpoint mockups", () => {
    const html = readProjectFile("index.html");
    const desktopScreenshot = readProjectBuffer("public/kepos-desktop.png");
    const androidScreenshot = readProjectBuffer("public/kepos-android.png");

    expect(html).not.toBeNull();
    expect(desktopScreenshot).not.toBeNull();
    expect(androidScreenshot).not.toBeNull();
    if (!html || !desktopScreenshot || !androidScreenshot) return;

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
    const html = readProjectFile("index.html");
    const css = readProjectFile("src/styles.css");
    const desktopScreenshot = readProjectBuffer("public/kepos-desktop.png");

    expect(html).not.toBeNull();
    expect(css).not.toBeNull();
    expect(desktopScreenshot).not.toBeNull();
    if (!html || !css || !desktopScreenshot) return;

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

  it("publishes the required metadata and accessibility fallback", () => {
    const html = readProjectFile("index.html");
    const css = readProjectFile("src/styles.css");

    expect(html).not.toBeNull();
    expect(css).not.toBeNull();
    if (!html || !css) return;

    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/<meta\s+name="description"\s+content="[^"]+"/);
    expect(html).toContain('href="https://kepos.guion.io"');
    expect(html).toMatch(/<a\s+class="skip-link"\s+href="#[^"]+">/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("publishes a crawler-compatible social preview image", () => {
    const html = readProjectFile("index.html");
    const image = readProjectBuffer("public/og-image.png");

    expect(html).not.toBeNull();
    expect(image).not.toBeNull();
    if (!html || !image) return;

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
    expect(config.compatibility_flags).toContain("nodejs_compat");
    expect(config.observability.enabled).toBe(true);
    expect(config.routes).toContainEqual({
      pattern: "kepos.guion.io",
      custom_domain: true,
    });
  });
});
