import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const tests = fs.readdirSync(path.join(root, "test"))
  .filter(name => name.endsWith(".test.js"))
  .sort()
  .map(name => path.join(root, "test", name));
if (!tests.length) throw new Error("No project tests found");
const result = spawnSync(process.execPath, ["--test", ...tests], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
