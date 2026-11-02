import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const assets = resolve(root, ".cloudflare/output/v0/workers/default/assets");

it("builds the public pages referenced by the sitemap", () => {
  const sitemap = readFileSync(resolve(assets, "sitemap.xml"), "utf8");
  const routes = [...sitemap.matchAll(/<loc>https:\/\/kepos\.guion\.io(.*?)<\/loc>/g)].map((match) => match[1]);
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) expect(existsSync(resolve(assets, `.${route}index.html`))).toBe(true);
});

it("includes the Cloudflare static asset rules and 404 page in the client build", () => {
  for (const file of ["_headers", "_redirects"]) {
    expect(readFileSync(resolve(assets, file), "utf8")).toBe(readFileSync(resolve(root, "public", file), "utf8"));
  }
  expect(existsSync(resolve(assets, "404.html"))).toBe(true);
});

it("preserves the Cloudflare deployment settings", () => {
  const settings = JSON.parse(readFileSync(resolve(root, ".cloudflare/output/v0/config.json"), "utf8"));
  expect(settings.accountId).toBe("4a7d2cc3b61181986870b57848eff910");
  const config = JSON.parse(
    readFileSync(resolve(root, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8"),
  );
  expect(config).toMatchObject({
    name: "kepos-web",
    compatibilityDate: "2026-07-22",
    compatibilityFlags: ["nodejs_compat"],
    assets: { notFoundHandling: "404-page", htmlHandling: "drop-trailing-slash" },
    domains: ["kepos.guion.io"],
    observability: { enabled: true, headSamplingRate: 1 },
    workersDev: false,
  });
});
