/**
 * Model picker overlay — click a model to switch to it.
 *
 * A sibling of #messages inside #chat; hiding/restoring the transcript and
 * overlay exclusivity are the overlay manager's job (overlay-manager.js).
 * Bare /model and the commands sidebar open this; "/model <arg>" still
 * switches directly.
 */

/**
 * @param {object} opts
 * @param {HTMLElement} opts.$chat — scroll container (overlay parent)
 * @param {object} opts.overlays — overlay manager (createOverlayManager)
 * @param {function} opts.getModelsFn — () => Promise<{current, models}>
 * @param {function} opts.setModelFn — (provider, id) => Promise
 * @param {function} opts.onSwitched — (model) => void, after a successful switch
 */
export function createModelView({ $chat, overlays, getModelsFn, setModelFn, onSwitched }) {
  const $view = document.createElement("div");
  $view.className = "model-view";
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
    title.textContent = "Models";
    const closeBtn = document.createElement("button");
    closeBtn.className = "tree-view-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);
    header.appendChild(title);
    header.appendChild(closeBtn);
    $view.appendChild(header);

    const filter = document.createElement("input");
    filter.className = "model-view-filter";
    filter.type = "text";
    filter.placeholder = "Filter models…";
    $view.appendChild(filter);

    const list = document.createElement("div");
    list.className = "tree-view-list";
    $view.appendChild(list);

    $view.style.display = "";
    $chat.scrollTop = 0;

    let data;
    try {
      data = await getModelsFn();
    } catch (err) {
      list.textContent = `Failed to load models: ${err.message || err}`;
      return;
    }
    if (!isOpen) return; // closed while loading

    const current = data.current;
    const models = data.models || [];
    if (models.length === 0) {
      list.textContent = "No models with configured auth found.";
      return;
    }

    for (const m of models) {
      const isCurrent = current && m.provider === current.provider && m.id === current.id;
      const el = document.createElement("button");
      el.className = "tree-row model-row";
      if (isCurrent) el.classList.add("active");
      el.dataset.filterKey = `${m.provider}/${m.id}`.toLowerCase();

      const name = document.createElement("span");
      name.className = "tree-row-text";
      name.textContent = `${m.provider}/${m.id}`;
      el.appendChild(name);

      const metaParts = [];
      if (m.contextWindow) metaParts.push(`${Math.round(m.contextWindow / 1000)}k`);
      if (m.vision) metaParts.push("vision");
      if (m.reasoning) metaParts.push("reasoning");
      if (m.costInput != null && m.costOutput != null) metaParts.push(`$${m.costInput}/${m.costOutput}`);
      const meta = document.createElement("span");
      meta.className = "model-row-meta";
      meta.textContent = metaParts.join(" · ");
      el.appendChild(meta);

      if (isCurrent) {
        const marker = document.createElement("span");
        marker.className = "tree-row-marker";
        marker.textContent = " ● current";
        el.appendChild(marker);
        el.disabled = true;
      } else {
        el.addEventListener("click", async () => {
          for (const b of list.querySelectorAll("button")) b.disabled = true;
          try {
            await setModelFn(m.provider, m.id);
          } catch (err) {
            list.textContent = `Switch failed: ${err.message || err}`;
            return;
          }
          close();
          onSwitched(m);
        });
      }
      list.appendChild(el);
    }

    filter.addEventListener("input", () => {
      const q = filter.value.trim().toLowerCase();
      for (const el of list.querySelectorAll(".model-row")) {
        el.style.display = !q || el.dataset.filterKey.includes(q) ? "" : "none";
      }
    });
    filter.focus();
  }

  return { open, close, toggle: () => (isOpen ? close() : open()), isOpen: () => isOpen };
}
