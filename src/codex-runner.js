import { spawn } from "node:child_process";
import fs from "node:fs";

export function parseCodexJsonLines(output) {
  let threadId = null;
  let finalText = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      finalText = event.item.text;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      throw new Error(event.error?.message || event.message || "Codex turn failed");
    }
  }
  return { threadId, text: finalText };
}

export function buildCodexArgs(config, threadId = null) {
  const args = [
    ...(config.codexCommandArgs || []),
    "exec", "--json", "--color", "never", "--cd", config.codexWorkspace,
    "--sandbox", config.codexSandbox
  ];
  if (config.codexSkipGitRepoCheck) args.push("--skip-git-repo-check");
  if (threadId) args.push("resume", threadId, "-");
  else args.push("-");
  return args;
}

export class CodexRunner {
  constructor(config, spawnImpl = spawn) {
    this.config = config;
    this.spawn = spawnImpl;
    this.active = null;
  }

  cancel() {
    if (!this.active) return false;
    this.active.kill("SIGTERM");
    return true;
  }

  async run(userText, threadId = null) {
    if (!fs.existsSync(this.config.codexWorkspace)) {
      throw new Error(`CODEX_WORKSPACE does not exist: ${this.config.codexWorkspace}`);
    }
    const prompt = threadId ? userText : [
      "You are talking privately with your user through Telegram.",
      "Answer with a useful final message suitable for Telegram. Keep routine replies concise.",
      "If you need clarification, ask the question directly. Use the configured Telegram MCP tools when proactive contact is useful.",
      "The user's message follows:",
      userText
    ].join("\n\n");

    const args = buildCodexArgs(this.config, threadId);

    return new Promise((resolve, reject) => {
      const child = this.spawn(this.config.codexCommand, args, {
        cwd: this.config.codexWorkspace,
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.active = child;
      let stdout = "";
      let stderr = "";
      const timer = this.config.codexTimeoutMs > 0
        ? setTimeout(() => child.kill("SIGTERM"), this.config.codexTimeoutMs)
        : null;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
      child.on("error", error => {
        clearTimeout(timer);
        this.active = null;
        reject(new Error(`Could not start Codex (${this.config.codexCommand}): ${error.message}`));
      });
      child.on("close", code => {
        clearTimeout(timer);
        this.active = null;
        if (code !== 0) {
          reject(new Error(`Codex exited with code ${code}: ${stderr.trim() || "no diagnostics"}`));
          return;
        }
        try {
          const parsed = parseCodexJsonLines(stdout);
          if (!parsed.text) throw new Error("Codex completed without a final agent message");
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(prompt);
    });
  }
}
