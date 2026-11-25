/**
 * Session tree overlay — shows the user-message tree and switches branches.
 *
 * A sibling of #messages inside #chat; hiding/restoring the transcript and
 * overlay exclusivity are the overlay manager's job (overlay-manager.js).
 */

import { flattenUserTree } from "./tree-render.js";

/**
 * @param {object} opts
 * @param {HTMLElement} opts.$chat — scroll container (overlay parent)
 * @param {object} opts.overlays — overlay manager (createOverlayManager)
 * @param {function} opts.getTreeFn — () => Promise<{nodes, leafId}>
 * @param {function} opts.navigateFn — (targetId) => Promise
 * @param {function} opts.onNavigated — () => void, reload transcript after a switch
 * @param {function} [opts.isBusyFn] — () => boolean, disables navigation while busy
 */
export function createTreeView({ $chat, overlays, getTreeFn, navigateFn, onNavigated, isBusyFn = () => false }) {
  const $view = document.createElement("div");
  $view.className = "tree-view";
  $view.style.display = "none";
  $chat.appendChild($view);

  let isOpen = false;
  const handle = { close };

  function close() {
    if (!isOpen) return;
    isOpen = false;
    $view.style.display = "none";
    $view.innerHTML = "";
    overlays.closed(handle);
  }

  async function open() {
    if (isOpen) return;
    overlays.open(handle);
    isOpen = true;
    $view.innerHTML = "";

    const header = document.createElement("div");
    header.className = "tree-view-header";
    const title = document.createElement("span");
    title.className = "tree-view-title";
    title.textContent = "Session tree";
    const closeBtn = document.createElement("button");
    closeBtn.className = "tree-view-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);
    header.appendChild(title);
    header.appendChild(closeBtn);
    $view.appendChild(header);

    const list = document.createElement("div");
    list.className = "tree-view-list";
    $view.appendChild(list);

    $view.style.display = "";
    $chat.scrollTop = 0;

    let data;
    try {
      data = await getTreeFn();
    } catch (err) {
      list.textContent = `Failed to load tree: ${err.message || err}`;
      return;
    }
    if (!isOpen) return; // closed while loading

    const rows = flattenUserTree(data.nodes || []);
    if (rows.length === 0) {
      list.textContent = "No messages yet.";
      return;
    }
    const busy = isBusyFn();
    for (const row of rows) {
      const el = document.createElement("button");
      el.className = "tree-row";
      if (row.active) el.classList.add("active");
      if (row.current) el.classList.add("current");
      el.style.paddingLeft = `${12 + row.depth * 20}px`;

      const connector = document.createElement("span");
      connector.className = "tree-row-connector";
      connector.textContent = row.connector ? `${row.connector}─ ` : "";
      const text = document.createElement("span");
      text.className = "tree-row-text";
      text.textContent = row.text;
      el.appendChild(connector);
      el.appendChild(text);
      if (row.current) {
        const marker = document.createElement("span");
        marker.className = "tree-row-marker";
        marker.textContent = " ● current";
        el.appendChild(marker);
      }

      if (busy || row.current) {
        el.disabled = true;
        if (busy) el.title = "Agent is busy — cannot switch branches mid-turn";
      } else {
        el.addEventListener("click", async () => {
          for (const b of list.querySelectorAll("button")) b.disabled = true;
          let result;
          try {
            result = await navigateFn(row.navTargetId);
          } catch (err) {
            list.textContent = `Switch failed: ${err.message || err}`;
            return;
          }
          close();
          onNavigated(result);
        });
      }
      list.appendChild(el);
    }
  }

  return { open, close, toggle: () => (isOpen ? close() : open()), isOpen: () => isOpen };
}
