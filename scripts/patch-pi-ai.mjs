import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function patchPiAi(root = process.cwd()) {
  const target = resolve(root, "node_modules/@earendil-works/pi-ai");
  const manifest = JSON.parse(readFileSync(resolve(target, "package.json"), "utf8"));
  if (manifest.version !== "1.0.4") throw new Error(`Unsupported Pi AI patch target: ${manifest.version}`);
  const patch = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/pi-ai/provider-error.patch");
  const args = ["apply", "--unsafe-paths", `--directory=${target}`];
  const applied = spawnSync("git", [...args, "--reverse", "--check", patch], { stdio: "pipe" });
  if (applied.error) throw applied.error;
  if (applied.status === 0) return;
  execFileSync("git", [...args, "--check", patch], { stdio: "pipe" });
  execFileSync("git", [...args, patch], { stdio: "inherit" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) patchPiAi();
