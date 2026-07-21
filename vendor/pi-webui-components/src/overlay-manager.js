/**
 * Overlay manager — single owner of "which full-chat overlay is open".
 *
 * The chat area shows either the transcript (#messages) or exactly one
 * overlay (subagent view, file view, tree panel, model picker, ...). Views
 * used to hide #messages and close each other pairwise, which grows O(n²)
 * as views are added and leaks scroll-position handling into every view.
 *
 * Protocol: a view calls open(handle) before showing itself — the manager
 * closes whatever else is open (by calling its handle.close()), saves the
 * scroll position, and hides #messages. The view's close() must call
 * closed(handle) after hiding itself — the manager restores #messages and
 * the saved scroll position. closeAll() closes the current view, if any.
 *
 * @param {object} opts
 * @param {{scrollTop: number}} opts.$chat — scroll container
 * @param {{style: {display: string}}} opts.$messages — main transcript element
 */
export function createOverlayManager({ $chat, $messages }) {
  let current = null;
  let savedScrollTop = 0;

  return {
    /** A view is opening: close any other overlay, hide the transcript. */
    open(handle) {
      if (current === handle) return;
      if (current) current.close();
      savedScrollTop = $chat.scrollTop;
      current = handle;
      $messages.style.display = "none";
    },

    /** A view finished closing: restore the transcript + scroll position. */
    closed(handle) {
      if (current !== handle) return;
      current = null;
      $messages.style.display = "";
      $chat.scrollTop = savedScrollTop;
    },

    /** Close whatever overlay is open (session switch, history reload). */
    closeAll() {
      if (current) current.close();
    },

    getCurrent: () => current,
  };
}
