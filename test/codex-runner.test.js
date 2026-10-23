import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs, parseCodexJsonLines } from "../src/codex-runner.js";

test("parseCodexJsonLines extracts the thread and last agent message", () => {
  const parsed = parseCodexJsonLines([
    JSON.stringify({ type: "thread.started", thread_id: "abc" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } })
  ].join("\n"));
  assert.deepEqual(parsed, { threadId: "abc", text: "final" });
});

test("parseCodexJsonLines surfaces turn failures", () => {
  assert.throws(() => parseCodexJsonLines(JSON.stringify({ type: "turn.failed", error: { message: "nope" } })), /nope/);
});

test("buildCodexArgs keeps the workspace and least-privilege sandbox on resumed turns", () => {
  const args = buildCodexArgs({ codexCommandArgs: ["C:\\tools\\codex.js"], codexWorkspace: "C:\\work", codexSandbox: "workspace-write", codexSkipGitRepoCheck: true }, "thread-42");
  assert.deepEqual(args, [
    "C:\\tools\\codex.js",
    "exec", "--json", "--color", "never", "--cd", "C:\\work",
    "--sandbox", "workspace-write", "--skip-git-repo-check", "resume", "thread-42", "-"
  ]);
});
