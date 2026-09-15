/*!
 * board bootstrap 1.0.0
 * A board includes this at its own choice — <script src="/libs/board-bootstrap-1.js"></script> —
 * to react to URL fragments (#<data-ba id>): the anchored element is scrolled
 * to frame center and outlined. The host app aims html-board comments this
 * way (docs/security.md "Sandbox architecture" — no host access into the
 * frame, so aiming happens inside). No network calls, no dependencies.
 * MIT — see LICENSE.txt.
 */
(function () {
  "use strict";

  var STYLE_ID = "board-bootstrap-style";
  // Solid outline matching the host app's --primary anchor aesthetic
  // (styles.css .anchor-target), light + dark.
  var STYLE =
    ".board-anchor-target{outline:2px solid #3b7dd8;outline-offset:3px;" +
    'border-radius:4px}@media (prefers-color-scheme:dark){' +
    ".board-anchor-target{outline-color:#fab283}}";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null) {
      return;
    }
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function aim() {
    var raw = location.hash.slice(1);
    if (raw.length === 0) {
      return;
    }
    var id;
    try {
      id = decodeURIComponent(raw);
    } catch (decodeError) {
      return;
    }
    var el;
    try {
      el = document.querySelector(
        '[data-ba="' + id.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]'
      );
    } catch (selectorError) {
      return;
    }
    if (el === null) {
      return;
    }
    ensureStyle();
    var previous = document.querySelector(".board-anchor-target");
    if (previous !== null) {
      previous.classList.remove("board-anchor-target");
    }
    el.classList.add("board-anchor-target");
    el.scrollIntoView({ block: "center" });
  }

  window.addEventListener("hashchange", aim);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", aim);
  } else {
    aim();
  }
})();
