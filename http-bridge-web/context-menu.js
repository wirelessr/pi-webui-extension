/**
 * Context menu module — right-click menu on chat messages.
 *
 * Attaches a contextmenu listener to the messages container.
 * Shows a custom menu with actions depending on the message role.
 */

import { clampMenuPosition, doCopy } from "./ui-behaviors.js";

export function createContextMenu({ $messages }) {
  let $menu = null;

  function close() {
    if ($menu) {
      $menu.remove();
      $menu = null;
    }
  }

  document.addEventListener("click", close);
  document.addEventListener("scroll", close, true);
  window.addEventListener("blur", close);

  $messages.addEventListener("contextmenu", (e) => {
    const msgEl = e.target.closest(".message");
    if (!msgEl) return;

    e.preventDefault();
    close();

    $menu = document.createElement("div");
    $menu.className = "context-menu";

    // Copy message text
    const text = msgEl.querySelector(".text")?.textContent ||
                 msgEl.textContent?.trim();
    if (text) {
      const copyItem = document.createElement("button");
      copyItem.className = "context-menu-item";
      copyItem.textContent = "Copy text";
      copyItem.addEventListener("click", async () => {
        close();
        await doCopy({
          text,
          writeTextFn: navigator.clipboard?.writeText?.bind(navigator.clipboard),
          execCommandFn: document.execCommand?.bind(document),
          createTextareaFn: () => {
            const ta = document.createElement("textarea");
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            return ta;
          },
          removeTextareaFn: (ta) => document.body.removeChild(ta),
        });
      });
      $menu.appendChild(copyItem);
    }

    if ($menu.children.length === 0) return;

    const pos = clampMenuPosition(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    $menu.style.left = `${pos.left}px`;
    $menu.style.top = `${pos.top}px`;
    document.body.appendChild($menu);
  });

  return { close };
}
