import assert from "node:assert/strict";
import {
  access,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(entryPath)
        : Promise.resolve(entry.name.endsWith(".ts") ? [entryPath] : []);
    }),
  );
  return files.flat();
}

test("production runtime has no P0, dogfood, or Hypertele path", async () => {
  for (const legacyPath of ["src/p0", "src/dogfood"]) {
    await assert.rejects(
      () => access(legacyPath),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT",
      legacyPath,
    );
  }

  const packageJson = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.dependencies?.hypertele, undefined);
  assert.equal(
    Object.keys(packageJson.scripts ?? {}).some(
      (name) => name.startsWith("p0:") || name.startsWith("dogfood:"),
    ),
    false,
  );
  assert.doesNotMatch(
    await readFile("package-lock.json", "utf8"),
    /"hypertele"/iu,
  );

  for (const filePath of await sourceFiles("src")) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /hypertele|src\/p0|src\/dogfood/iu, filePath);
  }
});

test("host owns process supervision and subscriber ports stay explicit", async () => {
  await assert.rejects(
    () => access("deploy/kepos-dogfood-publisher.service"),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );

  const decision = await readFile(
    "docs/adr/0001-host-owned-supervision-and-explicit-local-ports.md",
    "utf8",
  );
  assert.match(decision, /Status:\s*Accepted/i);
  assert.match(decision, /host.*owns.*process supervision/is);
  assert.match(decision, /SSH.*explicit.*local port/is);
  assert.match(decision, /2222.*convention.*not.*guarantee/is);
  assert.match(decision, /subscriber.*actual.*port.*copy command/is);
});

test("network research tools live outside the Kepos product repository", async () => {
  for (const extractedPath of [
    "src/tools",
    "test/bootstrap-benchmark.test.ts",
    "test/dht-crawler.test.ts",
    "test/dht-report.test.ts",
    "test/dht-validator.test.ts",
  ]) {
    await assert.rejects(
      () => access(extractedPath),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT",
      extractedPath,
    );
  }

  const packageJson = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as { scripts?: Record<string, string> };
  for (const script of [
    "crawl:dht",
    "report:dht",
    "validate:dht",
    "benchmark:bootstrap",
  ]) {
    assert.equal(packageJson.scripts?.[script], undefined, script);
  }
});

test("shared HyperDHT docs distinguish the listener from ephemeral UDP sockets", async () => {
  const documents = await Promise.all(
    [
      "docs/adr/0006-desktop-dual-role-runtime-ownership.md",
      "docs/adr/0008-share-one-hyperdht-node-per-device-runtime.md",
      "docs/cli.md",
      "docs/platforms/macos.md",
    ].map((filePath) => readFile(filePath, "utf8")),
  );
  const [desktopDecision, sharedNodeDecision, cli, macos] = documents;
  const combined = documents.join("\n");

  assert.match(sharedNodeDecision, /one preferred DHT candidate listener/iu);
  assert.match(sharedNodeDecision, /ephemeral DHT client socket/iu);
  assert.match(sharedNodeDecision, /ephemeral UDX connection sockets/iu);
  assert.match(cli, /49737-49741.*candidate listener range/isu);
  assert.match(cli, /does not cover.*UDX connection sockets/isu);
  assert.match(
    sharedNodeDecision,
    /failed holepunch.*does\s+not\s+expose.*local port/isu,
  );
  assert.match(
    sharedNodeDecision,
    /relay.*counters.*do\s+not\s+distinguish.*unavailable.*rejected/isu,
  );
  assert.doesNotMatch(
    sharedNodeDecision,
    /Kepos observations identify the candidate listener/iu,
  );
  assert.doesNotMatch(
    combined,
    /normally (?:has|uses) one (?:HyperDHT )?UDP endpoint/iu,
  );
  assert.doesNotMatch(desktopDecision, /normally one UDP endpoint/iu);
  assert.doesNotMatch(macos, /normally one UDP endpoint/iu);
});
