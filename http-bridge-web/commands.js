/**
 * Commands view — right sidebar, lists available skills and prompt templates.
 * Filters in real-time as the user types / commands in the input box.
 */

import { getCommands } from "./api.js";
import { createSelectionState } from "./selection-state.js";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Filter and rank commands by query match quality.
 * Pure function — no DOM dependency.
 * @param {Array} commands — available commands
 * @param {string} query — text after /, already lowercased
 * @returns {Array} filtered commands sorted by rank then name
 */
export function filterCommands(commands, query) {
  const q = query.toLowerCase();
  return commands
    .map((cmd) => {
      const name = cmd.name.toLowerCase();
      if (name === q) return { cmd, rank: 0 };
      if (name.startsWith(q)) return { cmd, rank: 1 };
      if (name.match(new RegExp("[/\\\\\\-_]" + escapeRegex(q)))) return { cmd, rank: 2 };
      if (name.includes(q)) return { cmd, rank: 3 };
      const desc = (cmd.description || "").toLowerCase();
      if (desc.includes(q)) return { cmd, rank: 4 };
      return null;
    })
    .filter((m) => m !== null)
    .sort((a, b) => a.rank - b.rank || a.cmd.name.localeCompare(b.cmd.name))
    .map((m) => m.cmd);
}

export function createCommandsView({ $list, $count, $title, onSelect }) {
  const state = createSelectionState(onSelect);

  async function load() {
    try {
      const data = await getCommands();
      state.setCommands(data.commands || []);
      render();
    } catch {
      state.setCommands([]);
      $list.innerHTML = '<div class="cmd-empty">Failed to load</div>';
    }
  }

  function render() {
    const filteredCommands = state.getFiltered();
    $list.innerHTML = "";
    $count.textContent = String(filteredCommands.length);

    if (filteredCommands.length === 0) {
      $list.innerHTML = '<div class="cmd-empty">No matches</div>';
      return;
    }

    filteredCommands.forEach((cmd, i) => {
      const el = document.createElement("div");
      el.className = "cmd-item";
      el.dataset.index = i;

      const nameEl = document.createElement("div");
      nameEl.className = "cmd-name";
      nameEl.textContent = "/" + cmd.name;

      const sourceEl = document.createElement("span");
      sourceEl.className = "cmd-source";
      sourceEl.textContent = cmd.source;

      const descEl = document.createElement("div");
      descEl.className = "cmd-desc";
      descEl.textContent = cmd.description || "";

      el.appendChild(nameEl);
      el.appendChild(sourceEl);
      el.appendChild(descEl);

      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        moveToIndex(i);
        state.select();
      });
      el.addEventListener("mouseenter", () => {
        moveToIndex(i);
        highlight();
      });

      $list.appendChild(el);
    });
  }

  function moveToIndex(i) {
    // Directly set selection — uses move(0) trick isn't clean,
    // so we expose index via a small internal hack
    // Actually we need to set selectedIndex directly. Let's use
    // move with a computed delta.
    const current = state.getSelectedIndex();
    const len = state.getFiltered().length;
    if (len === 0) return;
    const delta = (i - current + len) % len;
    state.move(delta);
  }

  function highlight() {
    const items = $list.querySelectorAll(".cmd-item");
    const idx = state.getSelectedIndex();
    items.forEach((el, i) => { el.classList.toggle("selected", i === idx); });
    if (idx >= 0 && items[idx]) {
      items[idx].scrollIntoView({ block: "nearest" });
    }
  }

  function move(delta) {
    state.move(delta);
    highlight();
  }

  function select() {
    state.select();
  }

  function filter(query) {
    state.filter(query, filterCommands);
    const filteredCommands = state.getFiltered();
    $title.textContent = query === null
      ? "commands"
      : filteredCommands.length > 0
        ? `commands · "/${query}"`
        : `commands · no match`;
    render();
  }

  return { load, filter, move, select, hasFilter: state.hasFilter, getSelectedIndex: state.getSelectedIndex };
}
