import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOTIFICATION_HEADER, Relay, codexFailureMessage, inboundAttachment, resolveAttachmentFile, sendDocumentWithRetry } from "../src/relay.js";

function fixture() {
  const sent = [];
  let createdTopics = 0;
  const telegram = {
    sendText: async (chatId, text, options = {}) => {
      sent.push({ chatId, text, options });
      return { message_id: 100 + sent.length };
    },
    sendChatAction: async () => {},
    createForumTopic: async () => ({ message_thread_id: 80 + (++createdTopics) })
  };
  const sessions = new Map();
  const store = {
    getSession: (id, topicId = null) => sessions.get(topicId == null ? String(id) : `${id}:${topicId}`) || null,
    setSession: async (id, topicId, values) => sessions.set(topicId == null ? String(id) : `${id}:${topicId}`, values),
    clearThread: async (id, topicId = null) => sessions.set(topicId == null ? String(id) : `${id}:${topicId}`, {}),
    clearSession: async (id, topicId = null) => sessions.delete(topicId == null ? String(id) : `${id}:${topicId}`),
    findTopicByThread: (id, threadId) => {
      const prefix = `${id}:`;
      const found = [...sessions].find(([key, session]) => key.startsWith(prefix) && session.threadId === threadId);
      return found ? { topicId: Number(found[0].slice(prefix.length)), session: found[1] } : null;
    },
    findProjectContactTopic: (id, cwd) => {
      const found = [...sessions].find(([key, session]) => key.startsWith(`${id}:`) && session.purpose === "project-contact" && session.cwd === cwd);
      return found ? { topicId: Number(found[0].split(":").at(-1)), session: found[1] } : null;
    }
  };
  const runner = {
    activeTurn: null,
    cancel: () => false,
    run: async text => ({ threadId: "thread-1", text: `answer:${text}` })
  };
  const config = {
    telegramChatId: "42",
    telegramUserId: "7",
    telegramMaxFileBytes: 45 * 1024 * 1024,
    codexWorkspace: "C:\\work",
    codexSandbox: "read-only",
    codexMaxConcurrentTurns: 2,
    codexRunnerIdleMs: 0
  };
  return { relay: new Relay(config, { telegram, store, runner }), sent, sessions, getCreatedTopics: () => createdTopics };
}

test("relay ignores every chat except the configured chat", async () => {
  const { relay, sent } = fixture();
  await relay.handleUpdate({ message: { message_id: 1, from: { id: 7 }, chat: { id: 99 }, text: "hello" } });
  assert.equal(sent.length, 0);
});

test("attachment paths stay inside the project and exclude sensitive files", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-attachment-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.writeFileSync(path.join(root, "output", "report.txt"), "report");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=value");
  fs.writeFileSync(path.join(temp, "outside.txt"), "outside");
  const valid = resolveAttachmentFile("output/report.txt", root, 100);
  assert.equal(valid.fileName, "report.txt");
  assert.equal(valid.size, 6);
  assert.throws(() => resolveAttachmentFile("../outside.txt", root, 100), /inside the current project/);
  assert.throws(() => resolveAttachmentFile(".env", root, 100), /Sensitive files/);
  assert.throws(() => resolveAttachmentFile("output/report.txt", root, 5), /too large/);
});

test("attachment uploads retry one transient failure", async () => {
  let calls = 0;
  const telegram = {
    sendDocument: async (_chatId, _filePath, options) => {
      calls++;
      assert.ok(options.signal instanceof AbortSignal);
      if (calls === 1) throw new TypeError("fetch failed");
      return { message_id: 9 };
    }
  };
  const result = await sendDocumentWithRetry(telegram, "42", "/tmp/report.pdf", {}, { timeoutMs: 100, retries: 1 });
  assert.equal(result.message_id, 9);
  assert.equal(calls, 2);
});

test("attachment uploads time out and honour cancellation", async () => {
  const telegram = {
    sendDocument: async (_chatId, _filePath, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  };
  await assert.rejects(
    sendDocumentWithRetry(telegram, "42", "/tmp/report.pdf", {}, { timeoutMs: 10, retries: 0 }),
    /timed out after 0.01 seconds/
  );
  const controller = new AbortController();
  const pending = sendDocumentWithRetry(telegram, "42", "/tmp/report.pdf", {}, {
    timeoutMs: 1000,
    retries: 1,
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("relay ignores other users inside the configured group", async () => {
  const { relay, sent } = fixture();
  await relay.handleUpdate({ message: { message_id: 2, from: { id: 8 }, chat: { id: 42 }, text: "hello" } });
  assert.equal(sent.length, 0);
});

test("inbound attachment selection supports common documents, images, and rejects other types", () => {
  assert.equal(inboundAttachment({ document: { file_id: "a", file_name: "report.PDF" } }).kind, "document");
  assert.equal(inboundAttachment({ document: { file_id: "b", file_name: "chart.png" } }).kind, "image");
  assert.equal(inboundAttachment({ message_id: 4, photo: [{ file_id: "small" }, { file_id: "large" }] }).fileId, "large");
  assert.equal(inboundAttachment({ document: { file_id: "c", file_name: "archive.zip" } }).unsupported, true);
});

test("authorized Telegram attachments are downloaded into the selected project and passed to Codex", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-inbound-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { relay, sessions } = fixture();
  sessions.set("42:77", { cwd: root, threadId: "existing" });
  relay.telegram.downloadFile = async (_fileId, destination) => fs.writeFileSync(destination, "document");
  let received;
  relay.runner.run = async (...args) => {
    received = args;
    return { threadId: "existing", text: "done" };
  };
  await relay.handleUpdate({ message: {
    message_id: 44,
    from: { id: 7 },
    chat: { id: 42 },
    message_thread_id: 77,
    caption: "总结附件",
    document: { file_id: "file-1", file_name: "report.pdf", file_size: 8 }
  } });
  assert.equal(received[0], "总结附件");
  assert.equal(received[3][0].kind, "document");
  assert.equal(received[3][0].name, "44-report.pdf");
  assert.equal(fs.readFileSync(received[3][0].path, "utf8"), "document");
});

test("unauthorized attachments are ignored before download", async () => {
  const { relay, sent } = fixture();
  let downloads = 0;
  relay.telegram.downloadFile = async () => { downloads++; };
  await relay.handleUpdate({ message: {
    message_id: 45,
    from: { id: 8 },
    chat: { id: 42 },
    document: { file_id: "file-2", file_name: "report.pdf", file_size: 8 }
  } });
  assert.equal(downloads, 0);
  assert.equal(sent.length, 0);
});

test("relay sends a Codex result and persists its thread", async () => {
  const { relay, sent, sessions } = fixture();
  await relay.handleUpdate({ message: { message_id: 5, from: { id: 7 }, chat: { id: 42 }, text: "hello" } });
  assert.match(sent.at(-1).text, /answer:[\s\S]*hello$/);
  assert.equal(sent.at(-1).options.replyToMessageId, 5);
  assert.equal(sessions.get("42").threadId, "thread-1");
});

test("separate Telegram topics persist separate Codex chats", async () => {
  const { relay, sessions } = fixture();
  await relay.handleUpdate({ message: { message_id: 6, from: { id: 7 }, message_thread_id: 77, chat: { id: 42 }, text: "topic hello" } });
  assert.equal(sessions.get("42:77").threadId, "thread-1");
});

test("a ForceReply resolves the matching proactive question", async () => {
  const { relay } = fixture();
  const answerPromise = relay.askTelegram("Proceed?", 10);
  await new Promise(resolve => setImmediate(resolve));
  await relay.handleUpdate({ message: { message_id: 8, from: { id: 7 }, chat: { id: 42 }, text: "Yes", reply_to_message: { message_id: 101 } } });
  assert.equal(await answerPromise, "Yes");
});

test("the next message in a topic resolves its sole proactive question", async () => {
  const { relay } = fixture();
  const answerPromise = relay.askTelegram("Proceed?", 10, 77);
  await new Promise(resolve => setImmediate(resolve));
  await relay.handleUpdate({ message: { message_id: 9, from: { id: 7 }, message_thread_id: 77, chat: { id: 42 }, text: "Yes" } });
  assert.equal(await answerPromise, "Yes");
});

test("locally initiated contact creates and reuses a project topic", async () => {
  const { relay, sessions, getCreatedTopics } = fixture();
  const first = await relay.resolveDestinationTopic({ projectPath: "C:\\work" });
  const second = await relay.resolveDestinationTopic({ projectPath: "C:\\work" });
  assert.equal(first, 81);
  assert.equal(second, 81);
  assert.equal(getCreatedTopics(), 1);
  assert.equal(sessions.get("42:81").purpose, "project-contact");
});

test("a known Codex thread routes to its exact mapped topic", async () => {
  const { relay, sessions, getCreatedTopics } = fixture();
  sessions.set("42:17", { threadId: "known-thread", cwd: "C:\\work" });
  const topicId = await relay.resolveDestinationTopic({ projectPath: "C:\\work", threadId: "known-thread" });
  assert.equal(topicId, 17);
  assert.equal(getCreatedTopics(), 0);
});

test("a direct reply to a one-way notification does not start a Codex turn", async () => {
  const { relay, sent, sessions } = fixture();
  await relay.handleUpdate({
    message: {
      message_id: 20,
      from: { id: 7 },
      chat: { id: 42 },
      text: "Why?",
      reply_to_message: { message_id: 19, text: `${NOTIFICATION_HEADER}\n\nDone.` }
    }
  });
  assert.match(sent.at(-1).text, /one-way notification/);
  assert.match(sent.at(-1).text, /not forwarded/);
  assert.equal(sessions.size, 0);
});

test("a new Telegram chat clearly identifies itself as local and not Remote", async () => {
  const { relay, sent } = fixture();
  await relay.handleUpdate({ message: { message_id: 21, from: { id: 7 }, chat: { id: 42 }, text: "hello" } });
  assert.match(sent[0].text, /Telegram-local Codex chat/);
  assert.match(sent[0].text, /will not appear as an existing Codex Remote task/);
});

const projectUpdate = (text, topic = 77, user = 7) => ({ message: {
  message_id: 30, from: { id: user }, chat: { id: 42 }, message_thread_id: topic, text
} });

test("project numbers select the displayed snapshot in the same topic and clear the thread", async () => {
  const { relay, sent, sessions } = fixture();
  relay.runner.listProjects = async () => [process.cwd(), "/missing-project-for-test"];
  await relay.handleUpdate(projectUpdate("/projects@mybot"));
  assert.match(sent.at(-1).text, /1\./);
  assert.equal(sent.at(-1).options.messageThreadId, 77);
  sessions.set("42:77", { threadId: "previous" });
  relay.runner.listProjects = async () => [];
  await relay.handleUpdate(projectUpdate("/project\t1"));
  assert.deepEqual(sessions.get("42:77"), { cwd: process.cwd(), threadId: null });
  await relay.handleUpdate(projectUpdate("/project 2"));
  assert.match(sent.at(-1).text, /does not exist/);
  assert.equal(sessions.get("42:77").cwd, process.cwd());
});

test("project selections reject missing, cross-topic, zero, and out-of-range numbers", async () => {
  const { relay, sent, sessions } = fixture();
  relay.runner.listProjects = async () => [process.cwd()];
  await relay.handleUpdate(projectUpdate("/project 1"));
  assert.match(sent.at(-1).text, /Run \/projects/);
  await relay.handleUpdate(projectUpdate("/projects"));
  for (const [command, topic] of [["/project 1", 78], ["/project 0", 77], ["/project 2", 77]]) {
    await relay.handleUpdate(projectUpdate(command, topic));
    assert.match(sent.at(-1).text, /Run \/projects/);
  }
  assert.equal(sessions.size, 0);
});

test("unauthorized users cannot list history; failed refresh invalidates old numbers", async () => {
  const { relay, sent, sessions } = fixture();
  let calls = 0;
  relay.runner.listProjects = async () => { calls++; return [process.cwd()]; };
  await relay.handleUpdate(projectUpdate("/projects", 77, 8));
  assert.equal(calls, 0);
  assert.equal(sent.length, 0);
  await relay.handleUpdate(projectUpdate("/projects"));
  relay.log = () => {};
  relay.runner.listProjects = async () => { throw new Error("offline"); };
  await relay.handleUpdate(projectUpdate("/projects"));
  assert.match(sent.at(-1).text, /Could not list/);
  await relay.handleUpdate(projectUpdate("/project 1"));
  assert.match(sent.at(-1).text, /Run \/projects/);
  assert.equal(sessions.size, 0);
});

 test("Codex failures distinguish upstream throttling and concurrent writers", () => {
  assert.match(codexFailureMessage(new Error("exceeded retry limit, last status: 429 Too Many Requests")), /429 限流/);
  assert.match(codexFailureMessage(new Error("thread abc already has an active writer")), /其他客户端占用/);
  assert.match(codexFailureMessage(new Error("other failure")), /other failure/);
});

test("rate-limited turns are reported once without replaying the task", async () => {
  const { relay, sent } = fixture();
  let calls = 0;
  relay.log = () => {};
  relay.runner.run = async () => { calls++; throw new Error("429 Too Many Requests"); };
  await relay.handleUpdate(projectUpdate("test task"));
  assert.equal(calls, 1);
  assert.match(sent.at(-1).text, /429 限流/);
  assert.equal(sent.at(-1).options.messageThreadId, 77);
});

function deferredRunnerFactory(started, releases, cancelled = []) {
  return () => ({
    activeTurn: null,
    run: async (_prompt, _threadId, cwd) => new Promise(resolve => {
      started.push(cwd);
      releases.push(result => resolve(result));
    }),
    cancel: () => { cancelled.push(true); return true; },
    stop: async () => {}
  });
}

test("different Telegram topics run Codex turns concurrently", async () => {
  const { relay } = fixture();
  const started = [];
  const releases = [];
  relay.runnerFactory = deferredRunnerFactory(started, releases);
  relay.dispatchUpdate(projectUpdate("first", 77));
  relay.dispatchUpdate(projectUpdate("second", 78));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relay.activeTurns.size, 2);
  assert.equal(started.length, 2);
  releases[0]({ threadId: "thread-77", text: "first done" });
  releases[1]({ threadId: "thread-78", text: "second done" });
  await Promise.all([...relay.inflightTurns]);
  assert.equal(relay.activeTurns.size, 0);
});

test("the same Telegram topic remains single-turn", async () => {
  const { relay, sent } = fixture();
  const started = [];
  const releases = [];
  relay.runnerFactory = deferredRunnerFactory(started, releases);
  relay.dispatchUpdate(projectUpdate("first", 77));
  await new Promise(resolve => setImmediate(resolve));
  relay.dispatchUpdate(projectUpdate("second", 77));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1);
  assert.match(sent.at(-1).text, /already has a running Codex turn/);
  releases[0]({ threadId: "thread-77", text: "done" });
  await Promise.all([...relay.inflightTurns]);
});

test("the same saved Codex thread cannot run from two topics", async () => {
  const { relay, sent, sessions } = fixture();
  const started = [];
  const releases = [];
  sessions.set("42:77", { threadId: "shared-thread", cwd: "C:\\work" });
  sessions.set("42:78", { threadId: "shared-thread", cwd: "C:\\work" });
  relay.runnerFactory = deferredRunnerFactory(started, releases);
  relay.dispatchUpdate(projectUpdate("first", 77));
  await new Promise(resolve => setImmediate(resolve));
  relay.dispatchUpdate(projectUpdate("second", 78));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1);
  assert.match(sent.at(-1).text, /already running in another Telegram topic/);
  releases[0]({ threadId: "shared-thread", text: "done" });
  await Promise.all([...relay.inflightTurns]);
});

test("the concurrency cap rejects extra topics and cancel is topic-local", async () => {
  const { relay, sent } = fixture();
  const started = [];
  const releases = [];
  const cancelled = [];
  relay.runnerFactory = deferredRunnerFactory(started, releases, cancelled);
  relay.dispatchUpdate(projectUpdate("first", 77));
  relay.dispatchUpdate(projectUpdate("second", 78));
  await new Promise(resolve => setImmediate(resolve));
  relay.dispatchUpdate(projectUpdate("third", 79));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 2);
  assert.match(sent.at(-1).text, /already running 2 Codex turns/);
  await relay.handleUpdate(projectUpdate("/cancel", 77));
  assert.equal(cancelled.length, 1);
  assert.match(sent.at(-1).text, /this topic's active Codex turn/);
  releases[0]({ threadId: "thread-77", text: "done" });
  releases[1]({ threadId: "thread-78", text: "done" });
  await Promise.all([...relay.inflightTurns]);
});
