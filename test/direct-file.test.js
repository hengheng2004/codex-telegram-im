import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendFileDirect } from "../src/direct-file.js";

test("explicit topic file delivery uploads directly within the mapped project", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-direct-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "report.pdf");
  fs.writeFileSync(file, "pdf");
  const calls = [];
  const telegram = {
    sendDocument: async (...args) => {
      calls.push(args);
      return { message_id: 1 };
    }
  };
  const store = {
    load: async () => {},
    getSession: (_chatId, topicId) => topicId === 213 ? { cwd: root } : null
  };
  const config = {
    telegramChatId: "42",
    telegramMaxFileBytes: 1024,
    telegramUploadTimeoutMs: 100,
    telegramUploadRetries: 0
  };

  const result = await sendFileDirect(config, {
    path: file,
    caption: "notes",
    topicId: 213,
    projectPath: "/wrong/project"
  }, { telegram, store });

  assert.deepEqual(result, { topicId: 213, fileName: "report.pdf", size: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "42");
  assert.equal(calls[0][1], fs.realpathSync(file));
  assert.equal(calls[0][2].messageThreadId, 213);
});

test("direct delivery keeps mapped-project path restrictions", async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-direct-file-scope-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  fs.mkdirSync(root);
  const outside = path.join(parent, "outside.pdf");
  fs.writeFileSync(outside, "pdf");
  const store = { load: async () => {}, getSession: () => ({ cwd: root }) };
  const config = {
    telegramChatId: "42",
    telegramMaxFileBytes: 1024,
    telegramUploadTimeoutMs: 100,
    telegramUploadRetries: 0
  };

  await assert.rejects(
    sendFileDirect(config, { path: outside, topicId: 213, projectPath: parent }, {
      telegram: { sendDocument: async () => ({}) }, store
    }),
    /inside the current project/
  );
});
