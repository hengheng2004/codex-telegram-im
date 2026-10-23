import { resolveAttachmentFile, sendDocumentWithRetry } from "./relay.js";
import { StateStore } from "./state.js";
import { TelegramClient } from "./telegram.js";

export async function sendFileDirect(config, {
  path,
  caption = "",
  silent = false,
  topicId,
  projectPath
}, {
  telegram = new TelegramClient(config.telegramToken),
  store = new StateStore(config.stateFile),
  log = () => {}
} = {}) {
  if (topicId == null) throw new Error("An explicit Telegram topic is required for direct file delivery");
  await store.load();
  const session = store.getSession(config.telegramChatId, topicId);
  const workspaceRoot = session?.cwd || projectPath;
  if (!workspaceRoot) throw new Error("A mapped topic or project_path is required for direct file delivery");
  const attachment = resolveAttachmentFile(path, workspaceRoot, config.telegramMaxFileBytes);
  const normalizedCaption = String(caption || "").trim();
  if (normalizedCaption.length > 1024) throw new Error("Attachment caption must be no more than 1024 characters");
  await sendDocumentWithRetry(telegram, config.telegramChatId, attachment.filePath, {
    caption: normalizedCaption,
    silent: Boolean(silent),
    messageThreadId: topicId
  }, {
    timeoutMs: config.telegramUploadTimeoutMs,
    retries: config.telegramUploadRetries,
    log
  });
  return { topicId, fileName: attachment.fileName, size: attachment.size };
}
