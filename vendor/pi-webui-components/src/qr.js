/**
 * QR code module — generates and displays QR codes in a modal overlay.
 * Uses qrcode-lib.js (Kazuhiko Arase's pure-JS QR generator, loaded via
 * non-module <script> tag in index.html, exposes global `qrcode`).
 */

export function createQrCode() {
  let $modal = null;

  function ensureModal() {
    if ($modal) return $modal;

    $modal = document.createElement("div");
    $modal.className = "qr-modal";
    $modal.innerHTML = `
      <div class="qr-modal-content">
        <div class="qr-modal-header">
          <span class="qr-modal-title">Scan to connect</span>
          <button class="qr-modal-close">&times;</button>
        </div>
        <div class="qr-canvas-wrapper"></div>
        <div class="qr-modal-url"></div>
      </div>
    `;

    $modal.addEventListener("click", (e) => {
      if (e.target === $modal || e.target.classList.contains("qr-modal-close")) {
        hide();
      }
    });

    document.body.appendChild($modal);
    return $modal;
  }

  function show(url) {
    const modal = ensureModal();
    const wrapper = modal.querySelector(".qr-canvas-wrapper");
    const urlEl = modal.querySelector(".qr-modal-url");

    wrapper.innerHTML = "";
    urlEl.textContent = url;

    try {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();

      const cellSize = 6;
      const margin = 0;
      const moduleCount = qr.getModuleCount();
      const size = (moduleCount + margin * 2) * cellSize;

      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, size, size);

      ctx.fillStyle = "#000";
      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          if (qr.isDark(row, col)) {
            ctx.fillRect(
              (col + margin) * cellSize,
              (row + margin) * cellSize,
              cellSize,
              cellSize
            );
          }
        }
      }

      wrapper.appendChild(canvas);
    } catch (err) {
      wrapper.innerHTML = `<div class="qr-error">QR generation failed: ${err.message}</div>`;
    }

    modal.classList.add("visible");
  }

  function hide() {
    if ($modal) $modal.classList.remove("visible");
  }

  return { show, hide };
}
