/**
 * SSE broadcast set — pure client bookkeeping for the bridge's fan-out:
 * N concurrent viewers (attach streams and the sender's prompt stream) all
 * receive the same turn events live.
 *
 * Replaces the old single-slot `sse` variable in index.ts, where a second
 * viewer could only steal the slot (attach ping-pong between tabs). A client
 * here is { res, origin } — res is the Node-res-like SSE wrapper from
 * bridge-app's createSseRes (write/end/onClose), origin is "prompt" or
 * "attach" (informational; no origin gets special treatment anymore).
 *
 * Failure containment: a write/heartbeat failure evicts ONLY that client.
 * One shared heartbeat interval runs while any client is connected.
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.heartbeatMs]
 * @param {(client: {res: object, origin: string}, reason: string) => void} [opts.onEvict]
 *   — called when a client is dropped for a write/heartbeat failure (NOT on
 *   normal close/closeAll), so the owner can log it.
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 */
export function createSseBroadcast(opts = {}) {
  const {
    heartbeatMs = 15000,
    onEvict = () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = opts;

  const clients = new Set();
  let heartbeat = null;

  function stopHeartbeatIfIdle() {
    if (clients.size === 0 && heartbeat !== null) {
      clearIntervalFn(heartbeat);
      heartbeat = null;
    }
  }

  function drop(client) {
    clients.delete(client);
    try {
      client.res.end();
    } catch {
      // Already dead — eviction is best-effort.
    }
    stopHeartbeatIfIdle();
  }

  function evict(client, reason) {
    drop(client);
    onEvict(client, reason);
  }

  function beat() {
    for (const c of [...clients]) {
      try {
        c.res.write(": heartbeat\n\n");
      } catch {
        evict(c, "heartbeat write failed");
      }
    }
  }

  return {
    /**
     * Register a client. The caller wires res.onClose to remove(client) —
     * onClose semantics belong to the transport wrapper, not this set.
     * @returns {{res: object, origin: string}} the client handle
     */
    add(res, origin) {
      const client = { res, origin };
      clients.add(client);
      if (heartbeat === null) heartbeat = setIntervalFn(beat, heartbeatMs);
      return client;
    },

    /** Remove a client without touching its stream (it closed itself). */
    remove(client) {
      clients.delete(client);
      stopHeartbeatIfIdle();
    },

    /** Send one event to one client; evicts it on failure. */
    writeTo(client, data) {
      if (!clients.has(client)) return false;
      try {
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        evict(client, "write failed");
        return false;
      }
    },

    /** Send one event to every connected client. */
    broadcast(data) {
      for (const c of [...clients]) {
        if (!clients.has(c)) continue;
        try {
          c.res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          evict(c, "write failed");
        }
      }
    },

    /** End every stream (turn done / shutdown) and clear the set. */
    closeAll() {
      for (const c of [...clients]) drop(c);
    },

    size: () => clients.size,
    has: (client) => clients.has(client),
  };
}
