/**
 * Commands view — right sidebar, lists available skills and prompt templates.
 * Filters in real-time as the user types / commands in the input box.
 */

import { getCommands } from "./api.js";

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
  let availableCommands = [];
  let filteredCommands = [];
  let selectedIndex = -1;

  async function load() {
    try {
      const data = await getCommands();
      availableCommands = data.commands || [];
      filteredCommands = availableCommands;
      render();
    } catch {
      availableCommands = [];
      $list.innerHTML = '<div class="cmd-empty">Failed to load</div>';
    }
  }

  function render() {
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
        selectedIndex = i;
        select();
      });
      el.addEventListener("mouseenter", () => {
        selectedIndex = i;
        highlight();
      });

      $list.appendChild(el);
    });
  }

  function highlight() {
    const items = $list.querySelectorAll(".cmd-item");
    items.forEach((el, i) => { el.classList.toggle("selected", i === selectedIndex); });
    if (selectedIndex >= 0 && items[selectedIndex]) {
      items[selectedIndex].scrollIntoView({ block: "nearest" });
    }
  }

  function move(delta) {
    if (filteredCommands.length === 0) return;
    selectedIndex = (selectedIndex + delta + filteredCommands.length) % filteredCommands.length;
    highlight();
  }

  function select() {
    if (selectedIndex < 0 || selectedIndex >= filteredCommands.length) return;
    onSelect(filteredCommands[selectedIndex]);
  }

  /**
   * Filter commands based on the current / token in the input.
   * @param {string|null} query — text after /, or null to show all
   */
  function filter(query) {
    if (query === null) {
      filteredCommands = availableCommands;
      selectedIndex = -1;
      $title.textContent = "commands";
      render();
      return;
    }

    filteredCommands = filterCommands(availableCommands, query);

    selectedIndex = -1;
    $title.textContent = filteredCommands.length > 0
      ? `commands · "/${query}"`
      : `commands · no match`;
    render();
  }

  function hasFilter() {
    return filteredCommands.length > 0;
  }

  return { load, filter, move, select, hasFilter, getSelectedIndex: () => selectedIndex };
}
