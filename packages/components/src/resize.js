/**
 * Sidebar resize logic — pure functions for testable drag behavior.
 *
 * Design:
 * - Desktop only (disabled on mobile via matchMedia check)
 * - Width persisted to localStorage
 * - Clamped between min (160) and max (500)
 * - Handle sits between left sidebar and chat column
 */

export const MIN_SIDEBAR_W = 160;
export const MAX_SIDEBAR_W = 500;
export const STORAGE_KEY = "pi-webui-sidebar-w";

/**
 * Clamp sidebar width to valid range.
 * @param {number} w — proposed width
 * @returns {number} clamped width
 */
export function clampSidebarWidth(w) {
  if (typeof w !== "number" || Number.isNaN(w)) return 220;
  return Math.max(MIN_SIDEBAR_W, Math.min(MAX_SIDEBAR_W, w));
}

/**
 * Compute new sidebar width from mouse move delta.
 * @param {number} startX — mouse X at drag start
 * @param {number} startW — sidebar width at drag start
 * @param {number} currentX — current mouse X
 * @returns {number} clamped new width
 */
export function computeResizeWidth(startX, startW, currentX) {
  const delta = currentX - startX;
  return clampSidebarWidth(startW + delta);
}

/**
 * Load saved sidebar width from storage.
 * @param {function} getItem — injectable localStorage.getItem
 * @returns {number} saved width or default 220
 */
export function loadSidebarWidth(getItem) {
  const raw = getItem?.(STORAGE_KEY);
  if (raw == null) return 220;
  const w = Number(raw);
  return clampSidebarWidth(w);
}

/**
 * Save sidebar width to storage.
 * @param {number} w — width to save
 * @param {function} setItem — injectable localStorage.setItem
 */
export function saveSidebarWidth(w, setItem) {
  const clamped = clampSidebarWidth(w);
  setItem?.(STORAGE_KEY, String(clamped));
}

/**
 * Initialize sidebar resize behavior.
 * Desktop only — no-op on mobile (<= 700px).
 *
 * @param {object} opts
 * @param {HTMLElement} opts.$sidebar — the left sidebar element
 * @param {HTMLElement} opts.$handle — the resize handle element
 */
export function initResize({ $sidebar, $handle }) {
  if (!$sidebar || !$handle) return;

  function isMobile() {
    return window.matchMedia("(max-width: 700px)").matches;
  }

  // Restore saved width
  const savedW = loadSidebarWidth(localStorage.getItem.bind(localStorage));
  if (!isMobile()) {
    $sidebar.style.width = `${savedW}px`;
  }

  let dragging = false;
  let startX = 0;
  let startW = 0;

  $handle.addEventListener("mousedown", (e) => {
    if (isMobile()) return;
    dragging = true;
    startX = e.clientX;
    startW = $sidebar.offsetWidth;
    $handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const newW = computeResizeWidth(startX, startW, e.clientX);
    $sidebar.style.width = `${newW}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    $handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const finalW = clampSidebarWidth($sidebar.offsetWidth);
    saveSidebarWidth(finalW, localStorage.setItem.bind(localStorage));
  });

  // Touch support for tablets (not mobile phones)
  $handle.addEventListener("touchstart", (e) => {
    if (isMobile()) return;
    if (e.touches.length !== 1) return;
    dragging = true;
    startX = e.touches[0].clientX;
    startW = $sidebar.offsetWidth;
    $handle.classList.add("dragging");
    e.preventDefault();
  }, { passive: false });

  document.addEventListener("touchmove", (e) => {
    if (!dragging || e.touches.length !== 1) return;
    const newW = computeResizeWidth(startX, startW, e.touches[0].clientX);
    $sidebar.style.width = `${newW}px`;
  }, { passive: false });

  document.addEventListener("touchend", () => {
    if (!dragging) return;
    dragging = false;
    $handle.classList.remove("dragging");
    const finalW = clampSidebarWidth($sidebar.offsetWidth);
    saveSidebarWidth(finalW, localStorage.setItem.bind(localStorage));
  });

  // On resize to mobile, reset inline width so CSS takes over
  window.addEventListener("resize", () => {
    if (isMobile()) {
      $sidebar.style.width = "";
    } else {
      const w = loadSidebarWidth(localStorage.getItem.bind(localStorage));
      $sidebar.style.width = `${w}px`;
    }
  });
}
