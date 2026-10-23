#!/usr/bin/env node
import { getConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";

const config = getConfig({ requireChat: false });
const telegram = new TelegramClient(config.telegramToken);
const updates = await telegram.getUpdates(undefined, 0);
const chats = new Map();
for (const update of updates) {
  const message = update.message;
  if (!message?.chat) continue;
  chats.set(String(message.chat.id), {
    id: message.chat.id,
    type: message.chat.type,
    name: [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ") || message.chat.title || message.chat.username || "unknown",
    userId: message.from?.id
  });
}
if (!chats.size) {
  process.stderr.write("No messages found. Open your bot in Telegram, send /start, then run this command again.\n");
  process.exitCode = 1;
} else {
  process.stdout.write("Recent chats:\n");
  for (const chat of chats.values()) process.stdout.write(`  ${chat.id}  ${chat.type}  ${chat.name}  user ${chat.userId || "unknown"}\n`);
  process.stdout.write("\nCopy the chosen chat ID into TELEGRAM_CHAT_ID and your user ID into TELEGRAM_USER_ID in .env.\n");
}
