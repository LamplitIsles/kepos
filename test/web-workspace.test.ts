import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("website is an npm workspace on Node 24", () => {
  const rootPackage = JSON.parse(read("package.json"));
  const webPackage = JSON.parse(read("apps/web/package.json"));

  assert.equal(webPackage.name, "@tta-lab/kepos-web");
  assert.equal(webPackage.engines.node, ">=24 <25");
  assert.equal(webPackage.packageManager, undefined);
  assert.equal(webPackage.engines.bun, undefined);
  assert.equal(existsSync(path.join(root, "apps/web/bun.lock")), false);
  assert.equal(rootPackage.scripts["web:dev"], "npm run dev --workspace @tta-lab/kepos-web");
  assert.equal(rootPackage.scripts["web:verify"], "npm run verify --workspace @tta-lab/kepos-web");
  assert.equal(
    rootPackage.scripts["web:deploy:dry-run"],
    "npm run deploy:dry-run --workspace @tta-lab/kepos-web",
  );
  assert.match(rootPackage.scripts.check, /npm run web:verify/);
});

test("website keeps its Cloudflare deployment contract", () => {
  const config = JSON.parse(read("apps/web/wrangler.jsonc"));

  assert.equal(config.name, "kepos-web");
  assert.equal(config.assets.directory, "./dist");
  assert.deepEqual(config.routes, [
    { pattern: "kepos.guion.io", custom_domain: true },
  ]);
  assert.equal(existsSync(path.join(root, "apps/web/wrangler.toml")), false);
});

test("website points visitors to the current release and verification guide", () => {
  const html = read("apps/web/index.html");

  assert.match(html, /https:\/\/github\.com\/tta-lab\/kepos-neo\/releases\/latest/);
  assert.match(
    html,
    /https:\/\/github\.com\/tta-lab\/kepos-neo\/blob\/main\/docs\/releasing\.md#verify-a-downloaded-release/,
  );
  assert.doesNotMatch(html, /FORTHCOMING/);
});

test("repository records the release workflow exception", () => {
  const instructions = read("AGENTS.md");

  assert.match(instructions, /formal release workflow/i);
  assert.match(instructions, /standard `git`\s+and\s+`gh`/i);
  assert.match(instructions, /never use `og`/i);
});
