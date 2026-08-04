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

  assert.equal(rootPackage.name, "kepos");
  assert.equal(webPackage.name, "@lamplitisles/kepos-web");
  assert.equal(webPackage.engines.node, ">=24 <25");
  assert.equal(webPackage.packageManager, undefined);
  assert.equal(webPackage.engines.bun, undefined);
  assert.equal(webPackage.devDependencies.wrangler, undefined);
  assert.match(rootPackage.devDependencies.wrangler, /^\^4\./);
  assert.equal(rootPackage.overrides.undici, "7.29.0");
  assert.equal(existsSync(path.join(root, "apps/web/bun.lock")), false);
  assert.equal(rootPackage.scripts["web:dev"], "npm run dev --workspace @lamplitisles/kepos-web");
  assert.equal(rootPackage.scripts["web:verify"], "npm run verify --workspace @lamplitisles/kepos-web");
  assert.equal(
    rootPackage.scripts["web:deploy:dry-run"],
    "npm run deploy:dry-run --workspace @lamplitisles/kepos-web",
  );
  assert.match(rootPackage.scripts.check, /npm run web:verify/);
});

test("website keeps its Cloudflare deployment contract", () => {
  const config = JSON.parse(read("apps/web/wrangler.jsonc"));
  const schemaPath = path.resolve(root, "apps/web", config.$schema);

  assert.equal(config.name, "kepos-web");
  assert.equal(existsSync(schemaPath), true);
  assert.equal(config.assets.directory, "./dist");
  assert.deepEqual(config.routes, [
    { pattern: "kepos.guion.io", custom_domain: true },
  ]);
  assert.equal(existsSync(path.join(root, "apps/web/wrangler.toml")), false);
});

test("website offers direct Android and macOS release downloads", () => {
  const html = read("apps/web/index.html");

  assert.match(
    html,
    /https:\/\/github\.com\/LamplitIsles\/kepos\/releases\/download\/v0\.1\.0\/kepos-android-arm64-v0\.1\.0\.apk/,
  );
  assert.match(
    html,
    /https:\/\/github\.com\/LamplitIsles\/kepos\/releases\/download\/v0\.1\.0\/kepos-macos-arm64-v0\.1\.0\.zip/,
  );
  assert.doesNotMatch(html, /#verify-a-downloaded-release/);
  assert.doesNotMatch(html, /FORTHCOMING/);
});

test("repository records the release workflow exception", () => {
  const instructions = read("AGENTS.md");

  assert.match(instructions, /formal release workflow/i);
  assert.match(instructions, /standard `git`\s+and\s+`gh`/i);
  assert.match(instructions, /never use `og`/i);
});
