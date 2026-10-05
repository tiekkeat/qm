import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { stdio: "inherit" });
const packages = JSON.parse(execFileSync("npm", ["query", "*"], { encoding: "utf8" }));
const rebuild = [
  ...new Set(
    packages
      .filter(
        (pkg) =>
          pkg.location &&
          pkg.name !== "opencode-ai" &&
          ["preinstall", "install", "postinstall"].some((hook) => pkg.scripts?.[hook]),
      )
      .map((pkg) => pkg.name),
  ),
];
if (rebuild.length) execFileSync("npm", ["rebuild", ...rebuild], { stdio: "inherit" });
const require = createRequire(join(process.cwd(), "package.json"));
const platformPackage =
  process.arch === "x64" ? "opencode-linux-x64-baseline-musl" : `opencode-linux-${process.arch}-musl`;
const binary = join(dirname(require.resolve(`${platformPackage}/package.json`)), "bin", "opencode");
const target = join(dirname(require.resolve("opencode-ai/package.json")), "bin", "opencode.exe");
copyFileSync(binary, target);
chmodSync(target, 0o755);
