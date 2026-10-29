import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("builds the public pages referenced by the sitemap", () => {
  const root = resolve(import.meta.dirname, "..");
  const sitemap = readFileSync(resolve(root, "dist/sitemap.xml"), "utf8");
  const routes = [...sitemap.matchAll(/<loc>https:\/\/kepos\.guion\.io(.*?)<\/loc>/g)].map((match) => match[1]);
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) expect(existsSync(resolve(root, "dist", `.${route}index.html`))).toBe(true);
});
