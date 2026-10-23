import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitTelegramText, TelegramClient } from "../src/telegram.js";

test("splitTelegramText preserves a long message within Telegram limits", () => {
  const input = `${"alpha ".repeat(900)}\n${"omega ".repeat(900)}`.trim();
  const chunks = splitTelegramText(input);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 4096));
  assert.equal(chunks.join(" ").replaceAll(/\s+/g, " "), input.replaceAll(/\s+/g, " "));
});

test("TelegramClient sends JSON and reports Telegram errors", async () => {
  const calls = [];
  const client = new TelegramClient("secret", async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  });
  const result = await client.sendText("42", "hello", { forceReply: true, messageThreadId: 9 });
  assert.equal(result.message_id, 7);
  assert.match(calls[0].url, /\/sendMessage$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, "42");
  assert.equal(body.reply_markup.force_reply, true);
  assert.equal(body.message_thread_id, 9);
});

test("TelegramClient uploads documents with multipart topic routing", async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new TelegramClient("secret", async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 8 } }) };
  });
  const result = await client.sendDocument("42", fileURLToPath(new URL("../README.md", import.meta.url)), {
    caption: "Report",
    silent: true,
    messageThreadId: 9,
    signal: controller.signal
  });
  assert.equal(result.message_id, 8);
  assert.match(calls[0].url, /\/sendDocument$/);
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get("chat_id"), "42");
  assert.equal(calls[0].init.body.get("caption"), "Report");
  assert.equal(calls[0].init.body.get("message_thread_id"), "9");
  assert.equal(calls[0].init.body.get("disable_notification"), "true");
  assert.equal(calls[0].init.body.get("document").name, "README.md");
  assert.equal(calls[0].init.signal, controller.signal);
});

test("TelegramClient downloads a file through getFile with a hard size limit", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-download-"));
  const target = path.join(directory, "download.tmp");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const client = new TelegramClient("secret", async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/getFile")) {
      return { ok: true, json: async () => ({ ok: true, result: { file_path: "documents/file.txt" } }) };
    }
    return {
      ok: true,
      headers: { get: () => "5" },
      arrayBuffer: async () => Buffer.from("hello")
    };
  });
  const result = await client.downloadFile("file-1", target, 10);
  assert.equal(result.size, 5);
  assert.equal(fs.readFileSync(target, "utf8"), "hello");
  assert.match(calls[1].url, /\/file\/botsecret\/documents\/file\.txt$/);
});
