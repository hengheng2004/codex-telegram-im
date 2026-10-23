import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP server initializes and advertises the three personal tools", async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "mcp-server.js")],
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "42",
      CODEX_SANDBOX: "read-only",
      BRIDGE_TOKEN: "0123456789abcdef0123456789abcdef"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "codex-telegram-test", version: "1.0.0" });
  t.after(async () => client.close());
  await client.connect(transport);
  const result = await client.listTools();
  assert.deepEqual(result.tools.map(tool => tool.name).sort(), ["telegram_ask", "telegram_notify", "telegram_send_file"]);
  for (const tool of result.tools) {
    assert.ok(tool.inputSchema.properties.project_path);
    assert.ok(tool.inputSchema.properties.thread_id);
  }
  assert.match(result.tools.find(tool => tool.name === "telegram_notify").description, /strictly one-way/);
  assert.match(result.tools.find(tool => tool.name === "telegram_ask").description, /exact initiating tool call/);
  assert.ok(result.tools.find(tool => tool.name === "telegram_send_file").inputSchema.properties.path);
  assert.match(result.tools.find(tool => tool.name === "telegram_send_file").description, /outside the project/);
});
