import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = { updateOffset: 0, sessions: {} };

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY_STATE);
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      this.data = { ...structuredClone(EMPTY_STATE), ...JSON.parse(await fs.readFile(this.file, "utf8")) };
      this.data.sessions ||= {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.data;
  }

  sessionKey(chatId, topicId = null) {
    return topicId == null ? String(chatId) : `${chatId}:${topicId}`;
  }

  getSession(chatId, topicId = null) {
    return this.data.sessions[this.sessionKey(chatId, topicId)] || null;
  }

  topicSessions(chatId) {
    const prefix = `${chatId}:`;
    return Object.entries(this.data.sessions)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, session]) => ({ topicId: Number(key.slice(prefix.length)), session }))
      .filter(entry => Number.isInteger(entry.topicId))
      .sort((a, b) => String(b.session.updatedAt || "").localeCompare(String(a.session.updatedAt || "")));
  }

  findTopicByThread(chatId, threadId) {
    return this.topicSessions(chatId).find(entry => entry.session.threadId === threadId) || null;
  }

  findProjectContactTopic(chatId, cwd) {
    const wanted = pathKey(cwd);
    return this.topicSessions(chatId).find(entry =>
      entry.session.purpose === "project-contact" &&
      entry.session.cwd &&
      pathKey(entry.session.cwd) === wanted
    ) || null;
  }

  async setSession(chatId, topicId, values) {
    const key = this.sessionKey(chatId, topicId);
    const previous = this.data.sessions[key] || {};
    this.data.sessions[key] = {
      ...previous,
      ...(typeof values === "string" ? { threadId: values } : values),
      updatedAt: new Date().toISOString()
    };
    await this.save();
  }

  async clearThread(chatId, topicId = null) {
    const key = this.sessionKey(chatId, topicId);
    if (this.data.sessions[key]) {
      delete this.data.sessions[key].threadId;
      this.data.sessions[key].updatedAt = new Date().toISOString();
    }
    await this.save();
  }

  async clearSession(chatId, topicId = null) {
    delete this.data.sessions[this.sessionKey(chatId, topicId)];
    await this.save();
  }

  async setUpdateOffset(offset) {
    this.data.updateOffset = offset;
    await this.save();
  }

  async save() {
    const snapshot = JSON.stringify(this.data, null, 2) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    return this.writeChain;
  }
}
