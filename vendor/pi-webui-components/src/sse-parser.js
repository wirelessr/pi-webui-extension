/**
 * SSE (Server-Sent Events) buffer parser.
 * Pure function — no DOM, no fetch, no side effects.
 */

/**
 * Parse complete SSE events from a buffer.
 * Events are separated by \n\n. Each event may have multiple lines,
 * but we only care about "data: " lines.
 * Lines starting with ":" are comments (heartbeats) and are skipped.
 * @param {string} buffer — raw text buffer
 * @returns {{events: Array, rest: string}} parsed events and remaining buffer
 */
export function parseSseBuffer(buffer) {
  const events = [];
  let rest = buffer;

  let idx;
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    const rawEvent = rest.slice(0, idx);
    rest = rest.slice(idx + 2);

    if (rawEvent.startsWith(":")) continue;

    for (const line of rawEvent.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // Ignore parse errors
      }
    }
  }

  return { events, rest };
}
