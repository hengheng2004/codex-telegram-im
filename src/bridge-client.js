export async function bridgeRequest(config, route, body, { timeoutMs = 15000, signal } = {}) {
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const abort = (error) => {
    if (controller.signal.aborted) return;
    controller.abort(error);
    rejectDeadline(error);
  };
  const onExternalAbort = () => abort(signal.reason instanceof Error ? signal.reason : new Error("Bridge request cancelled"));
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => abort(new Error(`Bridge request timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    const request = fetch(`http://${config.bridgeHost}:${config.bridgePort}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.bridgeToken}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const response = await Promise.race([request, deadline]);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Bridge returned HTTP ${response.status}`);
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}
