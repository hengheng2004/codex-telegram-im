import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnvFile(file = path.join(projectRoot, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function stringArrayFromEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${name} must be a JSON array of strings`); }
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return value;
}

function booleanFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

export function getConfig({ requireChat = true } = {}) {
  loadEnvFile();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const configuredUserId = process.env.TELEGRAM_USER_ID?.trim();
  const userId = configuredUserId || (chatId && !chatId.startsWith("-") ? chatId : "");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and configure it.");
  if (requireChat && !chatId) throw new Error("TELEGRAM_CHAT_ID is missing. Message the bot, then run `npm run discover`.");
  if (requireChat && !userId) throw new Error("TELEGRAM_USER_ID is missing. Set it to your numeric Telegram user ID.");

  const sandbox = process.env.CODEX_SANDBOX || "read-only";
  if (!new Set(["read-only", "workspace-write", "danger-full-access"]).has(sandbox)) {
    throw new Error("CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access");
  }
  const codexTimeoutSeconds = numberFromEnv("CODEX_TIMEOUT_SECONDS", 1800);
  if (codexTimeoutSeconds < 0) throw new Error("CODEX_TIMEOUT_SECONDS must be 0 or greater");
  const codexMaxConcurrentTurns = numberFromEnv("CODEX_MAX_CONCURRENT_TURNS", 2);
  if (!Number.isInteger(codexMaxConcurrentTurns) || codexMaxConcurrentTurns < 1 || codexMaxConcurrentTurns > 8) {
    throw new Error("CODEX_MAX_CONCURRENT_TURNS must be an integer between 1 and 8");
  }
  const codexRunnerIdleSeconds = numberFromEnv("CODEX_RUNNER_IDLE_SECONDS", 300);
  if (codexRunnerIdleSeconds < 0) throw new Error("CODEX_RUNNER_IDLE_SECONDS must be 0 or greater");
  const telegramMaxFileMb = numberFromEnv("TELEGRAM_MAX_FILE_MB", 45);
  if (telegramMaxFileMb <= 0 || telegramMaxFileMb > 50) {
    throw new Error("TELEGRAM_MAX_FILE_MB must be greater than 0 and no more than 50");
  }
  const telegramUploadTimeoutSeconds = numberFromEnv("TELEGRAM_UPLOAD_TIMEOUT_SECONDS", 60);
  if (!Number.isInteger(telegramUploadTimeoutSeconds) || telegramUploadTimeoutSeconds < 5 || telegramUploadTimeoutSeconds > 600) {
    throw new Error("TELEGRAM_UPLOAD_TIMEOUT_SECONDS must be an integer between 5 and 600");
  }
  const telegramUploadRetries = numberFromEnv("TELEGRAM_UPLOAD_RETRIES", 1);
  if (!Number.isInteger(telegramUploadRetries) || telegramUploadRetries < 0 || telegramUploadRetries > 3) {
    throw new Error("TELEGRAM_UPLOAD_RETRIES must be an integer between 0 and 3");
  }

  const stateValue = process.env.STATE_FILE || ".data/state.json";
  const logValue = process.env.RELAY_LOG_FILE || ".data/relay.log";
  return {
    projectRoot,
    telegramToken: token,
    telegramChatId: chatId,
    telegramUserId: userId,
    telegramMaxFileBytes: Math.floor(telegramMaxFileMb * 1024 * 1024),
    telegramUploadTimeoutMs: telegramUploadTimeoutSeconds * 1000,
    telegramUploadRetries,
    codexWorkspace: path.resolve(process.env.CODEX_WORKSPACE || projectRoot),
    codexSandbox: sandbox,
    codexModel: process.env.CODEX_MODEL?.trim() || "",
    codexCommand: process.env.CODEX_COMMAND || "codex",
    codexCommandArgs: stringArrayFromEnv("CODEX_COMMAND_ARGS_JSON"),
    codexSkipGitRepoCheck: booleanFromEnv("CODEX_SKIP_GIT_REPO_CHECK"),
    codexTimeoutMs: codexTimeoutSeconds * 1000,
    codexMaxConcurrentTurns,
    codexRunnerIdleMs: codexRunnerIdleSeconds * 1000,
    bridgeHost: process.env.BRIDGE_HOST || "127.0.0.1",
    bridgePort: numberFromEnv("BRIDGE_PORT", 43921),
    bridgeToken: process.env.BRIDGE_TOKEN?.trim() || "",
    stateFile: path.isAbsolute(stateValue) ? stateValue : path.resolve(projectRoot, stateValue),
    relayLogFile: path.isAbsolute(logValue) ? logValue : path.resolve(projectRoot, logValue),
    logLevel: process.env.LOG_LEVEL || "info"
  };
}

export function validateBridgeToken(config) {
  if (config.bridgeToken.length < 24 || config.bridgeToken === "replace-with-a-long-random-value") {
    throw new Error("BRIDGE_TOKEN must be a unique random value of at least 24 characters");
  }
}
