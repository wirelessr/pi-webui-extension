/**
 * Mobile navigation — bottom tab bar to switch between views on small screens.
 * On desktop the three-column layout is always visible; this is a no-op.
 */

export function createMobileNav({ $app }) {
  const $nav = document.getElementById("mobile-nav");
  const buttons = $nav.querySelectorAll(".nav-btn");

  function isMobile() {
    return window.matchMedia("(max-width: 700px)").matches;
  }

  function switchView(view) {
    if (!isMobile()) return;

    $app.dataset.activeView = view;

    // Update panels
    document.querySelectorAll("[data-view]").forEach((el) => {
      el.classList.toggle("active", el.dataset.view === view);
    });

    // Update nav buttons
    buttons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.target === view);
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.target));
  });

  // On desktop, ensure all views are visible (remove .active toggling)
  function onResize() {
    if (!isMobile()) {
      document.querySelectorAll("[data-view]").forEach((el) => {
        el.classList.remove("active");
      });
    } else {
      switchView($app.dataset.activeView || "chat");
    }
  }

  window.addEventListener("resize", onResize);
  onResize();

  return { switchView, isMobile };
}
