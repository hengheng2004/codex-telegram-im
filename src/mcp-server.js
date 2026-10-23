#!/usr/bin/env node
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig, validateBridgeToken } from "./config.js";
import { bridgeRequest } from "./bridge-client.js";
import { sendFileDirect } from "./direct-file.js";
import { TelegramClient } from "./telegram.js";

const config = getConfig();
validateBridgeToken(config);

const server = new McpServer({
  name: "codex-telegram",
  version: "2.3.2"
}, {
  instructions: "telegram_notify is strictly one-way: never use it when the user may reasonably need to reply. Use telegram_ask whenever an answer should return to the initiating Codex tool call. Use telegram_send_file only for files inside the current project, and never send secrets or hidden state. For locally initiated calls, pass the current absolute project path so the relay can create or reuse that project's Telegram topic."
});

server.registerTool("telegram_notify", {
  title: "Notify user on Telegram",
  description: "Send a strictly one-way Telegram notification. Direct replies are not forwarded and will not start a Codex chat. Use telegram_ask instead whenever the user may need to answer.",
  inputSchema: {
    message: z.string().min(1).max(20000).describe("The message to send"),
    silent: z.boolean().default(false).describe("Send without a notification sound"),
    topic_id: z.number().int().positive().optional().describe("Explicit Telegram topic ID; normally omit so project routing can choose it"),
    project_path: z.string().min(1).optional().describe("Current absolute local project folder; pass this for locally initiated notifications"),
    thread_id: z.string().min(1).optional().describe("Current Codex thread ID when known; exact mapped topics take priority")
  }
}, async ({ message, silent, topic_id, project_path, thread_id }) => {
  try {
    await bridgeRequest(config, "/notify", { message, silent, topicId: topic_id, projectPath: project_path, threadId: thread_id });
  } catch (error) {
    // Notifications still work when the relay daemon is down; questions do not.
    const telegram = new TelegramClient(config.telegramToken);
    await telegram.sendText(config.telegramChatId, [
      "Codex notification — no reply expected",
      "",
      message,
      "",
      "Direct replies are not forwarded. When Codex needs an answer in the same task, it will send “Codex needs your input” instead."
    ].join("\n"), { silent, messageThreadId: topic_id });
  }
  return { content: [{ type: "text", text: "Telegram notification sent." }] };
});

server.registerTool("telegram_ask", {
  title: "Ask user on Telegram",
  description: "Ask the configured user a question and return their Telegram answer to this exact initiating tool call. Requires the relay service to be running.",
  inputSchema: {
    question: z.string().min(1).max(20000).describe("The question that blocks progress"),
    timeout_seconds: z.number().int().min(10).max(3600).default(600).describe("How long to wait for a reply"),
    topic_id: z.number().int().positive().optional().describe("Explicit Telegram topic ID; normally omit so project routing can choose it"),
    project_path: z.string().min(1).optional().describe("Current absolute local project folder; pass this for locally initiated questions"),
    thread_id: z.string().min(1).optional().describe("Current Codex thread ID when known; exact mapped topics take priority")
  }
}, async ({ question, timeout_seconds, topic_id, project_path, thread_id }) => {
  const result = await bridgeRequest(config, "/ask", {
    question,
    timeoutSeconds: timeout_seconds,
    topicId: topic_id,
    projectPath: project_path,
    threadId: thread_id
  }, { timeoutMs: (timeout_seconds + 5) * 1000 });
  return { content: [{ type: "text", text: result.answer }] };
});

server.registerTool("telegram_send_file", {
  title: "Send a project file on Telegram",
  description: "Upload one regular file from the current local project to the configured Telegram chat or topic. Paths outside the project and sensitive files such as .env, .data, Git, Codex, SSH, and cloud credentials are rejected.",
  inputSchema: {
    path: z.string().min(1).max(4096).describe("Absolute path inside the current project, or a path relative to project_path/current topic project"),
    caption: z.string().max(1024).default("").describe("Optional Telegram document caption"),
    silent: z.boolean().default(false).describe("Send without a notification sound"),
    topic_id: z.number().int().positive().optional().describe("Explicit Telegram topic ID; pass the verified current topic during Telegram-originated turns"),
    project_path: z.string().min(1).optional().describe("Current absolute local project folder; required for reliable locally initiated routing and path validation"),
    thread_id: z.string().min(1).optional().describe("Current Codex thread ID when known; exact mapped topics take priority")
  }
}, async ({ path, caption, silent, topic_id, project_path, thread_id }, extra) => {
  // A Telegram-originated App Server turn is already being awaited by the relay.
  // Sending its file back through that same relay can deadlock in some Codex hosts,
  // so explicit topic deliveries use the Bot API directly. Other calls retain the
  // relay path because it owns project/topic discovery.
  const result = topic_id != null && project_path
    ? await sendFileDirect(config, {
      path,
      caption,
      silent,
      topicId: topic_id,
      projectPath: project_path
    }, {
      log: (message, error) => process.stderr.write(`[codex-telegram] ${message}: ${error?.message || error}\n`)
    })
    : await bridgeRequest(config, "/file", {
      path,
      caption,
      silent,
      topicId: topic_id,
      projectPath: project_path,
      threadId: thread_id
    }, {
      timeoutMs: (config.telegramUploadTimeoutMs * (config.telegramUploadRetries + 1)) + 5000,
      signal: extra.signal
    });
  return { content: [{ type: "text", text: `Telegram attachment sent: ${result.fileName} (${result.size} bytes).` }] };
});

await server.connect(new StdioServerTransport());
