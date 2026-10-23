import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("macOS setup and source-export safety checks", t => {
  const python = ["python3", "python"].find(command => {
    const probe = spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"], { encoding: "utf8" });
    return probe.status === 0;
  });
  if (!python) {
    t.skip("Python 3.9+ is required for the optional macOS installer tests");
    return;
  }
  const result = spawnSync(python, ["-B", "-m", "unittest", "discover", "-s", "test", "-p", "*_test.py"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 30000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ""));
});
