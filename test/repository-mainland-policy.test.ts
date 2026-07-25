import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("..", import.meta.url));
const textExtensions = new Set([
  ".json",
  ".kt",
  ".kts",
  ".md",
  ".nix",
  ".toml",
  ".ts",
  ".xml",
  ".yml",
]);

test("public docs contain no mainland-specific infrastructure plan", async () => {
  const markdownFiles = [
    path.join(repository, "README.md"),
    ...(await collectFiles(path.join(repository, "docs"))).filter((file) =>
      file.endsWith(".md"),
    ),
  ];
  const findings: string[] = [];
  const mainlandTerms = /\bmainland\b|\bChina\b|\bChinese\b|大陆|国内/gi;

  for (const file of markdownFiles) {
    const source = await readFile(file, "utf8");
    if (mainlandTerms.test(source)) {
      findings.push(path.relative(repository, file));
    }
    mainlandTerms.lastIndex = 0;
  }

  assert.deepEqual(findings, []);
});

test("repository contains no former mainland bootstrap address", async () => {
  const formerAddress = [47, 94, 213, 63].join(".");
  const roots = [
    "README.md",
    "flake.nix",
    "src",
    "scripts",
    "android",
    "docs",
    "test",
  ];
  const findings: string[] = [];

  for (const root of roots) {
    const absolute = path.join(repository, root);
    const files = (await isDirectory(absolute)) ? await collectFiles(absolute) : [absolute];
    for (const file of files) {
      if (file.includes(`${path.sep}build${path.sep}`)) continue;
      if (!textExtensions.has(path.extname(file))) continue;
      const source = await readFile(file).catch(() => null);
      if (source?.includes(formerAddress)) {
        findings.push(path.relative(repository, file));
      }
    }
  }

  assert.deepEqual(findings, []);
});

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function isDirectory(filePath: string): Promise<boolean> {
  const parent = path.dirname(filePath);
  const name = path.basename(filePath);
  const entries = await readdir(parent, { withFileTypes: true });
  return entries.some((entry) => entry.name === name && entry.isDirectory());
}
