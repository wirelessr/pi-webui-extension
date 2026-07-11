/**
 * API client — thin wrappers over fetch for the HTTP bridge endpoints.
 */

export async function getStatus() {
  const res = await fetch("/api/status");
  return res.json();
}

export async function getSessions() {
  const res = await fetch("/api/sessions");
  return res.json();
}

export async function getCommands() {
  const res = await fetch("/api/commands");
  return res.json();
}

export async function getHistory() {
  const res = await fetch("/api/history");
  return res.json();
}

export async function abortAgent() {
  const res = await fetch("/api/abort", { method: "POST" });
  return res.json();
}

export async function executeCommand(command) {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Send a prompt and stream SSE events.
 * @param {string} message
 * @param {(event: object) => void} onEvent
 * @returns {Promise<void>} Resolves when stream ends.
 */
export async function sendPromptStream(message, onEvent) {
  const res = await fetch("/api/prompt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      if (rawEvent.startsWith(":")) continue; // heartbeat

      for (const line of rawEvent.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          // Ignore parse errors
        }
      }
    }
  }
}
