import fs from "node:fs";
import path from "node:path";

const TELEGRAM_TEXT_LIMIT = 4096;

export function splitTelegramText(text, limit = TELEGRAM_TEXT_LIMIT) {
  const value = String(text ?? "").trim() || "(Codex returned an empty response.)";
  if (value.length <= limit) return [value];
  const chunks = [];
  let remaining = value;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.6)) cut = remaining.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.6)) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class TelegramClient {
  constructor(token, fetchImpl = globalThis.fetch) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetch = fetchImpl;
  }

  async call(method, payload = {}, { signal } = {}) {
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      throw new Error(`Telegram ${method} failed: ${body.description || response.statusText || response.status}`);
    }
    return body.result;
  }

  async callMultipart(method, form, { signal } = {}) {
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      body: form,
      signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      throw new Error(`Telegram ${method} failed: ${body.description || response.statusText || response.status}`);
    }
    return body.result;
  }

  getMe() {
    return this.call("getMe");
  }

  getWebhookInfo() {
    return this.call("getWebhookInfo");
  }

  getFile(fileId) {
    return this.call("getFile", { file_id: fileId });
  }

  async downloadFile(fileId, destination, maxBytes) {
    const file = await this.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram did not return a file path");
    const response = await this.fetch(`${this.baseUrl.replace(/\/bot[^/]+$/, "")}/file${this.baseUrl.slice(this.baseUrl.lastIndexOf("/bot"))}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.statusText || response.status}`);
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Telegram attachment exceeds the configured size limit");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new Error("Telegram attachment exceeds the configured size limit");
    await fs.promises.writeFile(destination, data, { mode: 0o600 });
    return { ...file, size: data.length };
  }

  getUpdates(offset, timeout = 30, signal) {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"]
    }, { signal });
  }

  sendChatAction(chatId, action = "typing", options = {}) {
    return this.call("sendChatAction", {
      chat_id: chatId,
      action,
      ...(options.messageThreadId != null ? { message_thread_id: options.messageThreadId } : {})
    });
  }

  createForumTopic(chatId, name) {
    return this.call("createForumTopic", { chat_id: chatId, name: String(name).slice(0, 128) });
  }

  async sendText(chatId, text, options = {}) {
    let first;
    for (const chunk of splitTelegramText(text)) {
      const result = await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_notification: Boolean(options.silent),
        ...(options.messageThreadId != null ? { message_thread_id: options.messageThreadId } : {}),
        ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId } } : {}),
        ...(options.forceReply ? {
          reply_markup: {
            force_reply: true,
            selective: true,
            input_field_placeholder: "Reply to Codex…"
          }
        } : {})
      });
      first ||= result;
    }
    return first;
  }

  async sendDocument(chatId, filePath, options = {}) {
    const data = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([data], { type: "application/octet-stream" }), path.basename(filePath));
    if (options.caption) form.append("caption", String(options.caption).slice(0, 1024));
    if (options.silent) form.append("disable_notification", "true");
    if (options.messageThreadId != null) form.append("message_thread_id", String(options.messageThreadId));
    if (options.replyToMessageId) {
      form.append("reply_parameters", JSON.stringify({ message_id: options.replyToMessageId }));
    }
    return this.callMultipart("sendDocument", form, { signal: options.signal });
  }
}
