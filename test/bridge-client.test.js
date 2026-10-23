import test from "node:test";
import assert from "node:assert/strict";
import { bridgeRequest } from "../src/bridge-client.js";

test("bridge requests enforce deadlines and external cancellation", async t => {
  const signals = [];
  t.mock.method(globalThis, "fetch", (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const config = {
    bridgeHost: "127.0.0.1",
    bridgePort: 43921,
    bridgeToken: "test-token"
  };

  await assert.rejects(
    bridgeRequest(config, "/hang", {}, { timeoutMs: 20 }),
    /timed out after 20 ms/
  );

  const controller = new AbortController();
  const pending = bridgeRequest(config, "/hang", {}, { timeoutMs: 1000, signal: controller.signal });
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(pending, /cancelled by test/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
});
