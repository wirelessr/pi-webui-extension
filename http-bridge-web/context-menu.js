/**
 * Context menu module — right-click menu on chat messages.
 *
 * Attaches a contextmenu listener to the messages container.
 * Shows a custom menu with actions depending on the message role.
 */

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
      copyItem.addEventListener("click", () => {
        navigator.clipboard.writeText(text);
        close();
      });
      $menu.appendChild(copyItem);
    }

    if ($menu.children.length === 0) return;

    // Position — keep within viewport
    $menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
    $menu.style.top = `${Math.min(e.clientY, window.innerHeight - 150)}px`;
    document.body.appendChild($menu);
  });

  return { close };
}
