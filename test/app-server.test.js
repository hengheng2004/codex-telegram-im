import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexAppServer } from "../src/app-server.js";

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0);
  return child;
}

test("app-server initializes and lists all interactive thread sources", async () => {
  const child = fakeProcess();
  const requests = [];
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      requests.push(message);
      if (message.id != null) {
        const result = message.method === "thread/list" ? { data: [{ id: "thr-1" }] } : {};
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    }
  });
  const server = new CodexAppServer({ codexCommand: "codex", codexCommandArgs: [], codexWorkspace: "C:\\work" }, () => child);
  const threads = await server.listThreads({ cwd: "C:\\work" });
  assert.deepEqual(threads, [{ id: "thr-1" }]);
  const list = requests.find(request => request.method === "thread/list");
  assert.equal(list.params.cwd, "C:\\work");
  assert.ok(list.params.sourceKinds.includes("appServer"));
});

test("resumed chats use the CLI default model and complete with isolated text", async () => {
  const child = fakeProcess();
  const requests = [];
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      requests.push(message);
      if (message.id == null) continue;
      let result = {};
      if (message.method === "model/list") result = { data: [{ model: "cli-default", isDefault: true }] };
      if (message.method === "thread/resume") result = { thread: { id: message.params.threadId } };
      if (message.method === "turn/start") {
        result = { turn: { id: "turn-test" } };
        setImmediate(() => {
          child.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: message.params.threadId, item: { type: "agentMessage", text: "测试回答" } } }) + "\n");
          child.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-test", status: "completed" } } }) + "\n");
        });
      }
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    }
  });
  const server = new CodexAppServer({ codexCommand: "codex", codexWorkspace: "/tmp", codexSandbox: "read-only", codexTimeoutMs: 2000 }, () => child);
  const result = await server.run("hi", "existing-thread");
  assert.equal(result.threadId, "existing-thread");
  assert.equal(result.text, "测试回答");
  assert.equal(requests.find(r => r.method === "thread/resume").params.model, "cli-default");
  assert.equal(requests.find(r => r.method === "turn/start").params.sandboxPolicy.type, "readOnly");
  await server.stop();
});

test("turn input includes local images and document mentions", async () => {
  const server = new CodexAppServer({ codexWorkspace: "/tmp", codexSandbox: "read-only", codexModel: "test", codexTimeoutMs: 1000 });
  server.start = async () => {};
  server.request = async (method, params) => {
    if (method === "thread/start") return { thread: { id: "thread" } };
    if (method === "turn/start") {
      assert.deepEqual(params.input, [
        { type: "text", text: "inspect" },
        { type: "localImage", path: "/tmp/photo.jpg" },
        { type: "mention", name: "report.pdf", path: "/tmp/report.pdf" }
      ]);
      setImmediate(() => server.emit("notification", { method: "item/completed", params: { threadId: "thread", item: { type: "agentMessage", text: "done" } } }));
      setImmediate(() => server.emit("notification", { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } }));
      return { turn: { id: "turn" } };
    }
    return {};
  };
  const result = await server.run("inspect", null, "/tmp", [
    { kind: "image", path: "/tmp/photo.jpg", name: "photo.jpg" },
    { kind: "document", path: "/tmp/report.pdf", name: "report.pdf" }
  ]);
  assert.equal(result.text, "done");
});

test("zero turn timeout disables the bridge-level deadline", async () => {
  const child = fakeProcess();
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.id == null) continue;
      let result = {};
      if (message.method === "thread/start") result = { thread: { id: "thr-unlimited" } };
      if (message.method === "turn/start") {
        result = { turn: { id: "turn-unlimited" } };
        setTimeout(() => {
          child.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "thr-unlimited", item: { type: "agentMessage", text: "done" } } }) + "\n");
          child.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thr-unlimited", turn: { id: "turn-unlimited", status: "completed" } } }) + "\n");
        }, 10);
      }
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    }
  });
  const server = new CodexAppServer({
    codexCommand: "codex",
    codexWorkspace: "/tmp",
    codexSandbox: "workspace-write",
    codexModel: "test-model",
    codexTimeoutMs: 0
  }, () => child);
  const result = await server.run("wait for completion");
  assert.deepEqual(result, { threadId: "thr-unlimited", text: "done" });
  await server.stop();
});

test("projects paginate history and deduplicate normalized cwd in recency order", async () => {
  const server = new CodexAppServer({});
  const calls = [];
  server.request = async (method, params) => {
    calls.push({ method, params });
    return params.cursor === null
      ? { data: [{ cwd: "/tmp/new" }, { cwd: "/tmp/new/" }, { cwd: "relative" }, {}], nextCursor: "page2" }
      : { data: [{ cwd: "/tmp/older" }, { cwd: "/tmp/new" }], nextCursor: null };
  };
  assert.deepEqual(await server.listProjects(), ["/tmp/new", "/tmp/older"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.cursor, "page2");
  assert.equal(calls[0].params.sortKey, "updated_at");
  assert.equal(calls[0].params.sortDirection, "desc");
  assert.equal("cwd" in calls[0].params, false);
});

test("project listing rejects repeated history cursors", async () => {
  const server = new CodexAppServer({});
  server.request = async () => ({ data: [], nextCursor: "same" });
  await assert.rejects(server.listProjects(), /Repeated/);
});
