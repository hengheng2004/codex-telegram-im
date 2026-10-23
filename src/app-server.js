import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import path from "node:path";

const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"];

function sandboxPolicy(name) {
  if (name === "danger-full-access") return { type: "dangerFullAccess" };
  if (name === "workspace-write") return { type: "workspaceWrite", networkAccess: true };
  return { type: "readOnly", access: { type: "fullAccess" } };
}

export class CodexAppServer extends EventEmitter {
  constructor(config, spawnImpl = spawn) {
    super();
    this.config = config;
    this.spawn = spawnImpl;
    this.child = null;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.active = null;
    this.defaultModel = null;
  }

  get activeTurn() {
    return this.active;
  }

  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try { await this.starting; } finally { this.starting = null; }
  }

  async #start() {
    const args = [...(this.config.codexCommandArgs || []), "app-server", "--stdio"];
    const child = this.spawn(this.config.codexCommand, args, {
      cwd: this.config.codexWorkspace,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
    readline.createInterface({ input: child.stdout }).on("line", line => this.#handleLine(line));
    child.on("error", error => this.#failAll(new Error(`Could not start Codex app-server: ${error.message}`)));
    child.on("close", code => {
      this.child = null;
      this.#failAll(new Error(`Codex app-server exited with code ${code}: ${stderr.trim() || "no diagnostics"}`));
    });
    await this.request("initialize", {
      clientInfo: { name: "codex_telegram", title: "Codex Telegram", version: "2.2.0" },
      capabilities: { experimentalApi: true }
    }, { skipStart: true });
    this.notify("initialized", {});
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Codex app-server request failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.active?.reject) this.active.reject(error);
    this.active = null;
  }

  notify(method, params) {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async request(method, params = {}, { skipStart = false, timeoutMs = 30000 } = {}) {
    if (!skipStart) await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  async listThreads({ cwd, limit = 20 } = {}) {
    const result = await this.request("thread/list", {
      cursor: null,
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: SOURCE_KINDS,
      ...(cwd ? { cwd } : {})
    });
    return result.data || [];
  }

  async listProjects() {
    const projects = new Map();
    const seenCursors = new Set();
    let cursor = null;
    do {
      const result = await this.request("thread/list", {
        cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc",
        sourceKinds: SOURCE_KINDS
      });
      for (const thread of result.data || []) {
        if (typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd)) continue;
        const cwd = path.resolve(thread.cwd);
        const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
        // Pages arrive newest first, so the first occurrence is the most recent.
        if (!projects.has(key)) projects.set(key, cwd);
      }
      cursor = result.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new Error("Repeated Codex history cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return [...projects.values()];
  }

  async run(userText, threadId = null, cwd = this.config.codexWorkspace, attachments = []) {
    if (this.active) throw new Error("Another Codex turn is already running");
    await this.start();
    // Desktop-only model aliases may not be accepted by CLI ChatGPT auth.
    // For this isolated trial, use an explicit model or the CLI's advertised default.
    let model = this.config.codexModel;
    if (!model) {
      if (!this.defaultModel) {
        const result = await this.request("model/list", {});
        this.defaultModel = result.data?.find(entry => entry.isDefault)?.model;
      }
      model = this.defaultModel;
      if (!model) throw new Error("Codex CLI did not advertise a default model");
    }
    const common = {
      model,
      cwd,
      approvalPolicy: "never",
      sandbox: this.config.codexSandbox
    };
    const threadResult = threadId
      ? await this.request("thread/resume", { threadId, ...common }, { timeoutMs: 60000 })
      : await this.request("thread/start", { ...common, serviceName: "codex-telegram" }, { timeoutMs: 60000 });
    const id = threadResult.thread.id;
    let finalText = "";
    let streamedText = "";
    let turnId = null;

    let onNotification;
    const completed = new Promise((resolve, reject) => {
      this.active = { threadId: id, turnId: null, reject };
      onNotification = message => {
        const params = message.params || {};
        if (params.threadId && params.threadId !== id) return;
        if (message.method === "item/agentMessage/delta") streamedText += params.delta || "";
        if (message.method === "item/completed" && params.item?.type === "agentMessage") {
          finalText = params.item.text || params.item.content?.map(part => part.text || "").join("") || finalText;
        }
        if (message.method === "turn/completed" && (!turnId || params.turn?.id === turnId)) {
          this.off("notification", onNotification);
          const status = params.turn?.status;
          this.active = null;
          if (status === "failed") reject(new Error(params.turn?.error?.message || "Codex turn failed"));
          else if (status === "interrupted") reject(new Error("Codex turn was cancelled"));
          else resolve();
        }
      };
      this.on("notification", onNotification);
    });

    let turnTimer;
    try {
      const turn = await this.request("turn/start", {
        threadId: id,
        input: [
          { type: "text", text: userText },
          ...attachments.map(attachment => attachment.kind === "image"
            ? { type: "localImage", path: attachment.path }
            : { type: "mention", name: attachment.name, path: attachment.path })
        ],
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: sandboxPolicy(this.config.codexSandbox)
      }, { timeoutMs: 60000 });
      turnId = turn.turn.id;
      this.active.turnId = turnId;
      const completionWaiters = [completed];
      if (this.config.codexTimeoutMs > 0) {
        completionWaiters.push(new Promise((_, reject) => {
          turnTimer = setTimeout(() => reject(new Error("Codex turn timed out")), this.config.codexTimeoutMs);
        }));
      }
      await Promise.race(completionWaiters);
      const text = finalText || streamedText.trim();
      if (!text) throw new Error("Codex completed without a final agent message");
      return { threadId: id, text };
    } finally {
      clearTimeout(turnTimer);
      if (onNotification) this.off("notification", onNotification);
      this.active = null;
    }
  }

  cancel() {
    if (!this.active?.turnId) return false;
    this.request("turn/interrupt", {
      threadId: this.active.threadId,
      turnId: this.active.turnId
    }).catch(() => {});
    return true;
  }

  async stop() {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
  }
}
