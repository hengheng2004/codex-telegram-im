#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { getConfig, validateBridgeToken } from "./config.js";
import { bridgeRequest } from "./bridge-client.js";

async function doctor(config) {
  const checks = [];
  checks.push(["Node.js >= 20", Number(process.versions.node.split(".")[0]) >= 20, process.version]);
  checks.push(["Codex workspace", fs.existsSync(config.codexWorkspace), config.codexWorkspace]);
  const codex = spawnSync(config.codexCommand, [...config.codexCommandArgs, "--version"], { encoding: "utf8", windowsHide: true });
  checks.push(["Codex CLI", codex.status === 0, (codex.stdout || codex.stderr || codex.error?.message || "not found").trim()]);
  try {
    validateBridgeToken(config);
    checks.push(["Bridge token", true, "configured"]);
  } catch (error) {
    checks.push(["Bridge token", false, error.message]);
  }
  try {
    const response = await fetch(`http://${config.bridgeHost}:${config.bridgePort}/health`);
    checks.push(["Relay service", response.ok, response.ok ? "online" : `HTTP ${response.status}`]);
  } catch {
    checks.push(["Relay service", false, "offline"]);
  }
  for (const [name, ok, detail] of checks) process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}\n`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

const [command, ...rest] = process.argv.slice(2);
const config = getConfig();
if (command === "doctor") {
  await doctor(config);
} else if (command === "send") {
  validateBridgeToken(config);
  const message = rest.join(" ").trim();
  if (!message) throw new Error("Usage: codex-telegram send <message>");
  await bridgeRequest(config, "/notify", { message });
  process.stdout.write("Telegram notification sent.\n");
} else {
  process.stdout.write("Usage: codex-telegram <doctor|send MESSAGE>\n");
  process.exitCode = command ? 1 : 0;
}
