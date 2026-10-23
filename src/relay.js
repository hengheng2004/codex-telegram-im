#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, validateBridgeToken } from "./config.js";
import { TelegramClient } from "./telegram.js";
import { StateStore } from "./state.js";
import { CodexAppServer } from "./app-server.js";

const HELP = [
  "Each Telegram topic maps to one local Codex App Server chat.",
  "These chats are separate from Codex Remote tasks.",
  "",
  "/new — start a new chat in this topic (keeps its project)",
  "/projects — list local projects from recent Codex history",
  "/project <number or folder> — select a listed project or local folder",
  "/unproject — use the default folder",
  "/chats — list recent Codex chats for this project",
  "/attach <number or id> — attach this topic to an existing chat",
  "/open <number> — create a new Telegram topic for a listed chat",
  "/status — show this topic's mapping",
  "/cancel — stop the active Codex turn",
  "/help — show this help"
].join("\n");

export const NOTIFICATION_HEADER = "Codex notification — no reply expected";

const SENSITIVE_ATTACHMENT_SEGMENTS = new Set([".data", ".git", ".codex", ".agents", ".ssh", ".aws", ".gnupg"]);
const SENSITIVE_ATTACHMENT_NAMES = new Set(["auth.json", "config.toml", "credentials", "credentials.json"]);
const INBOUND_DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".md", ".txt"]);
const INBOUND_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function safeInboundName(name, fallback) {
  const cleaned = path.basename(String(name || fallback)).replace(/[^\p{L}\p{N}._ -]/gu, "_");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

export function inboundAttachment(message) {
  if (message?.document) {
    const name = safeInboundName(message.document.file_name, "attachment");
    const extension = path.extname(name).toLowerCase();
    if (!INBOUND_DOCUMENT_EXTENSIONS.has(extension) && !INBOUND_IMAGE_EXTENSIONS.has(extension)) {
      return { unsupported: true, name };
    }
    return {
      fileId: message.document.file_id,
      fileSize: Number(message.document.file_size) || 0,
      name,
      kind: INBOUND_IMAGE_EXTENSIONS.has(extension) ? "image" : "document"
    };
  }
  if (message?.photo?.length) {
    const photo = message.photo.at(-1);
    return {
      fileId: photo.file_id,
      fileSize: Number(photo.file_size) || 0,
      name: `telegram-photo-${message.message_id}.jpg`,
      kind: "image"
    };
  }
  return null;
}

export function resolveAttachmentFile(requestedPath, workspaceRoot, maxBytes) {
  const rawPath = String(requestedPath || "").trim();
  if (!rawPath) throw new Error("Attachment path is required");
  const root = fs.realpathSync(path.resolve(workspaceRoot));
  const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
  const filePath = fs.realpathSync(candidate);
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Attachment must be a file inside the current project folder");
  }
  const segments = relative.split(path.sep).map(segment => segment.toLowerCase());
  const fileName = segments.at(-1);
  if (segments.some(segment => SENSITIVE_ATTACHMENT_SEGMENTS.has(segment)) ||
      fileName === ".env" || fileName.startsWith(".env.") || SENSITIVE_ATTACHMENT_NAMES.has(fileName)) {
    throw new Error("Sensitive files and state directories cannot be sent to Telegram");
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("Attachment path must point to a regular file");
  if (stat.size > maxBytes) {
    throw new Error(`Attachment is too large (${stat.size} bytes; maximum ${maxBytes} bytes)`);
  }
  return { filePath, fileName: path.basename(filePath), size: stat.size };
}

function uploadError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isTransientUploadError(error) {
  return error?.code === "TELEGRAM_UPLOAD_TIMEOUT" ||
    error?.name === "TypeError" ||
    /fetch failed|network|socket|ECONN|ETIMEDOUT|Too Many Requests|\b429\b|\b5\d\d\b/i.test(error?.message || "");
}

export async function sendDocumentWithRetry(telegram, chatId, filePath, options = {}, retryOptions = {}) {
  const timeoutMs = retryOptions.timeoutMs ?? 60000;
  const retries = retryOptions.retries ?? 1;
  const parentSignal = retryOptions.signal;
  const log = retryOptions.log || (() => {});

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (parentSignal?.aborted) throw uploadError("Telegram attachment upload was cancelled", "TELEGRAM_UPLOAD_CANCELLED");
    const controller = new AbortController();
    let rejectGuard;
    let timedOut = false;
    let cancelled = false;
    const guard = new Promise((_, reject) => { rejectGuard = reject; });
    const stopAttempt = (error) => {
      if (controller.signal.aborted) return;
      controller.abort(error);
      rejectGuard(error);
    };
    const onCancel = () => {
      cancelled = true;
      stopAttempt(uploadError("Telegram attachment upload was cancelled", "TELEGRAM_UPLOAD_CANCELLED"));
    };
    parentSignal?.addEventListener("abort", onCancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stopAttempt(uploadError(`Telegram attachment upload timed out after ${timeoutMs / 1000} seconds`, "TELEGRAM_UPLOAD_TIMEOUT"));
    }, timeoutMs);

    try {
      return await Promise.race([
        telegram.sendDocument(chatId, filePath, { ...options, signal: controller.signal }),
        guard
      ]);
    } catch (error) {
      const failure = cancelled
        ? uploadError("Telegram attachment upload was cancelled", "TELEGRAM_UPLOAD_CANCELLED")
        : timedOut
          ? uploadError(`Telegram attachment upload timed out after ${timeoutMs / 1000} seconds`, "TELEGRAM_UPLOAD_TIMEOUT")
          : error;
      if (cancelled || attempt >= retries || !isTransientUploadError(failure)) throw failure;
      log(`Telegram attachment upload attempt ${attempt + 1} failed; retrying (${attempt + 2}/${retries + 1})`, failure);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onCancel);
    }
  }
}

export function codexFailureMessage(error) {
  const detail = error?.message || String(error);
  if (/\b429\b|Too Many Requests/i.test(detail)) {
    return "Codex 暂时拒绝了请求（429 限流），内部重试也已用尽。\n\n这不一定表示账号总额度耗尽。请稍后再试，避免连续发送；也可检查 Codex 的用量状态。如果持续发生，请检查模型、登录和代理连接。\n\n桥接器不会自动重发这条任务，以免重复执行。";
  }
  if (/already has an active writer/i.test(detail)) {
    return "这个 Codex 对话正被其他客户端占用。请先在桌面端停止或离开该对话，再从 Telegram 继续。\n\n也可以用 /new 在当前项目新建独立对话；它不会继承原对话的聊天记录。";
  }
  return `Codex could not complete that turn.\n\n${detail}`;
}

export class Relay {
  constructor(config, {
    telegram = new TelegramClient(config.telegramToken),
    store = new StateStore(config.stateFile),
    runner = null,
    runnerFactory = null
  } = {}) {
    this.config = config;
    this.telegram = telegram;
    this.store = store;
    this.runnerFactory = runnerFactory || (runner ? () => runner : () => new CodexAppServer(config));
    this.runner = runner || this.runnerFactory();
    this.topicRunners = new Map();
    this.activeTurns = new Map();
    this.activeThreadIds = new Map();
    this.inflightTurns = new Set();
    this.pendingQuestions = new Map();
    this.processing = Promise.resolve();
    this.stopping = false;
    this.pollController = null;
    this.server = null;
    this.recentChats = new Map();
    this.recentProjects = new Map();
  }

  topicKey(topicId) {
    return topicId == null ? "general" : String(topicId);
  }

  runnerForTopic(topicId) {
    const key = this.topicKey(topicId);
    let entry = this.topicRunners.get(key);
    if (!entry) {
      entry = { runner: this.runnerFactory(), idleTimer: null, topicId };
      this.topicRunners.set(key, entry);
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    return entry.runner;
  }

  releaseTopicRunner(topicId, runner) {
    if (!(this.config.codexRunnerIdleMs > 0)) return;
    const key = this.topicKey(topicId);
    const entry = this.topicRunners.get(key);
    if (!entry || entry.runner !== runner) return;
    entry.idleTimer = setTimeout(() => {
      if (this.activeTurns.has(key) || this.topicRunners.get(key)?.runner !== runner) return;
      this.topicRunners.delete(key);
      Promise.resolve(runner.stop?.()).catch(error => this.log(`Could not stop idle App Server for topic ${key}`, error));
    }, this.config.codexRunnerIdleMs);
    entry.idleTimer.unref?.();
  }

  log(message, error) {
    const suffix = error ? `: ${error.stack || error.message || error}` : "";
    const line = `[${new Date().toISOString()}] [codex-telegram] ${message}${suffix}\n`;
    process.stderr.write(line);
    if (this.config.relayLogFile) {
      fs.mkdirSync(path.dirname(this.config.relayLogFile), { recursive: true });
      fs.appendFileSync(this.config.relayLogFile, line, "utf8");
    }
  }

  async start() {
    await this.store.load();
    const me = await this.telegram.getMe();
    const webhook = await this.telegram.getWebhookInfo();
    if (webhook.url) throw new Error("This bot has a webhook configured. Remove it before using long polling.");
    this.server = await this.startBridgeServer();
    this.log(`@${me.username} ready for chat ${this.config.telegramChatId}; bridge on ${this.config.bridgeHost}:${this.config.bridgePort}`);
    await this.poll();
  }

  async stop() {
    this.stopping = true;
    this.pollController?.abort();
    for (const { runner } of this.activeTurns.values()) runner.cancel?.();
    const runners = new Set([this.runner, ...[...this.topicRunners.values()].map(entry => entry.runner)]);
    for (const entry of this.topicRunners.values()) clearTimeout(entry.idleTimer);
    await Promise.allSettled([...runners].map(activeRunner => activeRunner.stop?.()));
    for (const pending of this.pendingQuestions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge stopped"));
    }
    this.pendingQuestions.clear();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }

  startBridgeServer() {
    const server = http.createServer((request, response) => this.handleBridgeRequest(request, response));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.bridgePort, this.config.bridgeHost, () => resolve(server));
    });
  }

  async readJson(request) {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 64 * 1024) throw new Error("Request is too large");
    }
    return JSON.parse(raw || "{}");
  }

  json(response, status, value) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }

  async handleBridgeRequest(request, response) {
    const disconnectController = new AbortController();
    const onDisconnect = () => {
      if (!response.writableEnded) disconnectController.abort(uploadError("Bridge client disconnected", "TELEGRAM_UPLOAD_CANCELLED"));
    };
    response.once("close", onDisconnect);
    try {
      if (request.method === "GET" && request.url === "/health") {
        this.json(response, 200, { ok: true, pendingQuestions: this.pendingQuestions.size });
        return;
      }
      if (request.headers.authorization !== `Bearer ${this.config.bridgeToken}`) {
        this.json(response, 401, { error: "Unauthorized" });
        return;
      }
      if (request.method !== "POST" || !new Set(["/notify", "/ask", "/file"]).has(request.url)) {
        this.json(response, 404, { error: "Not found" });
        return;
      }
      const body = await this.readJson(request);
      const topicId = await this.resolveDestinationTopic({
        topicId: body.topicId,
        projectPath: body.projectPath,
        threadId: body.threadId
      });
      if (request.url === "/file") {
        const session = this.store.getSession(this.config.telegramChatId, topicId);
        const workspaceRoot = session?.cwd || body.projectPath || this.config.codexWorkspace;
        const attachment = resolveAttachmentFile(body.path, workspaceRoot, this.config.telegramMaxFileBytes);
        const caption = String(body.caption || "").trim();
        if (caption.length > 1024) throw new Error("Attachment caption must be no more than 1024 characters");
        const startedAt = Date.now();
        this.log(`Telegram attachment upload started: ${attachment.fileName} (${attachment.size} bytes)`);
        await sendDocumentWithRetry(this.telegram, this.config.telegramChatId, attachment.filePath, {
          caption,
          silent: Boolean(body.silent),
          messageThreadId: topicId
        }, {
          timeoutMs: this.config.telegramUploadTimeoutMs,
          retries: this.config.telegramUploadRetries,
          signal: disconnectController.signal,
          log: (message, error) => this.log(message, error)
        });
        this.log(`Telegram attachment upload completed: ${attachment.fileName} in ${Date.now() - startedAt} ms`);
        this.json(response, 200, { ok: true, topicId, fileName: attachment.fileName, size: attachment.size });
        return;
      }
      const message = String(body.message || body.question || "").trim();
      if (!message || message.length > 20000) throw new Error("A message between 1 and 20000 characters is required");
      if (request.url === "/notify") {
        const notification = [
          NOTIFICATION_HEADER,
          "",
          message,
          "",
          "Direct replies are not forwarded. When Codex needs an answer in the same task, it will send “Codex needs your input” instead."
        ].join("\n");
        await this.telegram.sendText(this.config.telegramChatId, notification, { silent: Boolean(body.silent), messageThreadId: topicId });
        this.json(response, 200, { ok: true, topicId });
        return;
      }
      const timeoutSeconds = Math.max(10, Math.min(Number(body.timeoutSeconds) || 600, 3600));
      const answer = await this.askTelegram(message, timeoutSeconds, topicId);
      this.json(response, 200, { ok: true, answer, topicId });
    } catch (error) {
      this.log("Bridge request failed", error);
      if (!response.headersSent && !response.destroyed) this.json(response, 400, { error: error.message });
      else if (!response.destroyed) response.end();
    } finally {
      response.removeListener("close", onDisconnect);
    }
  }

  async resolveDestinationTopic({ topicId, projectPath, threadId } = {}) {
    if (topicId != null) return topicId;
    if (this.activeTurns.size === 1) return this.activeTurns.values().next().value.topicId;
    if (threadId) {
      const mapped = this.store.findTopicByThread?.(this.config.telegramChatId, String(threadId));
      if (mapped) return mapped.topicId;
    }
    const rawProject = String(projectPath || "").trim();
    if (!rawProject) return null;
    const cwd = path.resolve(rawProject);
    const existing = threadId ? null : this.store.findProjectContactTopic?.(this.config.telegramChatId, cwd);
    if (existing) return existing.topicId;
    const title = `${path.basename(cwd) || "Codex"} · project`.slice(0, 120);
    const created = await this.telegram.createForumTopic(this.config.telegramChatId, title);
    await this.store.setSession(this.config.telegramChatId, created.message_thread_id, {
      cwd,
      threadId: threadId ? String(threadId) : null,
      title,
      purpose: "project-contact"
    });
    return created.message_thread_id;
  }

  async askTelegram(question, timeoutSeconds, topicId = null) {
    const id = crypto.randomUUID();
    const sent = await this.telegram.sendText(this.config.telegramChatId, `Codex needs your input:\n\n${question}`, { forceReply: true, messageThreadId: topicId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(sent.message_id);
        reject(new Error(`No Telegram reply received within ${timeoutSeconds} seconds`));
      }, timeoutSeconds * 1000);
      this.pendingQuestions.set(sent.message_id, { id, resolve, reject, timer, topicId });
    });
  }

  async poll() {
    while (!this.stopping) {
      this.pollController = new AbortController();
      try {
        const updates = await this.telegram.getUpdates(this.store.data.updateOffset, 30, this.pollController.signal);
        for (const update of updates) {
          await this.store.setUpdateOffset(update.update_id + 1);
          this.dispatchUpdate(update);
        }
      } catch (error) {
        if (this.stopping || error.name === "AbortError") break;
        this.log("Polling failed; retrying in 3 seconds", error);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    await this.processing;
    await Promise.allSettled([...this.inflightTurns]);
  }

  isAuthorizedMessage(message) {
    return Boolean(
      message &&
      String(message.chat?.id) === String(this.config.telegramChatId) &&
      String(message.from?.id) === String(this.config.telegramUserId)
    );
  }

  pendingQuestionFor(message) {
    const replyId = message?.reply_to_message?.message_id;
    if (this.pendingQuestions.has(replyId)) return [replyId, this.pendingQuestions.get(replyId)];
    const topicId = message?.message_thread_id ?? null;
    const matches = [...this.pendingQuestions.entries()].filter(([, pending]) => (pending.topicId ?? null) === topicId);
    return matches.length === 1 ? matches[0] : null;
  }

  isNotificationReply(message) {
    return String(message?.reply_to_message?.text || "").startsWith(NOTIFICATION_HEADER);
  }

  dispatchUpdate(update) {
    const message = update.message;
    const attachment = inboundAttachment(message);
    const isAuthorized = Boolean(message?.text || message?.caption || attachment) && this.isAuthorizedMessage(message);
    const isPendingAnswer = isAuthorized && Boolean(this.pendingQuestionFor(message));
    const isCancel = isAuthorized && message.text?.trim().toLowerCase().split(/\s/, 1)[0].split("@", 1)[0] === "/cancel";
    if (isPendingAnswer || isCancel) {
      this.handleUpdate(update).catch(error => this.log("Priority update failed", error));
      return;
    }
    const isCodexTurn = isAuthorized && !(message.text || "").trim().startsWith("/") && !this.isNotificationReply(message);
    if (isCodexTurn) {
      const turn = this.handleUpdate(update).catch(error => this.log("Turn update failed", error));
      this.inflightTurns.add(turn);
      turn.finally(() => this.inflightTurns.delete(turn));
      return;
    }
    this.processing = this.processing.then(() => this.handleUpdate(update)).catch(error => this.log("Update failed", error));
  }

  async handleUpdate(update) {
    const message = update.message;
    if (!this.isAuthorizedMessage(message)) return;
    const topicId = message.message_thread_id ?? null;
    if (message.forum_topic_created && !message.text) {
      await this.telegram.sendText(this.config.telegramChatId, "This topic is ready for a new Codex chat. Use /project <folder> first if it belongs to a local project, or just send a message.", { messageThreadId: topicId });
      return;
    }
    const attachment = inboundAttachment(message);
    if (!message.text && !message.caption && !attachment) return;
    const text = String(message.text || message.caption || "").trim();
    const pendingEntry = this.pendingQuestionFor(message);
    if (pendingEntry) {
      const [pendingMessageId, pending] = pendingEntry;
      clearTimeout(pending.timer);
      this.pendingQuestions.delete(pendingMessageId);
      pending.resolve(text);
      await this.telegram.sendText(this.config.telegramChatId, "Thanks — I passed that back to Codex.", { replyToMessageId: message.message_id, silent: true, messageThreadId: topicId });
      return;
    }
    if (this.isNotificationReply(message)) {
      await this.telegram.sendText(this.config.telegramChatId, [
        "That was a one-way notification, so I did not start a new Codex chat.",
        "",
        "Your reply was not forwarded. A reply-capable message will begin “Codex needs your input”."
      ].join("\n"), { replyToMessageId: message.message_id, silent: true, messageThreadId: topicId });
      return;
    }

    if (attachment?.unsupported) {
      await this.telegram.sendText(this.config.telegramChatId, `不支持这种附件：${attachment.name}\n\n目前支持图片、PDF、Word、Excel、Markdown 和 TXT。`, { replyToMessageId: message.message_id, messageThreadId: topicId });
      return;
    }
    let downloadedAttachment = null;
    if (attachment) {
      if (attachment.fileSize > this.config.telegramMaxFileBytes) {
        await this.telegram.sendText(this.config.telegramChatId, "附件超过当前 45 MB 限制。", { replyToMessageId: message.message_id, messageThreadId: topicId });
        return;
      }
      const session = this.store.getSession(this.config.telegramChatId, topicId);
      const cwd = session?.cwd || this.config.codexWorkspace;
      const inbox = path.join(cwd, ".telegram-inbox");
      fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
      const fileName = `${message.message_id}-${attachment.name}`;
      const filePath = path.join(inbox, fileName);
      try {
        await this.telegram.downloadFile(attachment.fileId, filePath, this.config.telegramMaxFileBytes);
      } catch (error) {
        fs.rmSync(filePath, { force: true });
        this.log("Telegram attachment download failed", error);
        await this.telegram.sendText(this.config.telegramChatId, `附件下载失败：${error.message}`, { replyToMessageId: message.message_id, messageThreadId: topicId });
        return;
      }
      downloadedAttachment = { ...attachment, name: fileName, path: filePath };
    }

    const command = text.split(/\s/, 1)[0].toLowerCase().split("@", 1)[0];
    if (command === "/start" || command === "/help") {
      await this.telegram.sendText(this.config.telegramChatId, HELP, { messageThreadId: topicId });
      return;
    }
    if (command === "/new") {
      await this.store.clearThread(this.config.telegramChatId, topicId);
      await this.telegram.sendText(this.config.telegramChatId, "New Codex chat ready in this topic.", { messageThreadId: topicId });
      return;
    }
    if (command === "/projects") {
      const cacheKey = `${this.config.telegramChatId}:${topicId ?? 0}`;
      this.recentProjects.delete(cacheKey);
      try {
        const projects = await this.runner.listProjects();
        await this.telegram.sendText(this.config.telegramChatId, [
          "Local projects (most recently used first):", "",
          ...(projects.length ? projects.map((cwd, index) => `${index + 1}. ${cwd}`) : ["No saved local projects found."]),
          "", "Use /project <number> in this topic to select a project."
        ].join("\n"), { messageThreadId: topicId });
        this.recentProjects.set(cacheKey, projects);
      } catch (error) {
        this.log("Project listing failed", error);
        await this.telegram.sendText(this.config.telegramChatId, "Could not list local projects. Try /projects again.", { messageThreadId: topicId });
      }
      return;
    }
    if (command === "/project") {
      const requested = text.slice(text.search(/\s/) < 0 ? text.length : text.search(/\s/)).trim();
      if (!requested || requested === text) {
        const session = this.store.getSession(this.config.telegramChatId, topicId);
        await this.telegram.sendText(this.config.telegramChatId, `Project: ${session?.cwd || this.config.codexWorkspace}`, { messageThreadId: topicId });
        return;
      }
      const numeric = /^\d+$/.test(requested);
      const selected = numeric
        ? this.recentProjects.get(`${this.config.telegramChatId}:${topicId ?? 0}`)?.[Number(requested) - 1]
        : requested;
      if (!selected) {
        await this.telegram.sendText(this.config.telegramChatId, "Run /projects in this topic first, then use a listed number.", { messageThreadId: topicId });
        return;
      }
      const cwd = path.resolve(selected.replace(/^['\"]|['\"]$/g, ""));
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        await this.telegram.sendText(this.config.telegramChatId, `That folder does not exist:\n${cwd}`, { messageThreadId: topicId });
        return;
      }
      await this.store.setSession(this.config.telegramChatId, topicId, { cwd, threadId: null });
      await this.telegram.sendText(this.config.telegramChatId, `Project set to:\n${cwd}\n\nThe next message starts a new Codex chat here.`, { messageThreadId: topicId });
      return;
    }
    if (command === "/unproject") {
      await this.store.setSession(this.config.telegramChatId, topicId, { cwd: this.config.codexWorkspace, threadId: null });
      await this.telegram.sendText(this.config.telegramChatId, `Using the default folder:\n${this.config.codexWorkspace}`, { messageThreadId: topicId });
      return;
    }
    if (command === "/chats") {
      const session = this.store.getSession(this.config.telegramChatId, topicId);
      const cwd = session?.cwd || this.config.codexWorkspace;
      const chats = await this.runner.listThreads({ cwd, limit: 10 });
      this.recentChats.set(`${this.config.telegramChatId}:${topicId ?? 0}`, chats);
      const lines = chats.length ? chats.map((chat, index) => `${index + 1}. ${chat.name || chat.preview || "Untitled chat"}\n   ${chat.id}`) : ["No saved Codex chats found for this project."];
      await this.telegram.sendText(this.config.telegramChatId, [`Recent chats in ${cwd}:`, "", ...lines, "", "Use /attach <number> here, or /open <number> to give it a new Telegram topic."].join("\n"), { messageThreadId: topicId });
      return;
    }
    if (command === "/attach" || command === "/open") {
      const separator = text.indexOf(" ");
      const value = separator < 0 ? "" : text.slice(separator + 1).trim();
      const cacheKey = `${this.config.telegramChatId}:${topicId ?? 0}`;
      const chats = this.recentChats.get(cacheKey) || [];
      const selected = /^\d+$/.test(value) ? chats[Number(value) - 1] : { id: value };
      if (!selected?.id) {
        await this.telegram.sendText(this.config.telegramChatId, "Run /chats first, then use a listed number (or provide a full thread ID).", { messageThreadId: topicId });
        return;
      }
      const cwd = selected.cwd || this.store.getSession(this.config.telegramChatId, topicId)?.cwd || this.config.codexWorkspace;
      if (command === "/open") {
        const created = await this.telegram.createForumTopic(this.config.telegramChatId, selected.name || selected.preview || "Codex chat");
        await this.store.setSession(this.config.telegramChatId, created.message_thread_id, { threadId: selected.id, cwd, title: selected.name || selected.preview });
        await this.telegram.sendText(this.config.telegramChatId, `Attached to Codex chat:\n${selected.name || selected.preview || selected.id}\n\nContinue it here.`, { messageThreadId: created.message_thread_id });
      } else {
        await this.store.setSession(this.config.telegramChatId, topicId, { threadId: selected.id, cwd, title: selected.name || selected.preview });
        await this.telegram.sendText(this.config.telegramChatId, `This topic now continues:\n${selected.name || selected.preview || selected.id}`, { messageThreadId: topicId });
      }
      return;
    }
    if (command === "/status") {
      const session = this.store.getSession(this.config.telegramChatId, topicId);
      const topicRunning = this.activeTurns.has(this.topicKey(topicId));
      await this.telegram.sendText(this.config.telegramChatId, [
        "Bridge: online",
        "Conversation: local App Server thread (not Codex Remote)",
        `This topic: ${topicRunning ? "running" : "idle"}`,
        `Active turns: ${this.activeTurns.size}/${this.config.codexMaxConcurrentTurns}`,
        `Session: ${session?.threadId || "new"}`,
        `Project: ${session?.cwd || this.config.codexWorkspace}`,
        `Telegram topic: ${topicId ?? "General"}`,
        `Sandbox: ${this.config.codexSandbox}`
      ].join("\n"), { messageThreadId: topicId });
      return;
    }
    if (command === "/cancel") {
      const active = this.activeTurns.get(this.topicKey(topicId));
      await this.telegram.sendText(this.config.telegramChatId, active?.runner.cancel?.() ? "Stopping this topic's active Codex turn." : "No Codex turn is running in this topic.", { messageThreadId: topicId });
      return;
    }
    if (text.startsWith("/")) {
      await this.telegram.sendText(this.config.telegramChatId, "Unknown command. Use /help.", { messageThreadId: topicId });
      return;
    }

    const requestText = text || "请查看并处理这个附件。";
    await this.runCodexTurn(requestText, message.message_id, topicId, downloadedAttachment ? [downloadedAttachment] : []);
  }

  async runCodexTurn(text, messageId, topicId = null, attachments = []) {
    const key = this.topicKey(topicId);
    if (this.activeTurns.has(key)) {
      await this.telegram.sendText(this.config.telegramChatId, "This topic already has a running Codex turn. Wait for it to finish or use /cancel.", { replyToMessageId: messageId, messageThreadId: topicId });
      return;
    }
    if (this.activeTurns.size >= this.config.codexMaxConcurrentTurns) {
      await this.telegram.sendText(this.config.telegramChatId, `The bridge is already running ${this.activeTurns.size} Codex turns. Try again after one finishes.`, { replyToMessageId: messageId, messageThreadId: topicId });
      return;
    }
    const runner = this.runnerForTopic(topicId);
    this.activeTurns.set(key, { runner, topicId });
    const session = this.store.getSession(this.config.telegramChatId, topicId);
    const lockedThreadId = session?.threadId ? String(session.threadId) : null;
    const threadOwner = lockedThreadId ? this.activeThreadIds.get(lockedThreadId) : null;
    if (threadOwner && threadOwner !== key) {
      this.activeTurns.delete(key);
      this.releaseTopicRunner(topicId, runner);
      await this.telegram.sendText(this.config.telegramChatId, "This Codex chat is already running in another Telegram topic. Wait for it to finish or use /new here.", { replyToMessageId: messageId, messageThreadId: topicId });
      return;
    }
    if (lockedThreadId) this.activeThreadIds.set(lockedThreadId, key);
    const typing = setInterval(() => {
      this.telegram.sendChatAction(this.config.telegramChatId, "typing", { messageThreadId: topicId }).catch(() => {});
    }, 4500);
    try {
      await this.telegram.sendChatAction(this.config.telegramChatId, "typing", { messageThreadId: topicId });
      const cwd = session?.cwd || this.config.codexWorkspace;
      if (!session?.threadId) {
        await this.telegram.sendText(this.config.telegramChatId, [
          "Starting a separate Telegram-local Codex chat for this project.",
          "It can be resumed through the local App Server thread store, but it will not appear as an existing Codex Remote task."
        ].join("\n"), { silent: true, messageThreadId: topicId });
      }
      const prompt = session?.threadId ? text : [
        "You are talking privately with your user through Telegram.",
        "This is a Telegram-owned local Codex App Server thread, not an existing Codex Remote task. Never claim that replies will appear in Codex Remote.",
        `When calling Telegram MCP tools from this turn, pass topic_id=${topicId ?? "null"} explicitly so replies route to this Telegram topic.`,
        `When the user asks for a generated file or attachment, call telegram_send_file with the file path, project_path=${cwd}, and the verified topic_id after creating the file.`,
        "Answer with a useful final message suitable for Telegram. Keep routine replies concise.",
        "The user's message follows:",
        text
      ].join("\n\n");
      const result = await runner.run(prompt, session?.threadId, cwd, attachments);
      if (result.threadId) await this.store.setSession(this.config.telegramChatId, topicId, { threadId: result.threadId, cwd });
      await this.telegram.sendText(this.config.telegramChatId, result.text, { replyToMessageId: messageId, messageThreadId: topicId });
    } catch (error) {
      this.log("Codex turn failed", error);
      await this.telegram.sendText(this.config.telegramChatId, codexFailureMessage(error), { replyToMessageId: messageId, messageThreadId: topicId });
    } finally {
      this.activeTurns.delete(key);
      if (lockedThreadId && this.activeThreadIds.get(lockedThreadId) === key) this.activeThreadIds.delete(lockedThreadId);
      this.releaseTopicRunner(topicId, runner);
      clearInterval(typing);
    }
  }
}

async function main() {
  const config = getConfig();
  validateBridgeToken(config);
  const relay = new Relay(config);
  const shutdown = async () => {
    await relay.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await relay.start();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`[codex-telegram] Fatal: ${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
