import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows startup task uses the hidden WScript launcher", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-startup-task.ps1"), "utf8");
  const launcher = fs.readFileSync(path.join(root, "scripts", "run-relay-hidden.vbs"), "utf8");

  assert.match(installer, /System32\\wscript\.exe/);
  assert.match(installer, /\/\/B \/\/NoLogo/);
  assert.match(installer, /Stop-ScheduledTask/);
  assert.doesNotMatch(installer, /New-ScheduledTaskAction[^\r\n]+node/i);
  assert.match(launcher, /-NonInteractive/);
  assert.match(launcher, /-WindowStyle Hidden/);
  assert.match(launcher, /shell\.Run\(command, 0, True\)/i);
  assert.match(launcher, /WScript\.Quit exitCode/i);
});
