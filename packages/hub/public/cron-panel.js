/**
 * Cron panel (hub sidebar): job list with Run now, per-job run history, and a
 * per-run action chosen by the SERVER (`action`: select | wait | open | log),
 * because only the server can see pids, exit files and session files.
 * Display names come from run.json (`run.name`), never from the session list.
 * DOM only; the decision logic lives in src/cron.js.
 */

const STATE_LABEL = { running: "running", ok: "finished", failed: "failed", unknown: "unknown", skipped: "skipped" };
const POLL_MS = 5000;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// GET JSON from the cron API; a non-2xx status or a non-JSON body (an old hub
// without the routes answers 404 text/plain) becomes an Error with a message
// meant for the panel.
async function getJson(url) {
  const res = await fetch(url);
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}${data?.error ? `: ${data.error}` : ""}`);
  if (!data || typeof data !== "object") throw new Error(`HTTP ${res.status}: response is not JSON`);
  return data;
}

function localTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "";
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.$section — container with header + body
 * @param {HTMLElement} opts.$chat — overlay parent for the log view
 * @param {object} opts.overlays — overlay manager
 * @param {(sessionId: string) => void} opts.onSelect — switch to a live session
 * @param {(sessionId: string, name: string) => void} opts.onOpen — open a finished run's session
 */
export function createCronPanel({ $section, $chat, overlays, onSelect, onOpen }) {
  const $toggle = $section.querySelector(".cron-toggle");
  const $refresh = $section.querySelector(".cron-refresh");
  const $body = $section.querySelector(".cron-body");
  let collapsed = localStorage.getItem("pi-hub-cron-collapsed") !== "false";
  let expandedJob = null;
  let jobsData = null;
  let jobsError = null;
  let runsData = [];
  let runsError = null;
  let pollTimer = null;

  // ── Log overlay ──
  const $log = el("div", "tree-view cron-log-view");
  $log.style.display = "none";
  $chat.appendChild($log);
  let logOpen = false;
  const logHandle = { close: closeLog };
  function closeLog() {
    if (!logOpen) return;
    logOpen = false;
    $log.style.display = "none";
    $log.innerHTML = "";
    overlays.closed(logHandle);
  }
  async function showLog(run) {
    overlays.open(logHandle);
    logOpen = true;
    $log.innerHTML = "";
    const header = el("div", "tree-view-header");
    header.appendChild(el("span", "tree-view-title", `${run.name} (${STATE_LABEL[run.state] || run.state})`));
    const reload = el("button", "tree-view-close", "⟳");
    reload.title = "Reload log";
    reload.addEventListener("click", () => showLog(run));
    const close = el("button", "tree-view-close", "×");
    close.addEventListener("click", closeLog);
    header.append(reload, close);
    const pre = el("pre", "cron-log-text", "loading...");
    $log.append(header, pre);
    $log.style.display = "";
    $chat.scrollTop = 0;
    try {
      const data = await getJson(`/api/cron/runs/${encodeURIComponent(run.runId)}/log`);
      const parts = [];
      if (data.error) parts.push(`[error] ${data.error}`);
      if (data.truncated) parts.push("[showing the last 256 KB]");
      parts.push(data.log ?? (data.error ? "" : "(no output)"));
      pre.textContent = parts.join("\n");
    } catch (err) {
      pre.textContent = `Failed to load log: ${err.message}`;
    }
  }

  // ── Rendering ──
  function statusBadge(state) {
    return el("span", `cron-state cron-state-${state}`, STATE_LABEL[state] || state);
  }

  function renderRuns($parent) {
    const $runs = el("div", "cron-runs");
    if (runsError) $runs.appendChild(el("div", "cron-error cron-api-error", `Run history unavailable (${runsError})`));
    else if (!runsData.length) $runs.appendChild(el("div", "cmd-empty", "No runs yet"));
    for (const run of runsData) {
      const row = el("div", "cron-run");
      const info = el("div", "cron-run-info");
      // Scheduled runs show their slot; a catch-up run also shows when it started.
      const late = run.trigger === "schedule" && run.startedAt && Date.parse(run.startedAt) - Date.parse(run.scheduledFor) >= 60_000;
      info.append(statusBadge(run.state), el("span", "cron-run-time", localTime(run.trigger === "schedule" ? run.scheduledFor : run.createdAt)));
      info.appendChild(el("span", "cron-run-trigger", late ? `${run.trigger}, started ${localTime(run.startedAt)}` : run.trigger));
      const actions = el("div", "cron-run-actions");
      if (run.action === "select" || run.action === "open") {
        const go = el("button", "cron-btn", run.action === "select" ? "Go to session" : "Open");
        go.addEventListener("click", () => (run.action === "select" ? onSelect(run.sessionId) : onOpen(run.sessionId, run.name)));
        actions.appendChild(go);
      }
      const logBtn = el("button", "cron-btn", "Log");
      logBtn.addEventListener("click", () => showLog(run));
      actions.appendChild(logBtn);
      row.append(info, actions);
      $runs.appendChild(row);
    }
    $parent.appendChild($runs);
  }

  function render() {
    $toggle.textContent = `${collapsed ? "▸" : "▾"} cron`;
    $body.classList.toggle("hidden", collapsed);
    if (collapsed) return;
    $body.innerHTML = "";
    if (jobsError) { $body.appendChild(el("div", "cron-banner cron-error cron-api-error", `cron API unavailable (${jobsError}), restart hub`)); return; }
    if (!jobsData) { $body.appendChild(el("div", "cmd-empty", "loading...")); return; }
    if (!jobsData.owner) $body.appendChild(el("div", "cron-banner cron-not-owner", "This hub is not the scheduler owner: read-only (another hub runs the schedule, or ownership is being confirmed)"));
    if (jobsData.fileError) $body.appendChild(el("div", "cron-banner cron-error", jobsData.fileError));
    for (const job of jobsData.jobs) {
      const row = el("div", "cron-job");
      const head = el("div", "cron-job-head");
      const name = el("span", "cron-job-name", `${expandedJob === job.id ? "▾" : "▸"} ${job.name ?? "(invalid job)"}`);
      name.addEventListener("click", () => toggleJob(job.id));
      const runNow = el("button", "cron-btn", "Run now");
      runNow.disabled = !!job.error || !job.id || !jobsData.owner;
      runNow.addEventListener("click", () => runJob(job.id));
      head.append(name, runNow);
      const meta = el("div", "cron-job-meta");
      meta.append(el("span", null, `${job.schedule ?? ""}${job.enabled ? "" : " (disabled)"}`));
      if (job.enabled && job.nextRunAt) meta.append(el("span", "cron-next", `next ${localTime(job.nextRunAt)}`));
      if (job.latestRun) meta.append(statusBadge(job.latestRun.state));
      row.append(head, meta);
      if (job.error) row.appendChild(el("div", "cron-error", job.error));
      if (expandedJob === job.id) renderRuns(row);
      $body.appendChild(row);
    }
    if (!jobsData.jobs.length && !jobsData.fileError) $body.appendChild(el("div", "cmd-empty", "No jobs"));
  }

  // ── Data ──
  // Never rejects: every failure becomes a visible error state, and the next
  // poll retries.
  async function refresh() {
    if (collapsed) return;
    try {
      jobsData = await getJson("/api/cron/jobs");
      jobsError = null;
    } catch (err) {
      jobsError = err.message;
    }
    runsData = [];
    runsError = null;
    if (expandedJob && !jobsError) {
      try {
        runsData = (await getJson(`/api/cron/jobs/${encodeURIComponent(expandedJob)}/runs`)).runs || [];
      } catch (err) {
        runsError = err.message;
      }
    }
    try {
      render();
    } catch (err) {
      $body.textContent = `cron panel error: ${err.message}`;
    }
  }

  function toggleJob(id) {
    expandedJob = expandedJob === id ? null : id;
    runsData = [];
    refresh();
  }

  async function runJob(id) {
    try {
      const res = await fetch(`/api/cron/jobs/${encodeURIComponent(id)}/run`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      alert(`Run now failed: ${err.message}`);
    }
    expandedJob = id;
    refresh();
  }

  function setPolling() {
    clearInterval(pollTimer);
    pollTimer = collapsed ? null : setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }

  $toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    localStorage.setItem("pi-hub-cron-collapsed", String(collapsed));
    setPolling();
    render();
    refresh();
  });
  $refresh.addEventListener("click", refresh);

  setPolling();
  render();
  refresh();
  return { refresh };
}
