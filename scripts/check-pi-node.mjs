#!/usr/bin/env node
// Check Pi configuration/entry points and Node syntax before saving a commit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";

const [directory, mode, ...extra] = process.argv.slice(2);
assert.ok(directory && !extra.length && (mode === undefined || mode === "--index"),
  "Usage: node scripts/check-pi-node.mjs REPO [--index]");
const root = path.resolve(directory), staged = mode === "--index";
const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const files = [...new Set(git(["ls-files", "-z", "--cached", ...(staged ? [] : ["--others", "--exclude-standard"])]).split("\0").filter(Boolean))];
const read = file => staged ? git(["show", `:${file}`]) : fs.readFileSync(path.join(root, file), "utf8");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const texts = value => Array.isArray(value) && value.every(text);
let snapshot;
try {
  for (const file of files.filter(file => /\.(?:[cm]?[jt]s)$/.test(file))) {
    let source = read(file);
    if (/\.(?:[cm]?ts)$/.test(file)) source = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: file });
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=" + (/\.(?:cjs|cts)$/.test(file) ? "commonjs" : "module")],
      { input: source, encoding: "utf8", timeout: 10000 });
    assert.equal(syntax.status, 0, `${file}: ${syntax.error?.message ?? syntax.stderr}`);
  }

  const settings = JSON.parse(read("canon/settings.canon.json"));
  assert.ok(object(settings), "Pi settings must be a JSON object");
  for (const key of ["defaultProvider", "defaultModel"]) {
    if (key in settings) assert.ok(text(settings[key]), `Pi ${key} must be nonempty text`);
  }
  if ("enabledModels" in settings) assert.ok(texts(settings.enabledModels), "Pi enabledModels must be a string array");
  if ("packages" in settings) {
    assert.ok(Array.isArray(settings.packages), "Pi packages must be an array");
    for (const pkg of settings.packages) {
      assert.ok(text(pkg) || (object(pkg) && text(pkg.source)), "Pi package requires a source");
      if (object(pkg)) for (const key of ["extensions", "skills", "prompts", "themes"]) {
        if (key in pkg) assert.ok(texts(pkg[key]), `Pi package ${key} must be a string array`);
      }
    }
  }

  // Materialize just staged extension inputs for their existing load checks.
  // This keeps partially staged commits tied to the exact submitted source.
  let loadRoot = root;
  if (staged) {
    snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-precommit-"));
    loadRoot = snapshot;
    for (const file of files.filter(file => file.startsWith("extensions/") || file === "package.json" || file.startsWith("canon/"))) {
      const target = path.join(snapshot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, read(file));
    }
  }
  for (const name of ["plain-check", "wsl-links", "pi-steward"]) {
    const extension = await import(pathToFileURL(path.join(loadRoot, "extensions", `${name}.ts`)).href);
    assert.equal(typeof extension.default, "function", `Pi extension ${name} requires a default registration function`);
    if (name === "plain-check") {
      const loaded = extension.loadConfig(path.join(loadRoot, "canon", "plain-check.toml"));
      assert.deepEqual(extension.compileRules(loaded.config).errors, [], "Pi plain-check rules must compile");
    }
  }
  console.log(`Pi/Node checks passed (${staged ? "index" : "working tree"})`);
} finally {
  if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true });
}
