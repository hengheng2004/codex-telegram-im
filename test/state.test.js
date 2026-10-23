import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.js";

test("StateStore persists Telegram offsets and Codex sessions", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const first = new StateStore(file);
  await first.load();
  await first.setUpdateOffset(91);
  await first.setSession("42", null, { threadId: "thread-123", cwd: "C:\\work" });
  await first.setSession("42", 7, { threadId: "thread-topic", cwd: "C:\\project" });
  await first.setSession("42", 8, { cwd: "C:\\project", purpose: "project-contact" });

  const second = new StateStore(file);
  await second.load();
  assert.equal(second.data.updateOffset, 91);
  assert.equal(second.getSession("42").threadId, "thread-123");
  assert.equal(second.getSession("42", 7).threadId, "thread-topic");
  assert.equal(second.findTopicByThread("42", "thread-topic").topicId, 7);
  const lookup = process.platform === "win32" ? "C:\\PROJECT" : "C:\\project";
  assert.equal(second.findProjectContactTopic("42", lookup).topicId, 8);
  if (process.platform !== "win32") assert.equal(second.findProjectContactTopic("42", "C:\\PROJECT"), null);
  await second.clearSession("42");
  assert.equal(second.getSession("42"), null);
});
