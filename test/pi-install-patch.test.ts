import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const patch = join(root, "vendor/pi-ai/provider-error.patch");
const installer = join(root, "scripts/patch-pi-ai.mjs");
const paths = [...readFileSync(patch, "utf8").matchAll(/^--- a\/(.+)$/gm)].map((match) => match[1]!);

test("Pi installation patch applies to a clean package and is idempotent", (t) => {
  const work = mkdtempSync(join(tmpdir(), "qm-pi-patch-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const target = join(work, "node_modules/@earendil-works/pi-ai");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), JSON.stringify({ version: "1.0.4" }));
  for (const path of paths) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    cpSync(join(root, "node_modules/@earendil-works/pi-ai", path), join(target, path));
  }
  execFileSync("git", ["apply", "--unsafe-paths", `--directory=${target}`, "--reverse", patch]);
  execFileSync(process.execPath, [installer], { cwd: work });
  const contents = paths.map((path) => readFileSync(join(target, path), "utf8"));
  execFileSync(process.execPath, [installer], { cwd: work });
  assert.deepEqual(
    paths.map((path) => readFileSync(join(target, path), "utf8")),
    contents,
  );
  assert.match(readFileSync(join(target, "dist/api/lazy.js"), "utf8"), /reason: message.stopReason/);

  writeFileSync(join(target, "package.json"), JSON.stringify({ version: "1.0.5" }));
  const unsupported = spawnSync(process.execPath, [installer], { cwd: work, encoding: "utf8" });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /Unsupported Pi AI patch target/);

  writeFileSync(join(target, "package.json"), JSON.stringify({ version: "1.0.4" }));
  writeFileSync(join(target, paths[0]!), "incompatible package content\n");
  const incompatible = spawnSync(process.execPath, [installer], { cwd: work, encoding: "utf8" });
  assert.notEqual(incompatible.status, 0);
});
