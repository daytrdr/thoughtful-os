/* =========================================================================
 *  Design Review — Thoughtful Agency
 *  -----------------------------------------------------------------------
 *  An internal critique board. Frames (Figma exports, HTML screens, block
 *  boards) sit on a pannable, zoomable canvas. Anyone on the team drops
 *  numbered pins to start threads, edits copy in place, and flags threads
 *  for the agent, which reads and applies them over the GADGET binding.
 *
 *  Modes (keys):  V select · C comment · E edit
 *  Canvas:        wheel pans, ⌘/Ctrl+wheel zooms, drag empty space pans,
 *                 0 fits the board, 1 is 100%
 *  Threads:       ⌘/Ctrl+Z undo, ⇧⌘Z redo, Esc closes / deselects
 *
 *  Everything renders inside the Gadget sandbox: no network, no nested
 *  frames, images as data: URIs. HTML screens render into a shadow root so
 *  their styles stay scoped; the sanitizer strips scripts and external
 *  references before anything touches the DOM.
 * ========================================================================= */

/* ----------------------- Brand tokens ------------------------------------ */
const T = {
  brand:    "#191f76",
  brand2:   "#2d3491",
  brand3:   "#4a52b6",
  brandSoft:"#e9eaf7",
  ink:      "#0f1115",
  inkSoft:  "#5a5d63",
  inkFaint: "#9ca3af",
  paper:    "#F5F1E6",
  paper2:   "#F8F8F8",
  white:    "#ffffff",
  line:     "#e5e5e8",
  lineSoft: "#f0f0f2",
  canvas:   "#ece8dd",
  green:    "#264E36",
  danger:   "#b42318",
};
const SANS  = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const SERIF = '"Instrument Serif", Georgia, "Times New Roman", serif';
const EASE  = "cubic-bezier(0.23, 1, 0.32, 1)";
const PRESENCE_COLORS = ["#191f76", "#264E36", "#b42318", "#8a5a00", "#1f6f8b", "#6b2d8b", "#2d3491", "#a1522b"];

const MAX_IMAGE_DIM       = 1600;      // longest side after downscale
const IMAGE_DOWNSCALE_MIN = 400_000;   // bytes — below this keep the original
const MAX_SRC_CHARS       = 1_500_000; // data: URI budget per image (the server refuses 1.6M+)
const PRESENCE_TTL_MS     = 30_000;
const PING_INTERVAL_MS    = 15_000;
const FRAME_GAP           = 120;

const exportFormatId = globalThis.gadgetExportFormatId;
const isExport = ["html", "pdf", "png"].includes(exportFormatId);

/* ----------------------- DOM helpers ------------------------------------- */
function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === "style") Object.assign(e.style, v);
    else if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k === "data") Object.assign(e.dataset, v);
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of (children || [])) {
    if (c == null || c === false) continue;
    if (typeof c === "string" || typeof c === "number") e.appendChild(document.createTextNode(String(c)));
    else e.appendChild(c);
  }
  return e;
}
function svgIcon(path, size = 16, extra = {}) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", size); s.setAttribute("height", size);
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", extra.strokeWidth || "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  for (const d of (Array.isArray(path) ? path : [path])) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    s.appendChild(p);
  }
  return s;
}
const ICON = {
  cursor:   "M5 3l14 8-6 2-3 6z",
  comment:  "M21 12a8 8 0 0 1-8 8H8l-5 3 1.3-4.2A8 8 0 1 1 21 12z",
  pencil:   ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M13.5 6.5l3 3"],
  plus:     ["M12 5v14", "M5 12h14"],
  upload:   ["M12 16V4", "M7 9l5-5 5 5", "M4 20h16"],
  undo:     ["M9 14L4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-3"],
  redo:     ["M15 14l5-5-5-5", "M20 9H10a6 6 0 0 0 0 12h3"],
  zoomIn:   ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4", "M11 8v6", "M8 11h6"],
  zoomOut:  ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4", "M8 11h6"],
  fit:      ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"],
  check:    "M5 12l4 4L19 7",
  sparkle:  ["M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z", "M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"],
  trash:    ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  copy:     ["M9 9h10v10H9z", "M5 15V5h10"],
  x:        ["M6 6l12 12", "M18 6L6 18"],
  image:    ["M4 5h16v14H4z", "M4 15l5-5 4 4 3-3 4 4", "M15 9h.01"],
  screen:   ["M3 5h18v12H3z", "M8 21h8", "M12 17v4"],
  board:    ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  grip:     ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"],
  chevron:  "M9 6l6 6-6 6",
  reopen:   ["M4 12a8 8 0 1 0 3-6.2", "M4 4v5h5"],
  filter:   "M4 5h16l-6 8v6l-4-2v-4z",
  eye:      ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
};

/* ----------------------- Small utilities --------------------------------- */
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const hexA = (hex, a) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  if (s < 86400 * 7) return Math.round(s / 86400) + "d ago";
  return new Date(iso).toLocaleDateString();
}
function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer = null;
function toast(message, tone = "default") {
  let host = document.querySelector("[data-toast]");
  if (!host) { host = el("div", { "data-toast": "1", class: "dr-toast" }); document.body.appendChild(host); }
  host.textContent = message;
  host.dataset.tone = tone;
  host.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove("show"), 2600);
}

/* ----------------------- Identity ---------------------------------------- */
const clientId = crypto.randomUUID().slice(0, 12);
// The workshop shell injects `gadgetViewer = { id, name }` for the signed-in teammate. It is a
// display label only (never authority); without it we fall back to a guest handle.
// The shell posts it right after the iframe handshake and resolves `gadgetViewerReady`; older shells
// post nothing, so boot waits briefly and then falls back to a guest handle.
let me = identityFor(null);
function identityFor(raw) {
  const v = (raw && typeof raw === "object") ? { id: raw.id ?? null, name: String(raw.name || "").trim() } : { id: null, name: "" };
  return {
    id: v.id,
    name: v.name || ("Guest " + clientId.slice(0, 4).toUpperCase()),
    color: PRESENCE_COLORS[hashString(String(v.id || v.name || clientId)) % PRESENCE_COLORS.length],
  };
}
async function resolveIdentity() {
  const ready = globalThis.gadgetViewerReady;
  if (ready && typeof ready.then === "function") {
    await Promise.race([ready, new Promise(r => setTimeout(r, 2000))]);
  }
  me = identityFor(globalThis.gadgetViewer);
}
// The shell may learn the viewer's name after we booted (its user lookup races the UI bundle).
// Adopt it for everything from now on and tell the room, so cursors and later joins show the name.
window.addEventListener("gadgetviewer", e => {
  if (!e.detail) return;
  const next = identityFor(e.detail);
  if (next.id === me.id && next.name === me.name) return;
  me = next;
  if (R.avatars) renderAvatars();
  if (subscription) {
    try { gadget.updatePresence({ clientId, name: me.name, color: me.color, rename: true }); } catch {}
  }
});

/* ----------------------- App state --------------------------------------- */
let board = { meta: { title: "Design Review" }, frames: [], comments: [] };
let mode = "select";                 // select | comment | edit
let selectedFrameId = null;
let selectedCommentId = null;
let selectedBlockId = null;
let threadFilter = "open";           // open | all
let threadScope = "all";             // all | frame
let zoom = 1;
let pan = { x: 80, y: 80 };
let canUndo = false, canRedo = false;
let composer = null;                 // { frameId, x, y, node }
let presence = new Map();            // clientId -> { name, color, frameId, x, y, at, mode }
let subscription = null;             // { token }
let pendingHtmlSaves = new Map();    // frameId -> timeout
const frameNodes = new Map();        // frameId -> { root, content, pins, cursors, renderedVersion, renderedMode }
const R = {};                        // shell refs

const frameById = id => board.frames.find(f => f.id === id) || null;
const commentById = id => board.comments.find(c => c.id === id) || null;
const commentsFor = frameId => board.comments.filter(c => c.frameId === frameId);

/* ----------------------- Styles ------------------------------------------ */
const STYLE = `
  :root { --brand:${T.brand}; --brand2:${T.brand2}; --brand3:${T.brand3}; --brand-soft:${T.brandSoft};
    --ink:${T.ink}; --ink-soft:${T.inkSoft}; --ink-faint:${T.inkFaint}; --paper:${T.paper}; --paper2:${T.paper2};
    --line:${T.line}; --line-soft:${T.lineSoft}; --white:${T.white}; --canvas:${T.canvas}; --ease:${EASE}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { font-family: ${SANS}; color: var(--ink); background: var(--canvas); font-size: 14px;
    line-height: 1.45; letter-spacing: -0.01em; -webkit-font-smoothing: antialiased; overflow: hidden; }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  input, textarea, select { font: inherit; color: inherit; }
  .dr-app { position: fixed; inset: 0; display: grid; grid-template-rows: 56px 1fr; grid-template-columns: 240px 1fr 320px; }
  .dr-app.hide-left { grid-template-columns: 0 1fr 320px; }
  .dr-app.hide-right { grid-template-columns: 240px 1fr 0; }
  .dr-app.hide-left.hide-right { grid-template-columns: 0 1fr 0; }

  /* Header */
  .dr-header { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 0 16px;
    background: var(--white); border-bottom: 1px solid var(--line); z-index: 20; container-type: inline-size; overflow: hidden; }
  .dr-header > * { flex: none; }
  @container (max-width: 1360px) { .dr-seg button .label { display: none; } .dr-seg button kbd { display: none; } .dr-seg button { padding: 7px 10px; } }
  @container (max-width: 1180px) { .dr-wordmark { display: none; } .dr-round { display: none; } }
  @container (max-width: 1020px) { .dr-zoom-group { display: none; } }
  .dr-wordmark { display: inline-flex; align-items: baseline; gap: 5px; font-weight: 600; letter-spacing: -0.03em;
    font-size: 17px; color: var(--ink); white-space: nowrap; }
  .dr-wordmark i { display: inline-block; width: 6px; height: 6px; border-radius: 999px; background: var(--brand); }
  .dr-title { font-family: ${SERIF}; font-size: 22px; letter-spacing: -0.02em; border: 0; background: transparent;
    padding: 4px 8px; border-radius: 10px; flex: 0 1 260px !important; min-width: 110px; max-width: 360px; outline: none; color: var(--ink); }
  .dr-title:hover, .dr-title:focus { background: var(--paper2); }
  .dr-round { font-size: 12px; color: var(--ink-soft); border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; background: var(--paper2); width: 110px; outline: none; }
  .dr-round:focus { border-color: var(--brand3); color: var(--ink); }
  .dr-spacer { flex: 1 1 0 !important; min-width: 0; }
  .dr-seg { display: inline-flex; background: var(--paper2); border: 1px solid var(--line); border-radius: 999px; padding: 3px; gap: 2px; }
  .dr-seg button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; font-size: 13px;
    font-weight: 500; color: var(--ink-soft); transition: background .2s var(--ease), color .2s var(--ease); }
  .dr-seg button:hover { color: var(--ink); }
  .dr-seg button.active { background: var(--brand); color: var(--white); }
  .dr-seg button kbd { font: 600 10px/1 ${SANS}; opacity: .6; padding: 2px 4px; border-radius: 4px; background: rgba(0,0,0,.08); }
  .dr-seg button.active kbd { background: rgba(255,255,255,.2); opacity: .9; }
  .dr-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 999px;
    color: var(--ink-soft); transition: background .2s var(--ease), color .2s var(--ease), transform .15s var(--ease); }
  .dr-iconbtn:hover { background: var(--paper2); color: var(--ink); }
  .dr-iconbtn:active { transform: scale(.94); }
  .dr-iconbtn[disabled] { opacity: .35; pointer-events: none; }
  .dr-iconbtn.active { background: var(--brand-soft); color: var(--brand); }
  .dr-pill { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 500;
    background: var(--brand); color: var(--white); transition: background .2s var(--ease), transform .15s var(--ease); white-space: nowrap; }
  .dr-pill:hover { background: var(--brand2); }
  .dr-pill:active { transform: scale(.97); }
  .dr-pill.secondary { background: var(--white); color: var(--ink); border: 1px solid var(--line); }
  .dr-pill.secondary:hover { background: var(--paper2); }
  .dr-pill.ghost { background: transparent; color: var(--ink-soft); }
  .dr-pill.ghost:hover { background: var(--paper2); color: var(--ink); }
  .dr-pill.danger { background: var(--white); color: ${T.danger}; border: 1px solid var(--line); }
  .dr-pill[disabled] { opacity: .45; pointer-events: none; }
  .dr-zoom { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--ink-soft); min-width: 44px; text-align: center; }
  .dr-avatars { display: inline-flex; align-items: center; }
  .dr-avatar { width: 28px; height: 28px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 600; color: var(--white); border: 2px solid var(--white); margin-left: -8px; letter-spacing: 0; }
  .dr-avatar:first-child { margin-left: 0; }
  .dr-menu { position: absolute; top: 48px; right: 0; background: var(--white); border: 1px solid var(--line); border-radius: 16px;
    padding: 6px; min-width: 220px; box-shadow: 0 18px 40px rgba(15,17,21,.12); z-index: 50; }
  .dr-menu button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border-radius: 10px; font-size: 13px; text-align: left; }
  .dr-menu button:hover { background: var(--paper2); }
  .dr-menu button span { color: var(--ink-soft); font-size: 12px; margin-left: auto; }

  /* Side panels */
  .dr-left, .dr-right { background: var(--white); overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
  .dr-left { border-right: 1px solid var(--line); }
  .dr-right { border-left: 1px solid var(--line); }
  .dr-panel-head { display: flex; align-items: center; gap: 8px; padding: 14px 14px 10px; font-size: 11px; font-weight: 600;
    letter-spacing: .08em; text-transform: uppercase; color: var(--ink-soft); }
  .dr-panel-head .dr-spacer { flex: 1; }
  .dr-scroll { overflow: auto; flex: 1; min-height: 0; padding: 0 10px 20px; }
  .dr-frame-row { display: flex; align-items: center; gap: 10px; padding: 8px 8px; border-radius: 12px; cursor: pointer; margin-bottom: 2px;
    border: 1px solid transparent; transition: background .15s var(--ease); }
  .dr-frame-row:hover { background: var(--paper2); }
  .dr-frame-row.selected { background: var(--brand-soft); border-color: transparent; }
  .dr-frame-row .idx { width: 18px; font-size: 11px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .dr-frame-row .thumb { width: 40px; height: 28px; border-radius: 6px; border: 1px solid var(--line); background: var(--paper2);
    display: flex; align-items: center; justify-content: center; color: var(--ink-soft); flex: none; overflow: hidden; }
  .dr-frame-row .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .dr-frame-row .meta { min-width: 0; flex: 1; }
  .dr-frame-row .name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dr-frame-row .sub { font-size: 11px; color: var(--ink-soft); }
  .dr-frame-row .count { font-size: 11px; font-weight: 600; color: var(--white); background: var(--brand); border-radius: 999px; padding: 2px 7px; }
  .dr-frame-row .count.zero { background: var(--line); color: var(--ink-soft); }
  .dr-frame-row.drop-before { box-shadow: 0 -2px 0 0 var(--brand); }
  .dr-frame-row.drop-after { box-shadow: 0 2px 0 0 var(--brand); }
  .dr-empty { padding: 24px 12px; color: var(--ink-soft); font-size: 13px; text-align: center; line-height: 1.5; }
  .dr-empty b { display: block; font-family: ${SERIF}; font-weight: 400; font-size: 20px; color: var(--ink); margin-bottom: 6px; letter-spacing: -0.02em; }

  /* Inspector */
  .dr-inspector { border-bottom: 1px solid var(--line); padding: 0 14px 12px; }
  .dr-field { display: grid; grid-template-columns: 76px 1fr; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; color: var(--ink-soft); }
  .dr-field.stacked { grid-template-columns: 1fr; }
  .dr-input { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 7px 10px; font-size: 13px; background: var(--white); outline: none; color: var(--ink); }
  .dr-input:focus { border-color: var(--brand3); box-shadow: 0 0 0 3px var(--brand-soft); }
  textarea.dr-input { resize: vertical; min-height: 64px; line-height: 1.45; }
  .dr-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .dr-color { width: 34px; height: 30px; border: 1px solid var(--line); border-radius: 8px; padding: 2px; background: var(--white); }

  /* Threads */
  .dr-tabs { display: inline-flex; gap: 2px; background: var(--paper2); border-radius: 999px; padding: 2px; }
  .dr-tabs button { padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--ink-soft); text-transform: none; letter-spacing: 0; }
  .dr-tabs button.active { background: var(--white); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  .dr-thread { border: 1px solid var(--line); border-radius: 16px; padding: 12px 12px 10px; margin: 0 4px 8px; background: var(--white);
    cursor: pointer; transition: border-color .15s var(--ease), box-shadow .15s var(--ease); }
  .dr-thread:hover { border-color: var(--brand3); }
  .dr-thread.selected { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
  .dr-thread.resolved { opacity: .72; }
  .dr-thread .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .dr-num { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px;
    background: var(--brand); color: var(--white); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .dr-num.resolved { background: var(--ink-faint); }
  .dr-thread .who { font-size: 12px; font-weight: 600; }
  .dr-thread .when { font-size: 11px; color: var(--ink-faint); margin-left: auto; white-space: nowrap; }
  .dr-thread .body { font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .dr-thread .frame-tag { font-size: 11px; color: var(--ink-soft); margin-top: 6px; display: flex; gap: 6px; align-items: center; }
  .dr-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: var(--brand-soft); color: var(--brand); letter-spacing: .02em; }
  .dr-badge.done { background: #e6f0ea; color: ${T.green}; }
  .dr-replies { margin-top: 10px; border-top: 1px solid var(--line-soft); padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
  .dr-reply { font-size: 13px; line-height: 1.45; }
  .dr-reply b { font-size: 12px; margin-right: 6px; }
  .dr-reply .when { font-size: 11px; color: var(--ink-faint); margin-left: 6px; }
  .dr-thread-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .dr-thread-actions .dr-pill { padding: 6px 11px; font-size: 12px; }
  .dr-reply-box { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }

  /* Canvas */
  .dr-canvas { position: relative; overflow: hidden; background: var(--canvas);
    background-image: radial-gradient(${hexA(T.ink, 0.10)} 1px, transparent 1px); background-size: 24px 24px; cursor: default; touch-action: none; }
  .dr-canvas.mode-comment { cursor: crosshair; }
  .dr-canvas.panning { cursor: grabbing; }
  .dr-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
  .dr-frame { position: absolute; }
  .dr-frame-label { position: absolute; left: 0; bottom: 100%; margin-bottom: 6px; display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--ink-soft); white-space: nowrap; cursor: grab; user-select: none; padding: 2px 6px; border-radius: 8px;
    transform: scale(var(--inv, 1)); transform-origin: left bottom; }
  .dr-frame-label:hover { background: rgba(255,255,255,.7); color: var(--ink); }
  .dr-frame-label .k { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); }
  .dr-frame.selected .dr-frame-label { color: var(--brand); }
  .dr-frame-body { position: absolute; inset: 0; background: var(--white); border-radius: 4px; overflow: hidden;
    box-shadow: 0 1px 2px rgba(15,17,21,.06), 0 12px 32px rgba(15,17,21,.08); outline: 1px solid ${hexA(T.ink, 0.06)}; }
  .dr-frame.selected .dr-frame-body { outline: 2px solid var(--brand); }
  .dr-frame-content { position: absolute; inset: 0; }
  .dr-frame-content img { display: block; width: 100%; height: 100%; object-fit: contain; background: var(--white); }
  .dr-frame-content.noninteractive { pointer-events: none; }
  .dr-frame-content.editing { outline: 2px dashed ${hexA(T.brand, 0.5)}; outline-offset: -2px; }
  .dr-catcher { position: absolute; inset: 0; cursor: crosshair; }
  .dr-pins { position: absolute; inset: 0; pointer-events: none; }
  .dr-pin { position: absolute; width: 28px; height: 28px; margin: -28px 0 0 -3px; pointer-events: auto; cursor: pointer;
    border-radius: 999px 999px 999px 4px; background: var(--brand); color: var(--white); display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; box-shadow: 0 2px 6px rgba(15,17,21,.25); border: 2px solid var(--white); transition: transform .15s var(--ease);
    transform: scale(var(--inv, 1)); transform-origin: 3px 28px; }
  .dr-pin:hover { transform: scale(calc(var(--inv, 1) * 1.1)); }
  .dr-pin.selected { transform: scale(calc(var(--inv, 1) * 1.18)); box-shadow: 0 0 0 4px var(--brand-soft), 0 2px 6px rgba(15,17,21,.25); }
  .dr-pin.resolved { background: var(--white); color: var(--ink-soft); border-color: var(--ink-faint); }
  .dr-pin.ask { box-shadow: 0 0 0 3px ${hexA(T.brand, 0.25)}; }
  .dr-pin.provisional { background: var(--brand3); animation: dr-fade .2s var(--ease); }
  .dr-pin.dragging { cursor: grabbing; }
  @keyframes dr-pop { from { transform: scale(.4); } to { transform: scale(1); } }
  @keyframes dr-fade { from { opacity: 0; } to { opacity: 1; } }
  .dr-cursors { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  .dr-overflow { position: absolute; left: 0; right: 0; bottom: 0; height: calc(88px * var(--inv, 1)); display: none; align-items: flex-end;
    justify-content: center; padding-bottom: calc(12px * var(--inv, 1)); pointer-events: none;
    background: linear-gradient(rgba(255,255,255,0), rgba(255,255,255,.94) 70%); }
  .dr-frame.overflowing .dr-overflow { display: flex; }
  .dr-overflow .dr-pill { pointer-events: auto; transform: scale(var(--inv, 1)); transform-origin: center bottom; box-shadow: 0 2px 10px rgba(15,17,21,.12); }
  .dr-cursor { position: absolute; transform: translate(-2px, -2px) scale(var(--inv, 1)); transform-origin: 2px 2px; transition: left .12s linear, top .12s linear; }
  .dr-cursor .tag { position: absolute; left: 14px; top: 12px; font-size: 11px; font-weight: 600; color: var(--white); padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
  .dr-composer { position: absolute; z-index: 30; width: 300px; background: var(--white); border: 1px solid var(--line); border-radius: 18px;
    padding: 12px; box-shadow: 0 18px 48px rgba(15,17,21,.16); animation: dr-pop .18s var(--ease); }
  .dr-composer textarea { min-height: 76px; }
  .dr-composer .foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .dr-composer label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-soft); cursor: pointer; }
  .dr-hint { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); background: rgba(15,17,21,.86); color: var(--white);
    font-size: 12px; padding: 7px 14px; border-radius: 999px; pointer-events: none; z-index: 25; backdrop-filter: blur(6px); }
  .dr-hint kbd { font: 600 10px/1 ${SANS}; padding: 2px 5px; border-radius: 4px; background: rgba(255,255,255,.18); margin: 0 2px; }
  .dr-toast { position: fixed; left: 50%; bottom: 52px; transform: translate(-50%, 12px); background: var(--ink); color: var(--white); font-size: 13px;
    padding: 9px 16px; border-radius: 999px; opacity: 0; pointer-events: none; transition: opacity .2s var(--ease), transform .2s var(--ease); z-index: 100; }
  .dr-toast.show { opacity: 1; transform: translate(-50%, 0); }
  .dr-toast[data-tone="error"] { background: ${T.danger}; }
  .dr-drop { position: absolute; inset: 12px; border: 2px dashed var(--brand); border-radius: 20px; background: ${hexA(T.brand, 0.06)};
    display: none; align-items: center; justify-content: center; font-family: ${SERIF}; font-size: 26px; color: var(--brand); z-index: 40; pointer-events: none; }
  .dr-canvas.dropping .dr-drop { display: flex; }

  /* Board blocks */
  .dr-block { position: absolute; }
  .dr-block.editable { cursor: move; }
  .dr-block.editable:hover { outline: 1px dashed ${hexA(T.brand, 0.5)}; }
  .dr-block.selected { outline: 2px solid var(--brand) !important; }
  .dr-block [data-inline] { outline: none; }
  .dr-handle { position: absolute; right: -6px; bottom: -6px; width: 12px; height: 12px; background: var(--white); border: 2px solid var(--brand); border-radius: 3px; cursor: nwse-resize; z-index: 5; }
  .dr-guide { position: absolute; background: var(--brand); opacity: .9; pointer-events: none; }
  .dr-blockbar { display: flex; gap: 4px; flex-wrap: wrap; padding: 0 14px 10px; }
  .dr-blockbar button { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--white); }
  .dr-blockbar button:hover { background: var(--paper2); }

  /* Export */
  .dr-export { padding: 48px; background: var(--white); font-family: ${SANS}; color: var(--ink); }
  .dr-export h1 { font-family: ${SERIF}; font-weight: 400; font-size: 40px; letter-spacing: -0.02em; margin: 0 0 6px; }
  .dr-export .sub { color: var(--ink-soft); margin-bottom: 40px; }
  .dr-export .fr { margin-bottom: 56px; page-break-inside: avoid; }
  .dr-export .fr h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: var(--ink-soft); }
  .dr-export .stage { position: relative; display: inline-block; border: 1px solid var(--line); }
  .dr-export ol { margin: 14px 0 0; padding-left: 20px; font-size: 13px; line-height: 1.5; }
  .dr-export ol li { margin-bottom: 4px; }
  .dr-export .pin { position: absolute; width: 24px; height: 24px; margin: -24px 0 0 -2px; border-radius: 999px 999px 999px 4px; background: var(--brand); color: var(--white); font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 2px solid var(--white); }
  .dr-export .pin.resolved { background: var(--ink-faint); }
  @media print { .dr-export { padding: 0; } }
`;

/* ======================= HTML screen sanitizer ============================ */

/* A screen is a self-contained HTML document authored by the agent (or pasted in). We parse it,
 * drop anything that executes or reaches outside the sandbox, and render the remainder into a
 * shadow root so its styles cannot leak into the board chrome (or vice versa). `body`/`html`
 * selectors are rewritten to `.screen-root`, the wrapper that stands in for the document body. */
function safeUrl(value, attr) {
  const v = String(value || "").trim();
  if (!v) return true;
  if (v.startsWith("#")) return true;
  if (/^data:image\//i.test(v)) return attr !== "href" && attr !== "action" && attr !== "formaction";
  if (/^data:font\//i.test(v)) return false;
  return false;
}
function scopeCss(css) {
  return String(css || "")
    .replace(/@import[^;]*;/gi, "")
    .replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\1\s*\)/gi, "none")
    .replace(/(^|[\s,}])(html|body)(?=[\s,{.:#[>+~])/gi, "$1.screen-root");
}
function sanitizeScreen(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  doc.querySelectorAll("script, iframe, frame, frameset, object, embed, link, meta, base, noscript, template, applet, audio, video, source, track")
    .forEach(n => n.remove());
  doc.querySelectorAll("*").forEach(n => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value;
      if (name.startsWith("on") || name === "srcset" || name === "ping") n.removeAttribute(attr.name);
      else if (["src", "href", "xlink:href", "poster", "action", "formaction", "background", "data"].includes(name) && !safeUrl(val, name)) {
        n.removeAttribute(attr.name);
      } else if (name === "style" && /url\s*\(/i.test(val)) {
        n.setAttribute("style", scopeCss(val));
      }
    }
    if (n.tagName === "A" && !n.getAttribute("href")) n.setAttribute("href", "#");
  });
  const styles = [...doc.querySelectorAll("style")].map(s => scopeCss(s.textContent));
  doc.querySelectorAll("style").forEach(s => s.remove());
  return { styles, bodyHtml: doc.body ? doc.body.innerHTML : "", bodyStyle: doc.body?.getAttribute("style") || "" };
}
/* Interactive rendering uses a shadow root so a screen's styles cannot reach the board chrome.
 * Exports render into light DOM instead (the platform's static HTML export serializes
 * `outerHTML`, which drops shadow roots) and isolate the styles with `@scope` on the host id;
 * that keeps the exported file readable in current Chrome, Safari 17.4+ and Firefox 128+. */
function renderScreen(frame, host, { light = false } = {}) {
  const { styles, bodyHtml, bodyStyle } = sanitizeScreen(frame.html);
  const rootCss = `.screen-root{position:relative;width:${frame.width}px;min-height:${frame.height}px;margin:0;overflow:hidden;font-family:${SANS};color:${T.ink}}` +
    `.screen-root[contenteditable]{outline:none;cursor:text}` +
    `.screen-root *{max-width:100%}`;
  let container, wrapCss;
  if (light) {
    host.innerHTML = "";
    host.id = "dr-screen-" + frame.id;
    host.style.cssText = "display:block;width:100%;height:100%;overflow:hidden;background:#fff";
    container = host;
    wrapCss = css => `@scope (#${host.id}) {\n${css}\n}`;
  } else {
    container = host.shadowRoot || host.attachShadow({ mode: "open" });
    container.innerHTML = "";
    wrapCss = css => css;
  }
  const base = document.createElement("style");
  base.textContent = wrapCss((light ? "" : `:host{display:block;width:100%;height:100%;overflow:hidden;background:#fff}`) + rootCss);
  container.appendChild(base);
  for (const css of styles) { const st = document.createElement("style"); st.textContent = wrapCss(css); container.appendChild(st); }
  const root = document.createElement("div");
  root.className = "screen-root";
  if (bodyStyle) root.setAttribute("style", scopeCss(bodyStyle));
  root.innerHTML = bodyHtml;
  container.appendChild(root);
  return root;
}
function serializeScreen(host) {
  const shadow = host.shadowRoot;
  if (!shadow) return "";
  const styles = [...shadow.querySelectorAll("style")].slice(1).map(s => `<style>${s.textContent}</style>`).join("\n");
  const root = shadow.querySelector(".screen-root");
  const bodyStyle = root?.getAttribute("style") ? ` style="${escapeHtml(root.getAttribute("style"))}"` : "";
  return `<!doctype html>\n<html><head><meta charset="utf-8">\n${styles}\n</head><body${bodyStyle}>\n${root ? root.innerHTML : ""}\n</body></html>`;
}

/* ======================= Board block components =========================== */

const COMPONENTS = {
  heading: {
    name: "Heading", icon: "screen", w: 520, h: 64,
    props: { text: "Headline that names the outcome", size: 40, color: T.ink, align: "left", serif: true },
    render(frame, b, ctx) {
      const p = b.props;
      const e = el("div", { style: {
        fontFamily: p.serif === false ? SANS : SERIF, fontSize: (p.size || 40) + "px", lineHeight: "1.05",
        letterSpacing: "-0.03em", color: p.color || T.ink, textAlign: p.align || "left", whiteSpace: "pre-wrap",
        width: "100%", height: "100%", overflow: "hidden", fontWeight: "400" } });
      return ctx.inline(e, "text");
    },
  },
  text: {
    name: "Text", icon: "screen", w: 420, h: 72,
    props: { text: "Body copy. Keep it to the point.", size: 16, color: T.inkSoft, align: "left", weight: 400 },
    render(frame, b, ctx) {
      const p = b.props;
      const e = el("div", { style: {
        fontFamily: SANS, fontSize: (p.size || 16) + "px", lineHeight: "1.5", color: p.color || T.inkSoft,
        textAlign: p.align || "left", fontWeight: String(p.weight || 400), whiteSpace: "pre-wrap",
        width: "100%", height: "100%", overflow: "hidden" } });
      return ctx.inline(e, "text");
    },
  },
  rect: {
    name: "Rectangle", icon: "board", w: 320, h: 200,
    props: { fill: T.white, radius: 16, stroke: T.line },
    render(frame, b) {
      const p = b.props;
      return el("div", { style: {
        width: "100%", height: "100%", background: p.fill || "transparent",
        borderRadius: (p.radius ?? 16) + "px", border: p.stroke ? `1px solid ${p.stroke}` : "none" } });
    },
  },
  image: {
    name: "Image", icon: "image", w: 360, h: 240,
    props: { src: "", fit: "cover" },
    render(frame, b) {
      const p = b.props;
      if (!p.src) {
        return el("div", { style: { width: "100%", height: "100%", background: T.paper2, border: `1px dashed ${T.line}`,
          borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", color: T.inkFaint, fontSize: "12px" } },
          ["Image"]);
      }
      return el("img", { src: p.src, draggable: "false", style: { width: "100%", height: "100%", objectFit: p.fit || "cover", borderRadius: (p.radius ?? 0) + "px", display: "block" } });
    },
  },
  button: {
    name: "Button", icon: "board", w: 180, h: 48,
    props: { text: "Get started", fill: T.brand, color: T.white, radius: 999, size: 14 },
    render(frame, b, ctx) {
      const p = b.props;
      const e = el("div", { style: {
        width: "100%", height: "100%", background: p.fill || T.brand, color: p.color || T.white,
        borderRadius: (p.radius ?? 999) + "px", display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: SANS, fontSize: (p.size || 14) + "px", fontWeight: "500", letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden" } });
      return ctx.inline(e, "text");
    },
  },
  note: {
    name: "Sticky note", icon: "comment", w: 240, h: 140,
    props: { text: "Note to the team", color: T.ink },
    render(frame, b, ctx) {
      const p = b.props;
      const e = el("div", { style: {
        width: "100%", height: "100%", background: "#fff4c2", color: p.color || T.ink, padding: "14px 16px",
        fontFamily: SANS, fontSize: "14px", lineHeight: "1.45", whiteSpace: "pre-wrap", overflow: "hidden",
        boxShadow: "0 6px 16px rgba(15,17,21,.12)", transform: "rotate(-1deg)" } });
      return ctx.inline(e, "text");
    },
  },
};
const PALETTE_ORDER = ["heading", "text", "rect", "button", "image", "note"];

/* Inline text: in edit mode with the block selected, the text becomes contentEditable; blur saves. */
function bindInline(elem, frame, block, propKey) {
  const raw = (block.props || {})[propKey] ?? "";
  const editable = mode === "edit" && block.id === selectedBlockId;
  elem.setAttribute("data-inline", propKey);
  if (editable) {
    elem.setAttribute("contenteditable", "plaintext-only");
    elem.spellcheck = false;
    elem.textContent = raw;
    elem.style.cursor = "text";
    elem.addEventListener("pointerdown", e => e.stopPropagation());
    elem.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); elem.blur(); }
    });
    elem.addEventListener("blur", async () => {
      const v = (elem.innerText ?? elem.textContent ?? "").replace(/ /g, " ");
      if (v === raw) return;
      block.props = { ...(block.props || {}), [propKey]: v };
      await saveBlock(frame, block, { props: { [propKey]: v } });
    });
  } else {
    elem.textContent = raw;
  }
  return elem;
}

async function saveBlock(frame, block, patch) {
  try {
    await gadget.updateBlock(frame.id, block.id, patch);
  } catch (e) { toast("Could not save the block.", "error"); }
}

const SNAP_THRESHOLD = 6;
function snapTargets(frame, dragging) {
  const verts = [0, frame.width / 2, frame.width];
  const horiz = [0, frame.height / 2, frame.height];
  for (const b of frame.blocks || []) {
    if (b.id === dragging.id) continue;
    verts.push(b.x, b.x + b.w, b.x + b.w / 2);
    horiz.push(b.y, b.y + b.h, b.y + b.h / 2);
  }
  return { verts, horiz };
}
function applySnap(nx, ny, bw, bh, targets) {
  const pick = (cands, list) => {
    let best = null;
    for (const c of cands) for (const t of list) {
      const d = Math.abs(t - c.pos);
      if (d <= SNAP_THRESHOLD && (!best || d < best.d)) best = { d, v: t + c.offset, guide: t };
    }
    return best;
  };
  const bx = pick([{ pos: nx, offset: 0 }, { pos: nx + bw / 2, offset: -bw / 2 }, { pos: nx + bw, offset: -bw }], targets.verts);
  const by = pick([{ pos: ny, offset: 0 }, { pos: ny + bh / 2, offset: -bh / 2 }, { pos: ny + bh, offset: -bh }], targets.horiz);
  return { x: bx ? Math.round(bx.v) : nx, y: by ? Math.round(by.v) : ny, gv: bx ? [bx.guide] : [], gh: by ? [by.guide] : [] };
}
function drawGuides(content, frame, xs, ys) {
  clearGuides(content);
  const layer = el("div", { "data-guides": "1", style: { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "50" } });
  for (const x of xs) layer.appendChild(el("div", { class: "dr-guide", style: { left: x + "px", top: "0", width: "1px", height: frame.height + "px" } }));
  for (const y of ys) layer.appendChild(el("div", { class: "dr-guide", style: { top: y + "px", left: "0", height: "1px", width: frame.width + "px" } }));
  content.appendChild(layer);
}
function clearGuides(content) { content.querySelector("[data-guides]")?.remove(); }

function attachBlockInteractions(wrap, frame, block, content) {
  wrap.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.isContentEditable) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const origX = block.x, origY = block.y;
    const targets = snapTargets(frame, block);
    const wasSelected = block.id === selectedBlockId;
    let dragged = false;
    const onMove = ev => {
      const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
      if (!dragged && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragged = true;
      if (!dragged) return;
      let nx = Math.round(origX + dx), ny = Math.round(origY + dy);
      let gv = [], gh = [];
      if (!ev.altKey) { const s = applySnap(nx, ny, block.w, block.h, targets); nx = s.x; ny = s.y; gv = s.gv; gh = s.gh; }
      drawGuides(content, frame, gv, gh);
      wrap.style.left = nx + "px"; wrap.style.top = ny + "px";
      block.x = nx; block.y = ny;
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      clearGuides(content);
      if (dragged) {
        await saveBlock(frame, block, { x: block.x, y: block.y });
        if (!wasSelected) selectBlock(frame.id, block.id);
      } else if (!wasSelected) {
        selectBlock(frame.id, block.id);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}
function addResizeHandle(wrap, frame, block) {
  const h = el("div", { class: "dr-handle" });
  h.addEventListener("pointerdown", e => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY, ow = block.w, oh = block.h;
    const onMove = ev => {
      block.w = Math.max(8, Math.round(ow + (ev.clientX - startX) / zoom));
      block.h = Math.max(8, Math.round(oh + (ev.clientY - startY) / zoom));
      wrap.style.width = block.w + "px"; wrap.style.height = block.h + "px";
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      await saveBlock(frame, block, { w: block.w, h: block.h });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  wrap.appendChild(h);
}
function renderBoard(frame, content) {
  content.innerHTML = "";
  content.style.background = T.white;
  const editing = mode === "edit";
  for (const b of frame.blocks || []) {
    const def = COMPONENTS[b.type] || COMPONENTS.text;
    const ctx = { inline: (elem, key) => bindInline(elem, frame, b, key) };
    const wrap = el("div", { class: "dr-block" + (editing ? " editable" : "") + (b.id === selectedBlockId ? " selected" : ""),
      "data-block-id": b.id,
      style: { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px" } });
    wrap.appendChild(def.render(frame, b, ctx));
    if (editing) {
      attachBlockInteractions(wrap, frame, b, content);
      if (b.id === selectedBlockId) addResizeHandle(wrap, frame, b);
    }
    content.appendChild(wrap);
  }
  if (!content.dataset.boardBound) {
    content.dataset.boardBound = "1";
    content.addEventListener("pointerdown", e => {
      if (mode === "edit" && e.target === content && selectedBlockId) {
        selectedBlockId = null;
        const f = frameById(frame.id);
        if (f) renderFrame(f, true);
        renderInspector();
      }
    });
  }
}

/* ======================= Frames on the canvas ============================= */

function frameKindIcon(kind) { return { image: ICON.image, html: ICON.screen, board: ICON.board }[kind] || ICON.board; }
function frameKindLabel(kind) { return { image: "Export", html: "Screen", board: "Board" }[kind] || kind; }

function ensureFrameNode(frame) {
  let n = frameNodes.get(frame.id);
  if (n) return n;
  const root = el("div", { class: "dr-frame", "data-frame-id": frame.id });
  const label = el("div", { class: "dr-frame-label" });
  const body = el("div", { class: "dr-frame-body" });
  const content = el("div", { class: "dr-frame-content" });
  const catcher = el("div", { class: "dr-catcher", hidden: true });
  const pins = el("div", { class: "dr-pins" });
  const cursors = el("div", { class: "dr-cursors" });
  // Shown when a screen's page continues below the frame's declared height (see measureScreen).
  const overflow = el("div", { class: "dr-overflow" }, [
    el("button", { class: "dr-pill secondary", "data-fit-height-strip": "1", title: "Grow the frame to the page's full height",
      onclick: e => { e.stopPropagation(); fitScreenHeight(frame.id); } }, [fitIcon(), "Continues below · Fit height"]),
  ]);
  body.append(content, catcher, overflow, pins, cursors);
  root.append(label, body);
  root.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (mode === "comment") return;
    if (selectedFrameId !== frame.id) selectFrame(frame.id, { keepComment: false });
    e.stopPropagation();
  });
  catcher.addEventListener("click", e => {
    const f = frameById(frame.id);
    if (!f) return;
    const r = body.getBoundingClientRect();
    const nx = clamp((e.clientX - r.left) / r.width, 0, 1);
    const ny = clamp((e.clientY - r.top) / r.height, 0, 1);
    openComposer(f, nx, ny);
  });
  attachFrameDrag(label, frame.id);
  R.world.appendChild(root);
  n = { root, label, body, content, catcher, pins, cursors, renderedVersion: null, renderedMode: null, renderedSel: null,
    renderedEditing: false, rendered: { src: undefined, html: undefined, blocks: undefined, width: 0, height: 0 }, pendingHtml: undefined,
    renderedSerialized: null, contentHeight: 0 };
  frameNodes.set(frame.id, n);
  return n;
}

function renderFrame(frame, force = false) {
  const n = ensureFrameNode(frame);
  n.root.style.left = frame.x + "px";
  n.root.style.top = frame.y + "px";
  n.root.style.width = frame.width + "px";
  n.root.style.height = frame.height + "px";
  n.root.classList.toggle("selected", frame.id === selectedFrameId);
  const idx = board.frames.indexOf(frame) + 1;
  n.label.innerHTML = "";
  n.label.append(el("span", { class: "k", text: `${idx} · ${frameKindLabel(frame.kind)}` }), el("span", { text: frame.title }));
  const isEditingHtml = mode === "edit" && frame.kind === "html" && frame.id === selectedFrameId;
  const selKey = `${selectedBlockId}|${isEditingHtml}`;
  // A screen that was being edited is read back *before* anything below can rebuild it, so a
  // frame switch, mode change or remote update never discards text the 900 ms timer has not
  // saved yet. This is the one seam every rebuild path goes through.
  if (frame.kind === "html" && n.renderedEditing) captureScreenEdit(frame.id);
  // Rebuild content only when the content itself changed: a move or rename must not re-decode an
  // image or tear down a screen. Our own screen edit echoed back by the server is already on
  // screen (the live DOM is what we sent), so adopt it without rebuilding and keep the caret.
  let contentChanged = frame.kind === "image" ? n.rendered.src !== frame.src
    : frame.kind === "html" ? (n.rendered.html !== frame.html || n.rendered.width !== frame.width || n.rendered.height !== frame.height)
    : n.rendered.blocks !== frame.blocks;
  if (frame.kind === "html" && contentChanged && n.pendingHtml !== undefined && frame.html === n.pendingHtml &&
      n.rendered.width === frame.width && n.rendered.height === frame.height) {
    n.rendered.html = frame.html;
    n.pendingHtml = undefined;
    contentChanged = false;
  }
  if (force || contentChanged || n.renderedMode !== mode || n.renderedSel !== selKey) {
    // A screen being edited keeps its live DOM (and caret) unless its content actually changed.
    const keepLiveScreen = frame.kind === "html" && isEditingHtml && n.renderedEditing === true && !contentChanged && !force;
    if (!keepLiveScreen) {
      if (frame.kind === "image") {
        n.content.innerHTML = "";
        if (frame.src) n.content.appendChild(el("img", { src: frame.src, draggable: "false", alt: frame.title }));
        else n.content.appendChild(el("div", { class: "dr-empty", style: { paddingTop: "40%" } }, ["No image yet"]));
      } else if (frame.kind === "html") {
        const root = renderScreen(frame, n.content);
        if (isEditingHtml) enableScreenEditing(frame, n, root);
        // Canonical form of what is on screen, so "did anyone type?" is a plain comparison.
        n.renderedSerialized = isEditingHtml ? serializeScreen(n.content) : null;
        measureScreen(frame.id, root);
        // Inline images decode after the first layout; a load anywhere in the screen re-measures.
        root.addEventListener("load", () => measureScreen(frame.id, root), true);
      } else {
        renderBoard(frame, n.content);
      }
    }
    n.rendered = { src: frame.src, html: frame.html, blocks: frame.blocks, width: frame.width, height: frame.height };
    n.renderedMode = mode;
    n.renderedSel = selKey;
    n.renderedEditing = isEditingHtml;
  }
  n.renderedVersion = frame.version;
  n.content.classList.toggle("noninteractive", mode !== "edit");
  n.content.classList.toggle("editing", isEditingHtml);
  n.catcher.hidden = mode !== "comment";
  renderPins(frame);
  renderCursors(frame);
}

/* Screens are clipped to their declared height, like frames in Figma, so a fold stays where the
 * designer put it and pin geometry is identical on every machine. When the page continues below
 * the fold, the frame says so and offers to grow to the measured height; the inspector has the
 * same button. Nothing grows on its own: the persisted height is what every viewer lays out. */
function measureScreen(frameId, root) {
  const n = frameNodes.get(frameId);
  const frame = frameById(frameId);
  if (!n || !frame || frame.kind !== "html" || !root.isConnected) return;
  n.contentHeight = Math.ceil(root.offsetHeight || 0);
  syncOverflowUi(frameId);
}
function screenOverflows(frame) {
  const n = frameNodes.get(frame.id);
  return !!n && frame.kind === "html" && n.contentHeight > frame.height + 2;
}
function syncOverflowUi(frameId) {
  const frame = frameById(frameId);
  const n = frameNodes.get(frameId);
  if (!frame || !n) return;
  n.root.classList.toggle("overflowing", screenOverflows(frame));
  if (frameId !== selectedFrameId || !R.inspector) return;
  // Update the inspector's button in place; a full re-render would drop a teammate's caret.
  const btn = R.inspector.querySelector("[data-fit-height]");
  if (btn) applyFitButtonState(btn, frame);
}
function applyFitButtonState(btn, frame) {
  const n = frameNodes.get(frame.id);
  const over = screenOverflows(frame);
  btn.disabled = !over;
  btn.title = over ? `Grow the frame to the page's full height (${n.contentHeight}px)` : "The page fits inside the frame";
  btn.querySelector("[data-fit-label]").textContent = over ? `Fit height · ${n.contentHeight}px` : "Height fits";
}
function fitIcon() {
  const icon = svgIcon(ICON.chevron, 13);
  icon.setAttribute("style", "transform:rotate(90deg)");
  return icon;
}
async function fitScreenHeight(frameId) {
  const n = frameNodes.get(frameId);
  const frame = frameById(frameId);
  if (!n || !frame || !screenOverflows(frame)) return;
  const height = clamp(n.contentHeight, 40, 20000);
  try { await gadget.updateFrame(frameId, { height }); toast(`"${frame.title}" now shows the whole page.`); }
  catch { toast("Could not resize the frame.", "error"); }
}

function enableScreenEditing(frame, n, root) {
  root.setAttribute("contenteditable", "true");
  root.spellcheck = false;
  const schedule = () => {
    clearTimeout(pendingHtmlSaves.get(frame.id));
    pendingHtmlSaves.set(frame.id, setTimeout(() => flushScreenEdit(frame.id), 900));
  };
  root.addEventListener("input", () => { schedule(); measureScreen(frame.id, root); });
  root.addEventListener("blur", () => flushScreenEdit(frame.id));
  root.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") root.blur(); });
  root.addEventListener("pointerdown", e => e.stopPropagation());
}
// Local screen edits that could not be applied: a teammate's version landed first, or the save
// failed. Kept here so the inspector can offer "Restore my edit" instead of losing the text.
const lostScreenEdits = new Map();   // frameId -> html

/* Synchronously read the live editor. When the user typed since the last render, apply the text to
 * the local frame at once (so any rebuild shows it) and start the save. Returns the captured html,
 * or null when there was nothing new to save. */
function captureScreenEdit(frameId) {
  clearTimeout(pendingHtmlSaves.get(frameId));
  pendingHtmlSaves.delete(frameId);
  const n = frameNodes.get(frameId);
  const frame = frameById(frameId);
  if (!n || !frame || frame.kind !== "html" || !n.renderedEditing || !n.content.shadowRoot) return null;
  const html = serializeScreen(n.content);
  if (html === n.renderedSerialized || html === frame.html) return null;
  if (frame.html !== n.rendered.html) {
    // A teammate's version of this screen arrived while it was being edited here. Their copy takes
    // the frame; the local text is kept aside rather than silently overwriting theirs.
    lostScreenEdits.set(frameId, html);
    n.renderedSerialized = html;
    toast(`"${frame.title}" changed elsewhere. Your unsaved edit is kept in the inspector.`, "error");
    renderInspector();
    return null;
  }
  const expectedVersion = frame.version;
  frame.html = html;
  n.rendered.html = html;
  n.renderedSerialized = html;
  n.pendingHtml = html;   // lets renderFrame recognise the server's echo of this edit
  saveScreenEdit(frameId, html, expectedVersion);
  return html;
}
async function saveScreenEdit(frameId, html, expectedVersion) {
  const frame = frameById(frameId);
  const n = frameNodes.get(frameId);
  if (!frame) return;
  try {
    const result = await gadget.updateFrame(frameId, { html }, expectedVersion);
    if (result.status === "conflict") {
      if (n) n.pendingHtml = undefined;
      lostScreenEdits.set(frameId, html);
      toast(`"${frame.title}" changed elsewhere. Your edit is kept in the inspector.`, "error");
      Object.assign(frame, result.frame);
      renderFrame(frame, true);
      renderInspector();
      return;
    }
    Object.assign(frame, result.frame);
    if (n) { n.rendered.html = result.frame.html; if (n.pendingHtml === html) n.pendingHtml = undefined; }
  } catch (e) {
    if (n) n.pendingHtml = undefined;
    lostScreenEdits.set(frameId, html);
    toast("Could not save the screen. Your edit is kept in the inspector.", "error");
    renderInspector();
  }
}
function flushScreenEdit(frameId) { captureScreenEdit(frameId); }

function visibleComments(frame) {
  return commentsFor(frame.id).filter(c => threadFilter === "all" || c.status === "open" || c.id === selectedCommentId);
}
function renderPins(frame) {
  const n = frameNodes.get(frame.id);
  if (!n) return;
  n.pins.innerHTML = "";
  for (const c of visibleComments(frame)) {
    const pin = el("button", { class: "dr-pin" + (c.status === "resolved" ? " resolved" : "") + (c.id === selectedCommentId ? " selected" : "") + (c.askAgent ? " ask" : ""),
      title: `#${c.number} ${c.author.name}`, style: { left: (c.x * 100) + "%", top: (c.y * 100) + "%" } },
      [c.status === "resolved" ? svgIcon(ICON.check, 13, { strokeWidth: 2.4 }) : String(c.number)]);
    pin.style.pointerEvents = mode === "edit" ? "none" : "auto";
    attachPinInteractions(pin, frame, c, n);
    n.pins.appendChild(pin);
  }
  if (composer && composer.frameId === frame.id) {
    n.pins.appendChild(el("div", { class: "dr-pin provisional", style: { left: (composer.x * 100) + "%", top: (composer.y * 100) + "%" } }, ["+"]));
  }
}
function attachPinInteractions(pin, frame, comment, n) {
  pin.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    let dragged = false;
    const rect = n.body.getBoundingClientRect();
    const onMove = ev => {
      if (!dragged && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) { dragged = true; pin.classList.add("dragging"); }
      if (!dragged) return;
      const nx = clamp((ev.clientX - rect.left) / rect.width, 0, 1), ny = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
      pin.style.left = (nx * 100) + "%"; pin.style.top = (ny * 100) + "%";
      comment.x = nx; comment.y = ny;
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      pin.classList.remove("dragging");
      if (dragged) {
        try { await gadget.moveComment(comment.id, { x: comment.x, y: comment.y }); } catch { toast("Could not move the pin.", "error"); }
      } else {
        selectComment(comment.id, { scroll: true });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  pin.addEventListener("click", e => e.stopPropagation());
}

function renderCursors(frame) {
  const n = frameNodes.get(frame.id);
  if (!n) return;
  n.cursors.innerHTML = "";
  const now = Date.now();
  for (const [id, p] of presence) {
    if (id === clientId || p.frameId !== frame.id || now - p.at > PRESENCE_TTL_MS || p.x == null) continue;
    const c = el("div", { class: "dr-cursor", style: { left: (p.x * 100) + "%", top: (p.y * 100) + "%" } });
    const arrow = svgIcon(ICON.cursor, 18, { strokeWidth: 1.5 });
    arrow.setAttribute("fill", p.color); arrow.setAttribute("stroke", "#fff");
    c.append(arrow, el("span", { class: "tag", text: p.name, style: { background: p.color } }));
    n.cursors.appendChild(c);
  }
}

function renderAllFrames() {
  const seen = new Set();
  for (const f of board.frames) { renderFrame(f); seen.add(f.id); }
  for (const [id, n] of frameNodes) if (!seen.has(id)) { n.root.remove(); frameNodes.delete(id); }
}

function attachFrameDrag(label, frameId) {
  label.addEventListener("pointerdown", e => {
    if (e.button !== 0 || mode === "comment") return;
    e.stopPropagation();
    const frame = frameById(frameId);
    if (!frame) return;
    if (selectedFrameId !== frameId) selectFrame(frameId, { keepComment: false });
    const startX = e.clientX, startY = e.clientY, ox = frame.x, oy = frame.y;
    const n = frameNodes.get(frameId);
    let dragged = false;
    const onMove = ev => {
      const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
      if (!dragged && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragged = true;
      if (!dragged) return;
      frame.x = Math.round(ox + dx); frame.y = Math.round(oy + dy);
      n.root.style.left = frame.x + "px"; n.root.style.top = frame.y + "px";
      positionComposer();
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!dragged) return;
      try { await gadget.updateFrame(frame.id, { x: frame.x, y: frame.y }); } catch { toast("Could not move the frame.", "error"); }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/* ======================= Canvas: pan, zoom, selection ===================== */

function applyTransform() {
  R.world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  // Labels, pins and cursors counter-scale so they stay legible at any zoom (Figma-style).
  R.world.style.setProperty("--inv", String(1 / zoom));
  R.zoomLabel.textContent = Math.round(zoom * 100) + "%";
  positionComposer();
}
function canvasRect() { return R.canvas.getBoundingClientRect(); }
function toWorld(clientX, clientY) {
  const r = canvasRect();
  return { x: (clientX - r.left - pan.x) / zoom, y: (clientY - r.top - pan.y) / zoom };
}
function setZoom(next, cx, cy) {
  const r = canvasRect();
  const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
  const before = { x: (px - pan.x) / zoom, y: (py - pan.y) / zoom };
  zoom = clamp(next, 0.05, 4);
  pan.x = px - before.x * zoom;
  pan.y = py - before.y * zoom;
  applyTransform();
}
function boardBounds(frames = board.frames) {
  if (!frames.length) return { x: 0, y: 0, w: 1200, h: 800 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const f of frames) {
    x1 = Math.min(x1, f.x); y1 = Math.min(y1, f.y - 32);
    x2 = Math.max(x2, f.x + f.width); y2 = Math.max(y2, f.y + f.height);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function fitToView(frames, padding = 48) {
  const r = canvasRect();
  const b = boardBounds(frames);
  const z = clamp(Math.min((r.width - padding * 2) / b.w, (r.height - padding * 2) / b.h), 0.05, 1.5);
  zoom = z;
  pan.x = (r.width - b.w * z) / 2 - b.x * z;
  pan.y = (r.height - b.h * z) / 2 - b.y * z;
  applyTransform();
}
function zoomToFrame(frame) { fitToView([frame], 60); }
function revealComment(comment) {
  const f = frameById(comment.frameId);
  if (!f) return;
  const r = canvasRect();
  const wx = f.x + comment.x * f.width, wy = f.y + comment.y * f.height;
  const sx = pan.x + wx * zoom, sy = pan.y + wy * zoom;
  const margin = 80;
  if (sx < margin || sx > r.width - margin || sy < margin || sy > r.height - margin) {
    pan.x = r.width / 2 - wx * zoom;
    pan.y = r.height / 2 - wy * zoom;
    applyTransform();
  }
}

function attachCanvasInteractions() {
  const c = R.canvas;
  c.addEventListener("wheel", e => {
    e.preventDefault();
    const r = canvasRect();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0022);
      setZoom(zoom * factor, e.clientX - r.left, e.clientY - r.top);
    } else {
      pan.x -= e.deltaX; pan.y -= e.deltaY;
      applyTransform();
    }
  }, { passive: false });

  let spaceDown = false;
  window.addEventListener("keydown", e => { if (e.code === "Space" && !isTyping(e)) { spaceDown = true; } });
  window.addEventListener("keyup", e => { if (e.code === "Space") spaceDown = false; });

  c.addEventListener("pointerdown", e => {
    if (e.button === 1 || e.button === 0 && (spaceDown || e.target === c || e.target === R.world)) {
      if (e.button === 0 && !spaceDown && mode !== "comment") {
        selectFrame(null); closeComposer();
      }
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = pan.x, oy = pan.y;
      c.classList.add("panning");
      const onMove = ev => { pan.x = ox + (ev.clientX - sx); pan.y = oy + (ev.clientY - sy); applyTransform(); };
      const onUp = () => { c.classList.remove("panning"); window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }
  });

  // Presence: report the cursor as a normalized position within the frame under it.
  let lastSent = 0, lastKey = "";
  c.addEventListener("pointermove", e => {
    const now = Date.now();
    if (now - lastSent < 60) return;
    const w = toWorld(e.clientX, e.clientY);
    let hit = null;
    for (let i = board.frames.length - 1; i >= 0; i--) {
      const f = board.frames[i];
      if (w.x >= f.x && w.x <= f.x + f.width && w.y >= f.y && w.y <= f.y + f.height) { hit = f; break; }
    }
    const payload = hit
      ? { frameId: hit.id, x: (w.x - hit.x) / hit.width, y: (w.y - hit.y) / hit.height }
      : { frameId: null, x: null, y: null };
    const key = `${payload.frameId}:${payload.x?.toFixed(3)}:${payload.y?.toFixed(3)}`;
    if (key === lastKey) return;
    lastKey = key; lastSent = now;
    sendPresence(payload);
  });
  c.addEventListener("pointerleave", () => sendPresence({ frameId: null, x: null, y: null }));

  // Drop Figma exports straight onto the canvas.
  let dragDepth = 0;
  c.addEventListener("dragenter", e => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; c.classList.add("dropping"); } });
  c.addEventListener("dragover", e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  c.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; c.classList.remove("dropping"); } });
  c.addEventListener("drop", e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; c.classList.remove("dropping");
    const at = toWorld(e.clientX, e.clientY);
    addImageFiles([...e.dataTransfer.files], at);
  });
}
function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes("Files"); }
function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

function sendPresence(payload) {
  if (!subscription) return;
  try { gadget.updatePresence({ clientId, name: me.name, color: me.color, mode, ...payload }); } catch {}
}

/* ----------------------- Selection & modes ------------------------------- */
function setMode(next) {
  if (mode === next) return;
  // Leaving edit mode flushes any pending screen edits.
  if (mode === "edit") for (const id of [...pendingHtmlSaves.keys()]) flushScreenEdit(id);
  mode = next;
  if (mode !== "edit") selectedBlockId = null;
  if (mode !== "comment") closeComposer();
  R.canvas.classList.toggle("mode-comment", mode === "comment");
  for (const b of R.modeButtons) b.classList.toggle("active", b.dataset.mode === mode);
  R.hint.innerHTML = {
    select: "Click a frame to select it · drag a label to move it · <kbd>C</kbd> to comment · <kbd>E</kbd> to edit",
    comment: "Click anywhere on a frame to pin a note · <kbd>Esc</kbd> to cancel · <kbd>V</kbd> to go back",
    edit: "Edit copy in place · drag and resize blocks on boards · <kbd>V</kbd> when you are done",
  }[mode];
  renderAllFrames();
  renderInspector();
  renderFrameList();
}
function selectFrame(id, { keepComment = false, reveal = false } = {}) {
  selectedFrameId = id;
  selectedBlockId = null;
  if (!keepComment) selectedCommentId = null;
  renderAllFrames();
  renderFrameList();
  renderInspector({ force: true });
  renderThreads();
  if (reveal && id) { const f = frameById(id); if (f) zoomToFrame(f); }
}
function selectBlock(frameId, blockId) {
  const frameChanged = selectedFrameId !== frameId;
  selectedFrameId = frameId;
  selectedBlockId = blockId;
  if (frameChanged) {
    // The previously selected frame must drop its highlight too.
    renderAllFrames(); renderFrameList(); renderThreads();
  } else {
    const f = frameById(frameId);
    if (f) renderFrame(f, true);
  }
  renderInspector({ force: true });
}
function selectComment(id, { scroll = false } = {}) {
  selectedCommentId = id;
  const c = commentById(id);
  if (c) selectedFrameId = c.frameId;
  closeComposer();
  renderAllFrames();
  renderThreads();
  renderFrameList();
  if (c && scroll) revealComment(c);
  if (c) {
    const row = R.threadList.querySelector(`[data-comment-id="${c.id}"]`);
    row?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }
}

/* ----------------------- Composer (new comment) -------------------------- */
function openComposer(frame, nx, ny) {
  // A note typed at one spot survives a click at another: the text moves along with the pin.
  const draft = composer ? { body: composer.ta.value, askAgent: composer.ask.checked } : null;
  closeComposer();
  if (selectedFrameId !== frame.id || selectedBlockId || selectedCommentId) {
    // The composer's frame is the selected frame everywhere (list, canvas, inspector, threads)
    // from the first click, not only once the note posts.
    selectedFrameId = frame.id;
    selectedBlockId = null;
    selectedCommentId = null;
    renderAllFrames(); renderFrameList(); renderInspector(); renderThreads();
  }
  const node = el("div", { class: "dr-composer", onpointerdown: e => e.stopPropagation() });
  const ta = el("textarea", { class: "dr-input", placeholder: "Leave a note for the team…", rows: 3 });
  const ask = el("input", { type: "checkbox" });
  if (draft?.body) ta.value = draft.body;
  if (draft?.askAgent) ask.checked = true;
  const post = el("button", { class: "dr-pill", text: "Post" });
  const cancel = el("button", { class: "dr-pill ghost", text: "Cancel" });
  node.append(
    el("div", { style: { fontSize: "12px", color: T.inkSoft, marginBottom: "6px" } }, [`${frame.title} · ${me.name}`]),
    ta,
    el("div", { class: "foot" }, [el("label", {}, [ask, svgIcon(ICON.sparkle, 13), "Ask the agent"]), el("div", { class: "dr-spacer" }), cancel, post]),
  );
  const submit = async () => {
    const body = ta.value.trim();
    if (!body) { ta.focus(); return; }
    post.disabled = true;
    try {
      const c = await gadget.addComment({ frameId: frame.id, x: nx, y: ny, body, askAgent: ask.checked, author: { id: me.id, name: me.name } });
      closeComposer();
      selectComment(c.id);
    } catch (e) { post.disabled = false; toast("Could not post the comment.", "error"); }
  };
  post.addEventListener("click", submit);
  cancel.addEventListener("click", closeComposer);
  ta.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === "Escape") { e.preventDefault(); closeComposer(); }
  });
  composer = { frameId: frame.id, x: nx, y: ny, node, ta, ask };
  R.canvas.appendChild(node);
  positionComposer();
  renderPins(frame);
  ta.focus();
  if (draft?.body) ta.setSelectionRange(ta.value.length, ta.value.length);
}
function positionComposer() {
  if (!composer) return;
  const f = frameById(composer.frameId);
  if (!f) { closeComposer(); return; }
  const r = canvasRect();
  const sx = pan.x + (f.x + composer.x * f.width) * zoom;
  const sy = pan.y + (f.y + composer.y * f.height) * zoom;
  const w = 300, h = composer.node.offsetHeight || 160;
  composer.node.style.left = clamp(sx + 18, 8, r.width - w - 8) + "px";
  composer.node.style.top = clamp(sy - 12, 8, r.height - h - 8) + "px";
}
function closeComposer() {
  if (!composer) return;
  const frameId = composer.frameId;
  composer.node.remove();
  composer = null;
  const f = frameById(frameId);
  if (f) renderPins(f);
}

/* ----------------------- Keyboard ---------------------------------------- */
function attachKeyboard() {
  window.addEventListener("keydown", async e => {
    if (isTyping(e)) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      try { if (e.shiftKey) await gadget.redo(); else await gadget.undo(); } catch {}
      return;
    }
    if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); try { await gadget.redo(); } catch {} return; }
    if (meta) return;
    switch (e.key) {
      case "v": case "V": setMode("select"); break;
      case "c": case "C": setMode("comment"); break;
      case "e": case "E": setMode("edit"); break;
      case "0": fitToView(board.frames); break;
      case "1": setZoom(1); break;
      case "=": case "+": setZoom(zoom * 1.2); break;
      case "-": case "_": setZoom(zoom / 1.2); break;
      case "Escape":
        if (composer) closeComposer();
        else if (selectedBlockId) { selectedBlockId = null; renderAllFrames(); renderInspector(); }
        else if (selectedCommentId) { selectedCommentId = null; renderAllFrames(); renderThreads(); }
        else if (mode !== "select") setMode("select");
        else selectFrame(null);
        break;
      case "Delete": case "Backspace":
        if (mode === "edit" && selectedBlockId && selectedFrameId) {
          e.preventDefault();
          try { await gadget.removeBlock(selectedFrameId, selectedBlockId); selectedBlockId = null; } catch {}
        }
        break;
      case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown":
        if (mode === "edit" && selectedBlockId && selectedFrameId) {
          e.preventDefault();
          const f = frameById(selectedFrameId); const b = f?.blocks?.find(b => b.id === selectedBlockId);
          if (!b) return;
          const step = e.shiftKey ? 10 : 1;
          if (e.key === "ArrowLeft") b.x -= step; if (e.key === "ArrowRight") b.x += step;
          if (e.key === "ArrowUp") b.y -= step; if (e.key === "ArrowDown") b.y += step;
          renderFrame(f, true);
          await saveBlock(f, b, { x: b.x, y: b.y });
        }
        break;
      case "Tab":
        // Tab walks the open threads once one is selected or while commenting. Otherwise focus
        // leaves the board the normal way, so keyboard users are never trapped in it.
        {
          if (!selectedCommentId && mode !== "comment") return;
          const open = board.comments.filter(c => c.status === "open");
          if (!open.length) return;
          e.preventDefault();
          const i = open.findIndex(c => c.id === selectedCommentId);
          const next = open[(i + (e.shiftKey ? -1 : 1) + open.length) % open.length];
          selectComment(next.id, { scroll: true });
        }
        break;
    }
  });
}

/* ======================= Shell: header, panels ============================ */

function mountShell() {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const app = el("div", { class: "dr-app" });

  // ---- header
  const title = el("input", { class: "dr-title", value: board.meta.title || "Design Review", "aria-label": "Board title" });
  title.addEventListener("change", async () => { try { await gadget.updateMeta({ title: title.value }); } catch {} });
  title.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") title.blur(); });
  const round = el("input", { class: "dr-round", value: board.meta.round || "Round 1", "aria-label": "Round or milestone", size: 10 });
  round.addEventListener("change", async () => { try { await gadget.updateMeta({ round: round.value }); } catch {} });
  round.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") round.blur(); });
  R.title = title; R.round = round;

  const seg = el("div", { class: "dr-seg" });
  R.modeButtons = [["select", "Select", ICON.cursor, "V"], ["comment", "Comment", ICON.comment, "C"], ["edit", "Edit", ICON.pencil, "E"]]
    .map(([m, label, icon, key]) => {
      const b = el("button", { "data-mode": m, class: m === mode ? "active" : "", title: `${label} (${key})`, onclick: () => setMode(m) }, [svgIcon(icon, 15), el("span", { class: "label", text: label }), el("kbd", { text: key })]);
      seg.appendChild(b);
      return b;
    });

  const undoBtn = el("button", { class: "dr-iconbtn", title: "Undo (⌘Z)", onclick: () => gadget.undo().catch(() => {}) }, [svgIcon(ICON.undo)]);
  const redoBtn = el("button", { class: "dr-iconbtn", title: "Redo (⇧⌘Z)", onclick: () => gadget.redo().catch(() => {}) }, [svgIcon(ICON.redo)]);
  R.undoBtn = undoBtn; R.redoBtn = redoBtn;

  const zoomLabel = el("button", { class: "dr-zoom", title: "Reset to 100%", onclick: () => setZoom(1) }, ["100%"]);
  R.zoomLabel = zoomLabel;
  const zoomOut = el("button", { class: "dr-iconbtn", title: "Zoom out (−)", onclick: () => setZoom(zoom / 1.2) }, [svgIcon(ICON.zoomOut)]);
  const zoomIn = el("button", { class: "dr-iconbtn", title: "Zoom in (+)", onclick: () => setZoom(zoom * 1.2) }, [svgIcon(ICON.zoomIn)]);
  const fit = el("button", { class: "dr-iconbtn", title: "Fit board (0)", onclick: () => fitToView(board.frames) }, [svgIcon(ICON.fit)]);

  const avatars = el("div", { class: "dr-avatars", title: "Who is here" });
  R.avatars = avatars;

  const addWrap = el("div", { style: { position: "relative" } });
  const addBtn = el("button", { class: "dr-pill" }, [svgIcon(ICON.plus, 15, { strokeWidth: 2.2 }), "Add"]);
  const menu = el("div", { class: "dr-menu", hidden: true });
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml", multiple: true, style: { display: "none" } });
  fileInput.addEventListener("change", () => { addImageFiles([...fileInput.files]); fileInput.value = ""; });
  const item = (icon, label, hint, fn) => el("button", { onclick: () => { menu.hidden = true; fn(); } }, [svgIcon(icon, 15), label, hint ? el("span", { text: hint }) : null]);
  menu.append(
    item(ICON.upload, "Upload images", "PNG, JPG, SVG", () => fileInput.click()),
    item(ICON.screen, "New screen", "HTML", () => addScreen()),
    item(ICON.board, "New board", "blocks", () => addBoard()),
  );
  addBtn.addEventListener("click", e => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  window.addEventListener("pointerdown", e => { if (!addWrap.contains(e.target)) menu.hidden = true; });
  addWrap.append(addBtn, menu, fileInput);

  const leftToggle = el("button", { class: "dr-iconbtn", title: "Toggle frames panel", onclick: () => app.classList.toggle("hide-left") }, [svgIcon(ICON.board, 15)]);
  const rightToggle = el("button", { class: "dr-iconbtn", title: "Toggle threads panel", onclick: () => app.classList.toggle("hide-right") }, [svgIcon(ICON.comment, 15)]);

  const header = el("div", { class: "dr-header" }, [
    el("div", { class: "dr-wordmark" }, ["thoughtful agency", el("i")]),
    title, round,
    el("div", { class: "dr-spacer" }),
    seg,
    el("div", { class: "dr-spacer" }),
    undoBtn, redoBtn,
    el("div", { style: { width: "1px", height: "22px", background: T.line, margin: "0 4px" } }),
    el("div", { class: "dr-zoom-group", style: { display: "flex", alignItems: "center", gap: "2px" } }, [zoomOut, zoomLabel, zoomIn, fit,
      el("div", { style: { width: "1px", height: "22px", background: T.line, margin: "0 4px 0 6px" } })]),
    avatars, leftToggle, rightToggle, addWrap,
  ]);

  // ---- left: frames
  const frameList = el("div", { class: "dr-scroll" });
  R.frameList = frameList;
  const left = el("div", { class: "dr-left" }, [
    el("div", { class: "dr-panel-head" }, ["Frames", el("div", { class: "dr-spacer" }), el("span", { "data-frame-count": "1", style: { fontWeight: "400", letterSpacing: "0", textTransform: "none" } })]),
    frameList,
  ]);
  R.frameCount = left.querySelector("[data-frame-count]");

  // ---- center: canvas
  const canvas = el("div", { class: "dr-canvas" });
  const world = el("div", { class: "dr-world" });
  const hint = el("div", { class: "dr-hint" });
  const drop = el("div", { class: "dr-drop" }, ["Drop exports to add frames"]);
  canvas.append(world, hint, drop);
  R.canvas = canvas; R.world = world; R.hint = hint;

  // ---- right: inspector + threads
  const inspector = el("div", { class: "dr-inspector", hidden: true });
  inspector.addEventListener("focusout", () => setTimeout(() => {
    if (inspectorDirty && !inspector.contains(document.activeElement)) renderInspector();
  }, 0));
  const tabs = el("div", { class: "dr-tabs" });
  const filterOpen = el("button", { class: threadFilter === "open" ? "active" : "", text: "Open", onclick: () => { threadFilter = "open"; renderThreads(); renderAllFrames(); } });
  const filterAll = el("button", { class: threadFilter === "all" ? "active" : "", text: "All", onclick: () => { threadFilter = "all"; renderThreads(); renderAllFrames(); } });
  tabs.append(filterOpen, filterAll);
  const scopeBtn = el("button", { class: "dr-iconbtn", title: "Only this frame", style: { width: "28px", height: "28px" }, onclick: () => { threadScope = threadScope === "all" ? "frame" : "all"; scopeBtn.classList.toggle("active", threadScope === "frame"); renderThreads(); } }, [svgIcon(ICON.filter, 14)]);
  const threadList = el("div", { class: "dr-scroll" });
  R.threadList = threadList; R.filterButtons = [filterOpen, filterAll];
  const right = el("div", { class: "dr-right" }, [
    inspector,
    el("div", { class: "dr-panel-head" }, ["Threads", el("div", { class: "dr-spacer" }), scopeBtn, tabs]),
    threadList,
  ]);
  R.inspector = inspector;

  app.append(header, left, canvas, right);
  document.body.appendChild(app);
  R.app = app;

  attachCanvasInteractions();
  attachKeyboard();
  setModeUI();
}
function setModeUI() {
  R.canvas.classList.toggle("mode-comment", mode === "comment");
  R.hint.innerHTML = "Click a frame to select it · drag a label to move it · <kbd>C</kbd> to comment · <kbd>E</kbd> to edit";
}
function updateUndoButtons() {
  if (!R.undoBtn) return;
  R.undoBtn.disabled = !canUndo; R.redoBtn.disabled = !canRedo;
}
function renderHeaderMeta() {
  if (document.activeElement !== R.title) R.title.value = board.meta.title || "Design Review";
  if (document.activeElement !== R.round) R.round.value = board.meta.round || "";
}
function renderAvatars() {
  R.avatars.innerHTML = "";
  const people = [{ clientId, name: me.name, color: me.color }];
  const now = Date.now();
  for (const [id, p] of presence) if (id !== clientId && now - p.at <= PRESENCE_TTL_MS * 4) people.push({ clientId: id, ...p });
  for (const p of people.slice(0, 8)) {
    R.avatars.appendChild(el("span", { class: "dr-avatar", title: p.name + (p.clientId === clientId ? " (you)" : ""), style: { background: p.color }, text: initials(p.name) }));
  }
}

/* ----------------------- Left: frame list -------------------------------- */
let dragFrameIndex = null;
function renderFrameList() {
  const list = R.frameList;
  list.innerHTML = "";
  R.frameCount.textContent = board.frames.length ? String(board.frames.length) : "";
  if (!board.frames.length) {
    list.appendChild(el("div", { class: "dr-empty" }, [el("b", { text: "Nothing here yet" }), "Upload Figma exports or ask the agent to build a screen."]));
    return;
  }
  board.frames.forEach((f, i) => {
    const open = commentsFor(f.id).filter(c => c.status === "open").length;
    const thumb = el("div", { class: "thumb" });
    if (f.kind === "image" && f.src) thumb.appendChild(el("img", { src: f.src, alt: "" }));
    else thumb.appendChild(svgIcon(frameKindIcon(f.kind), 14));
    const row = el("div", { class: "dr-frame-row" + (f.id === selectedFrameId ? " selected" : ""), draggable: "true", "data-frame-id": f.id }, [
      el("span", { class: "idx", text: String(i + 1) }),
      thumb,
      el("div", { class: "meta" }, [el("div", { class: "name", text: f.title }), el("div", { class: "sub", text: `${frameKindLabel(f.kind)} · ${f.width}×${f.height}` })]),
      el("span", { class: "count" + (open ? "" : " zero"), text: String(open) }),
    ]);
    row.addEventListener("click", () => selectFrame(f.id, { reveal: true }));
    row.addEventListener("dblclick", () => {
      selectFrame(f.id, { reveal: true });
      R.app.classList.remove("hide-right");
      const input = R.inspector.querySelector("input[data-title]");
      input?.focus(); input?.select();
    });
    row.addEventListener("dragstart", e => { dragFrameIndex = i; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", f.id); } catch {} });
    row.addEventListener("dragover", e => {
      if (dragFrameIndex == null) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const before = (e.clientY - r.top) < r.height / 2;
      list.querySelectorAll(".drop-before,.drop-after").forEach(n => n.classList.remove("drop-before", "drop-after"));
      row.classList.add(before ? "drop-before" : "drop-after");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      list.querySelectorAll(".drop-before,.drop-after").forEach(n => n.classList.remove("drop-before", "drop-after"));
      const from = dragFrameIndex; dragFrameIndex = null;
      if (from == null || from === i) return;
      const r = row.getBoundingClientRect();
      let to = (e.clientY - r.top) < r.height / 2 ? i : i + 1;
      if (from < to) to -= 1;
      if (from === to) return;
      try { await gadget.moveFrame(board.frames[from].id, to); } catch {}
    });
    row.addEventListener("dragend", () => { dragFrameIndex = null; list.querySelectorAll(".drop-before,.drop-after").forEach(n => n.classList.remove("drop-before", "drop-after")); });
    list.appendChild(row);
  });
}

/* ----------------------- Right: inspector -------------------------------- */
function field(label, control, stacked = false) {
  return el("div", { class: "dr-field" + (stacked ? " stacked" : "") }, [el("span", { text: label }), control]);
}
function numberInput(value, onChange, opts = {}) {
  const i = el("input", { class: "dr-input", type: "number", value: String(value ?? ""), min: opts.min, max: opts.max, step: opts.step || 1 });
  i.addEventListener("change", () => onChange(Number(i.value)));
  i.addEventListener("keydown", e => e.stopPropagation());
  return i;
}
function textInput(value, onChange, placeholder = "") {
  const i = el("input", { class: "dr-input", type: "text", value: value ?? "", placeholder });
  i.addEventListener("change", () => onChange(i.value));
  i.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") i.blur(); });
  return i;
}
function colorInput(value, onChange) {
  const wrap = el("div", { class: "dr-row" });
  const c = el("input", { class: "dr-color", type: "color", value: /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#ffffff" });
  const t = textInput(value || "", v => onChange(v), "#hex or empty");
  c.addEventListener("input", () => { t.value = c.value; onChange(c.value); });
  wrap.append(c, t);
  return wrap;
}
function selectInput(value, options, onChange) {
  const s = el("select", { class: "dr-input" });
  for (const [v, label] of options) s.appendChild(el("option", { value: v, selected: v === String(value) ? true : null, text: label }));
  s.addEventListener("change", () => onChange(s.value));
  return s;
}
let inspectorDirty = false;
function renderInspector(options = {}) {
  const box = R.inspector;
  if (!box) return;
  // A broadcast landing while a teammate types in an inspector field must not replace the field
  // under their caret; re-render once focus leaves (see the focusout hook in mountShell).
  if (!options.force && box.contains(document.activeElement)) { inspectorDirty = true; return; }
  inspectorDirty = false;
  box.innerHTML = "";
  const f = frameById(selectedFrameId);
  if (!f) { box.hidden = true; return; }
  box.hidden = false;
  const head = el("div", { class: "dr-panel-head", style: { padding: "14px 0 6px" } }, [
    svgIcon(frameKindIcon(f.kind), 13), frameKindLabel(f.kind),
    el("div", { class: "dr-spacer" }),
    el("button", { class: "dr-iconbtn", title: "Duplicate frame", style: { width: "28px", height: "28px" }, onclick: () => gadget.duplicateFrame(f.id).catch(() => toast("Could not duplicate.", "error")) }, [svgIcon(ICON.copy, 14)]),
    el("button", { class: "dr-iconbtn", title: "Delete frame (undo with ⌘Z)", style: { width: "28px", height: "28px", color: T.danger }, onclick: async () => {
      const n = commentsFor(f.id).length;
      try { await gadget.removeFrame(f.id); selectFrame(null); toast(`Deleted "${f.title}"${n ? ` and ${n} thread${n === 1 ? "" : "s"}` : ""} · ⌘Z to undo`); }
      catch { toast("Could not delete.", "error"); }
    } }, [svgIcon(ICON.trash, 14)]),
  ]);
  box.appendChild(head);
  const titleInput = textInput(f.title, v => v.trim() && gadget.updateFrame(f.id, { title: v.trim() }).catch(() => {}));
  titleInput.setAttribute("data-title", "1");
  box.appendChild(field("Title", titleInput));
  const size = el("div", { class: "dr-row" }, [
    numberInput(f.width, v => gadget.updateFrame(f.id, { width: v }).catch(() => {}), { min: 40, max: 8000 }),
    el("span", { text: "×", style: { color: T.inkFaint } }),
    numberInput(f.height, v => gadget.updateFrame(f.id, { height: v }).catch(() => {}), { min: 40, max: 20000 }),
  ]);
  box.appendChild(field("Size", size));

  if (f.kind === "image") {
    const input = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
    input.addEventListener("change", async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const { src, width, height } = await fileToImage(file);
        await gadget.updateFrame(f.id, { src, width, height });
      } catch { toast("Could not read that image.", "error"); }
    });
    box.appendChild(el("div", { class: "dr-row", style: { marginTop: "8px" } }, [
      el("button", { class: "dr-pill secondary", onclick: () => input.click() }, [svgIcon(ICON.upload, 14), "Replace image"]), input,
    ]));
  }
  if (f.kind === "html") {
    box.appendChild(el("div", { style: { fontSize: "12px", color: T.inkSoft, margin: "8px 0 4px", lineHeight: "1.5" } },
      [mode === "edit" ? "Click into the screen to edit copy in place. Changes save as you type." : "Press E to edit copy directly on this screen, or ask the agent to revise it."]));
    const fit = el("button", { class: "dr-pill secondary", "data-fit-height": "1", onclick: () => fitScreenHeight(f.id) }, [fitIcon(), el("span", { "data-fit-label": "1" })]);
    applyFitButtonState(fit, f);
    box.appendChild(el("div", { class: "dr-row", style: { margin: "6px 0" } }, [fit]));
    if (lostScreenEdits.has(f.id)) {
      box.appendChild(el("div", { class: "dr-row", style: { margin: "6px 0" } }, [
        el("button", { class: "dr-pill secondary", "data-restore-edit": "1", title: "Re-apply the text you typed before a teammate's change replaced this screen", onclick: async () => {
          const html = lostScreenEdits.get(f.id);
          lostScreenEdits.delete(f.id);
          try { await gadget.updateFrame(f.id, { html }); toast("Your edit is back on the screen."); }
          catch { lostScreenEdits.set(f.id, html); toast("Could not restore the edit.", "error"); }
          renderInspector({ force: true });
        } }, [svgIcon(ICON.reopen, 13), "Restore my edit"]),
        el("button", { class: "dr-pill ghost", onclick: () => { lostScreenEdits.delete(f.id); renderInspector({ force: true }); } }, ["Discard"]),
      ]));
    }
  }
  if (f.kind === "board") {
    const bar = el("div", { class: "dr-blockbar", style: { padding: "8px 0 0" } });
    for (const type of PALETTE_ORDER) {
      const def = COMPONENTS[type];
      bar.appendChild(el("button", { title: "Add " + def.name, onclick: async () => {
        if (mode !== "edit") setMode("edit");
        const props = structuredClone(def.props);
        const count = (f.blocks || []).length;
        try {
          const b = await gadget.addBlock(f.id, { type, x: 80 + (count % 6) * 24, y: 80 + (count % 6) * 24, w: def.w, h: def.h, props });
          selectBlock(f.id, b.id);
        } catch { toast("Could not add the block.", "error"); }
      } }, [svgIcon(ICON.plus, 12, { strokeWidth: 2.4 }), def.name]));
    }
    box.appendChild(field("Blocks", bar, true));
    const b = (f.blocks || []).find(b => b.id === selectedBlockId);
    if (b && mode === "edit") box.appendChild(renderBlockInspector(f, b));
  }
}
function renderBlockInspector(frame, block) {
  const def = COMPONENTS[block.type] || COMPONENTS.text;
  const wrap = el("div", { style: { borderTop: `1px solid ${T.lineSoft}`, marginTop: "8px", paddingTop: "6px" } });
  wrap.appendChild(el("div", { class: "dr-panel-head", style: { padding: "6px 0" } }, [def.name,
    el("div", { class: "dr-spacer" }),
    el("button", { class: "dr-iconbtn", title: "Bring forward", style: { width: "26px", height: "26px" }, onclick: async () => {
      const blocks = frame.blocks.slice(); const i = blocks.findIndex(x => x.id === block.id);
      if (i < 0 || i === blocks.length - 1) return; [blocks[i], blocks[i + 1]] = [blocks[i + 1], blocks[i]];
      await gadget.updateFrame(frame.id, { blocks }).catch(() => {});
    } }, [svgIcon(ICON.chevron, 13)]),
    el("button", { class: "dr-iconbtn", title: "Delete block", style: { width: "26px", height: "26px", color: T.danger }, onclick: async () => {
      try { await gadget.removeBlock(frame.id, block.id); selectedBlockId = null; } catch {}
    } }, [svgIcon(ICON.trash, 13)]),
  ]));
  const p = block.props || {};
  const set = patch => saveBlock(frame, block, patch);
  if ("text" in p) {
    const ta = el("textarea", { class: "dr-input", rows: 3 }, [p.text || ""]);
    ta.addEventListener("change", () => set({ props: { text: ta.value } }));
    ta.addEventListener("keydown", e => e.stopPropagation());
    wrap.appendChild(field("Text", ta, true));
  }
  if ("size" in p) wrap.appendChild(field("Size", numberInput(p.size, v => set({ props: { size: v } }), { min: 8, max: 200 })));
  if ("weight" in p) wrap.appendChild(field("Weight", selectInput(p.weight, [["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["700", "Bold"]], v => set({ props: { weight: Number(v) } }))));
  if ("align" in p) wrap.appendChild(field("Align", selectInput(p.align, [["left", "Left"], ["center", "Center"], ["right", "Right"]], v => set({ props: { align: v } }))));
  if ("serif" in p) wrap.appendChild(field("Face", selectInput(p.serif === false ? "sans" : "serif", [["serif", "Serif display"], ["sans", "Sans"]], v => set({ props: { serif: v === "serif" } }))));
  if ("color" in p) wrap.appendChild(field("Color", colorInput(p.color, v => set({ props: { color: v } }))));
  if ("fill" in p) wrap.appendChild(field("Fill", colorInput(p.fill, v => set({ props: { fill: v } }))));
  if ("stroke" in p) wrap.appendChild(field("Stroke", colorInput(p.stroke, v => set({ props: { stroke: v } }))));
  if ("radius" in p) wrap.appendChild(field("Radius", numberInput(p.radius, v => set({ props: { radius: v } }), { min: 0, max: 999 })));
  if ("fit" in p) wrap.appendChild(field("Fit", selectInput(p.fit, [["cover", "Cover"], ["contain", "Contain"]], v => set({ props: { fit: v } }))));
  if (block.type === "image") {
    const input = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
    input.addEventListener("change", async () => {
      const file = input.files?.[0]; if (!file) return;
      try { const { src } = await fileToImage(file); await set({ props: { src } }); } catch { toast("Could not read that image.", "error"); }
    });
    wrap.appendChild(el("div", { class: "dr-row", style: { margin: "6px 0" } }, [el("button", { class: "dr-pill secondary", onclick: () => input.click() }, [svgIcon(ICON.upload, 14), "Choose image"]), input]));
  }
  const pos = el("div", { class: "dr-row" }, [
    numberInput(block.x, v => set({ x: v })), numberInput(block.y, v => set({ y: v })),
  ]);
  const dim = el("div", { class: "dr-row" }, [
    numberInput(block.w, v => set({ w: v }), { min: 8 }), numberInput(block.h, v => set({ h: v }), { min: 8 }),
  ]);
  wrap.appendChild(field("Position", pos));
  wrap.appendChild(field("Size", dim));
  return wrap;
}

/* ----------------------- Right: threads ---------------------------------- */
// Reply drafts live outside the DOM so a teammate's comment landing mid-sentence cannot wipe them.
const replyDrafts = new Map();   // commentId -> text
function renderThreads() {
  const list = R.threadList;
  if (!list) return;
  for (const b of R.filterButtons) b.classList.toggle("active", b.textContent.toLowerCase() === threadFilter);
  const active = document.activeElement;
  const focusedReply = active && active.dataset ? active.dataset.replyFor : null;
  const selection = focusedReply ? [active.selectionStart, active.selectionEnd] : null;
  list.innerHTML = "";
  let items = board.comments.slice().sort((a, b) => a.number - b.number);
  if (threadScope === "frame" && selectedFrameId) items = items.filter(c => c.frameId === selectedFrameId);
  if (threadFilter === "open") items = items.filter(c => c.status === "open");
  if (!items.length) {
    list.appendChild(el("div", { class: "dr-empty" }, [
      el("b", { text: threadFilter === "open" ? "No open threads" : "No threads yet" }),
      threadFilter === "open" ? "Press C and click a frame to leave the first note." : "Comments you and the team leave will show up here.",
    ]));
    return;
  }
  for (const c of items) list.appendChild(renderThread(c));
  if (focusedReply) {
    const again = list.querySelector(`textarea[data-reply-for="${focusedReply}"]`);
    if (again) {
      again.focus();
      try { again.setSelectionRange(selection[0], selection[1]); } catch {}
    }
  }
}
function renderThread(c) {
  const f = frameById(c.frameId);
  const selected = c.id === selectedCommentId;
  const card = el("div", { class: "dr-thread" + (selected ? " selected" : "") + (c.status === "resolved" ? " resolved" : ""), "data-comment-id": c.id });
  card.addEventListener("click", e => { if (!selected && !e.target.closest("button, textarea, input")) selectComment(c.id, { scroll: true }); });
  const top = el("div", { class: "top" }, [
    el("span", { class: "dr-num" + (c.status === "resolved" ? " resolved" : ""), text: String(c.number) }),
    el("span", { class: "who", text: c.author.name }),
    c.askAgent ? el("span", { class: "dr-badge" }, [svgIcon(ICON.sparkle, 11), "agent"]) : null,
    c.status === "resolved" ? el("span", { class: "dr-badge done" }, [svgIcon(ICON.check, 11, { strokeWidth: 2.6 }), "resolved"]) : null,
    el("span", { class: "when", text: timeAgo(c.createdAt) }),
  ]);
  card.append(top, el("div", { class: "body", text: c.body }));
  const frameTag = el("div", { class: "frame-tag" }, [svgIcon(frameKindIcon(f?.kind), 12), f ? f.title : "Missing frame",
    c.replies.length && !selected ? el("span", { text: ` · ${c.replies.length} repl${c.replies.length === 1 ? "y" : "ies"}` }) : null]);
  card.appendChild(frameTag);
  if (!selected) return card;

  if (c.replies.length) {
    const replies = el("div", { class: "dr-replies" });
    for (const r of c.replies) replies.appendChild(el("div", { class: "dr-reply" }, [el("b", { text: r.author.name }), el("span", { text: r.body }), el("span", { class: "when", text: timeAgo(r.createdAt) })]));
    card.appendChild(replies);
  }
  const ta = el("textarea", { class: "dr-input", rows: 2, placeholder: "Reply…", "data-reply-for": c.id });
  ta.value = replyDrafts.get(c.id) || "";
  ta.addEventListener("input", () => { if (ta.value) replyDrafts.set(c.id, ta.value); else replyDrafts.delete(c.id); });
  ta.addEventListener("keydown", async e => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); await sendReply(); }
  });
  const sendReply = async () => {
    const body = ta.value.trim(); if (!body) return;
    ta.disabled = true;
    try { await gadget.replyToComment(c.id, { body, author: { id: me.id, name: me.name } }); ta.value = ""; replyDrafts.delete(c.id); }
    catch { toast("Could not send the reply.", "error"); }
    ta.disabled = false;
  };
  card.appendChild(el("div", { class: "dr-reply-box" }, [ta]));
  const actions = el("div", { class: "dr-thread-actions" }, [
    el("button", { class: "dr-pill", onclick: sendReply }, ["Reply"]),
    c.status === "open"
      ? el("button", { class: "dr-pill secondary", onclick: () => gadget.setCommentStatus(c.id, "resolved", { id: me.id, name: me.name }).catch(() => {}) }, [svgIcon(ICON.check, 13, { strokeWidth: 2.4 }), "Resolve"])
      : el("button", { class: "dr-pill secondary", onclick: () => gadget.setCommentStatus(c.id, "open", { id: me.id, name: me.name }).catch(() => {}) }, [svgIcon(ICON.reopen, 13), "Reopen"]),
    el("button", { class: "dr-pill " + (c.askAgent ? "" : "secondary"), title: "Flag this thread for the agent to act on", onclick: () => gadget.updateComment(c.id, { askAgent: !c.askAgent }).catch(() => {}) }, [svgIcon(ICON.sparkle, 13), c.askAgent ? "Flagged for agent" : "Ask agent"]),
    el("button", { class: "dr-pill danger", title: "Delete thread (undo with ⌘Z)", style: { marginLeft: "auto" }, onclick: async () => {
      try { await gadget.deleteComment(c.id); toast(`Deleted thread #${c.number} · ⌘Z to undo`); } catch { toast("Could not delete.", "error"); }
    } }, [svgIcon(ICON.trash, 13)]),
  ]);
  card.appendChild(actions);
  return card;
}

/* ----------------------- Adding frames ----------------------------------- */
async function readFileAsDataURL(file) {
  return await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}
async function loadImage(src) {
  return await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("decode failed"));
    img.src = src;
  });
}
/* File → { src, width, height }. Rasters larger than MAX_IMAGE_DIM are downscaled on a canvas, and
 * the result is re-encoded smaller until the data: URI fits the server's budget (a 1600px PNG
 * photo can still be several MB); SVG cannot be shrunk, so an oversized one is refused. */
const mb = n => (n / 1_000_000).toFixed(1);
async function fileToImage(file) {
  const original = await readFileAsDataURL(file);
  let img;
  try { img = await loadImage(original); } catch { throw new Error("That file is not an image the browser can decode."); }
  const nw = img.naturalWidth || 1200, nh = img.naturalHeight || 800;
  if (file.type === "image/svg+xml") {
    if (original.length > MAX_SRC_CHARS) throw new Error(`This SVG is ${mb(original.length)} MB; the limit is ${mb(MAX_SRC_CHARS)} MB. Export it as PNG instead.`);
    return { src: original, width: nw, height: nh };
  }
  const longest = Math.max(nw, nh);
  if (longest <= MAX_IMAGE_DIM && file.size < IMAGE_DOWNSCALE_MIN && original.length <= MAX_SRC_CHARS) return { src: original, width: nw, height: nh };
  const isPng = file.type === "image/png";
  let scale = Math.min(1, MAX_IMAGE_DIM / longest);
  let quality = 0.86;
  const canvas = document.createElement("canvas");
  for (let attempt = 0; attempt < 8; attempt++) {
    canvas.width = Math.max(1, Math.round(nw * scale));
    canvas.height = Math.max(1, Math.round(nh * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    let src;
    try { src = canvas.toDataURL(isPng ? "image/png" : "image/jpeg", isPng ? undefined : quality); } catch { break; }
    if (src.length <= MAX_SRC_CHARS) return { src, width: canvas.width, height: canvas.height };
    scale *= 0.8;
    quality = Math.max(0.6, quality - 0.08);
  }
  throw new Error(`Could not shrink ${file.name} under the ${mb(MAX_SRC_CHARS)} MB limit. Export it smaller or as JPEG.`);
}
async function addImageFiles(files, at) {
  const images = files.filter(f => /^image\//.test(f.type));
  if (!images.length) { toast("Drop PNG, JPG, GIF, WebP or SVG files.", "error"); return; }
  let x = at?.x, y = at?.y;
  let last = null;
  for (const file of images) {
    try {
      const { src, width, height } = await fileToImage(file);
      const title = file.name.replace(/\.[a-z0-9]+$/i, "");
      const input = { kind: "image", title, src, width, height };
      if (x != null) { input.x = Math.round(x); input.y = Math.round(y); x += width + FRAME_GAP; }
      last = await gadget.addFrame(input);
    } catch (e) { toast(`Could not add ${file.name}: ${e.message || e}`, "error"); }
  }
  if (last) selectFrame(last.id, { reveal: true });
}
const SCREEN_TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  .screen-root { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #0f1115; background: #ffffff; width: 1200px; min-height: 800px; padding: 72px 96px; box-sizing: border-box; }
  .eyebrow { font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #191f76; margin: 0 0 18px; }
  h1 { font-family: "Instrument Serif", Georgia, serif; font-weight: 400; font-size: 56px; line-height: 1.04; letter-spacing: -.03em; margin: 0 0 20px; max-width: 760px; }
  p { font-size: 18px; line-height: 1.55; color: #5a5d63; max-width: 600px; margin: 0 0 28px; }
  .cta { display: inline-block; background: #191f76; color: #fff; border-radius: 999px; padding: 14px 26px; font-weight: 500; font-size: 15px; }
</style></head><body><div class="screen-root">
  <p class="eyebrow">New screen</p>
  <h1>A headline that names the outcome.</h1>
  <p>Replace this copy, or ask the agent: “turn this screen into the pricing page from the Figma frame”.</p>
  <span class="cta">Primary action</span>
</div></body></html>`;
async function addScreen() {
  try {
    const f = await gadget.addFrame({ kind: "html", title: `Screen ${board.frames.length + 1}`, width: 1200, height: 800, html: SCREEN_TEMPLATE });
    selectFrame(f.id, { reveal: true });
  } catch { toast("Could not add the screen.", "error"); }
}
async function addBoard() {
  try {
    const f = await gadget.addFrame({ kind: "board", title: `Board ${board.frames.length + 1}`, width: 1200, height: 760, blocks: [
      { type: "rect", x: 0, y: 0, w: 1200, h: 760, props: { fill: T.paper, radius: 0, stroke: "" } },
      { type: "heading", x: 96, y: 120, w: 640, h: 130, props: { ...COMPONENTS.heading.props } },
      { type: "text", x: 96, y: 290, w: 520, h: 96, props: { ...COMPONENTS.text.props } },
      { type: "button", x: 96, y: 420, w: 200, h: 52, props: { ...COMPONENTS.button.props } },
    ] });
    selectFrame(f.id, { reveal: true });
    setMode("edit");
  } catch { toast("Could not add the board.", "error"); }
}

/* ======================= Realtime ======================================== */

/* Board events must land on top of the snapshot they follow, never under it. Today that order is
 * guaranteed twice over (the server registers the callback and reads the snapshot under one input
 * gate, and every RPC message is its own task on both hops), but the client should not depend on
 * it: anything a subscriber hears before its snapshot is adopted is queued and replayed after. */
class Subscriber extends RpcTarget {
  pending = [];   // events received before adopt(); null once live
  change(event) {
    if (this.pending) { this.pending.push(event); return; }
    applyBoardEvent(event);
  }
  adopt(snapshot) {
    adoptBoard(snapshot);
    const queued = this.pending;
    this.pending = null;
    for (const event of queued) applyBoardEvent(event);
  }
  presence(event) {
    if (event.clientId === clientId) return;
    if (event.type === "leave") { presence.delete(event.clientId); renderAvatars(); for (const f of board.frames) renderCursors(f); return; }
    const prev = presence.get(event.clientId) || {};
    presence.set(event.clientId, {
      name: event.name || prev.name || "Guest", color: event.color || prev.color || T.brand,
      frameId: event.type === "cursor" ? event.frameId : prev.frameId ?? null,
      x: event.type === "cursor" ? event.x : prev.x ?? null,
      y: event.type === "cursor" ? event.y : prev.y ?? null,
      at: event.at || Date.now(),
    });
    if (event.type === "join") renderAvatars();
    const frames = new Set([prev.frameId, event.frameId].filter(Boolean));
    for (const id of frames) { const f = frameById(id); if (f) renderCursors(f); }
  }
}

function applyBoardEvent(event) {
  if (event.undo) { canUndo = !!event.undo.canUndo; canRedo = !!event.undo.canRedo; updateUndoButtons(); }
  switch (event.type) {
    case "reset":
      board = event.board; selectedFrameId = null; selectedCommentId = null; selectedBlockId = null;
      renderEverything(); fitToView(board.frames); return;
    case "meta":
      board.meta = event.meta; renderHeaderMeta(); return;
    case "order": {
      const byId = new Map(board.frames.map(f => [f.id, f]));
      board.frames = event.order.map(id => byId.get(id)).filter(Boolean);
      renderAllFrames(); renderFrameList(); return;
    }
    case "frame": {
      let frame;
      if (event.frame) {
        // A created frame arrives whole.
        frame = event.frame;
        const i = board.frames.findIndex(f => f.id === frame.id);
        if (i >= 0) board.frames[i] = frame; else board.frames.push(frame);
      } else {
        // An update arrives as a patch; untouched content keeps its identity so nothing re-decodes.
        const i = board.frames.findIndex(f => f.id === event.id);
        if (i < 0) {
          gadget.getFrame(event.id).then(f => {
            if (!f || board.frames.some(x => x.id === f.id)) return;
            board.frames.push(f); renderFrame(f); renderFrameList();
          }).catch(() => {});
          return;
        }
        frame = { ...board.frames[i], ...(event.patch || {}) };
        for (const k of event.unset || []) delete frame[k];
        board.frames[i] = frame;
      }
      renderFrame(frame); renderFrameList();
      if (frame.id === selectedFrameId) renderInspector();
      if (composer && composer.frameId === frame.id) positionComposer();
      return;
    }
    case "frameRemoved":
      board.frames = board.frames.filter(f => f.id !== event.id);
      board.comments = board.comments.filter(c => c.frameId !== event.id);
      if (selectedFrameId === event.id) { selectedFrameId = null; selectedBlockId = null; }
      if (composer?.frameId === event.id) closeComposer();
      renderAllFrames(); renderFrameList(); renderInspector(); renderThreads(); return;
    case "comment": {
      const i = board.comments.findIndex(c => c.id === event.comment.id);
      if (i >= 0) board.comments[i] = event.comment; else board.comments.push(event.comment);
      const f = frameById(event.comment.frameId);
      if (f) renderPins(f);
      // A moved comment leaves pins behind on its old frame; cheap to refresh them all.
      for (const other of board.frames) if (other !== f) renderPins(other);
      renderThreads(); renderFrameList(); return;
    }
    case "commentRemoved":
      board.comments = board.comments.filter(c => c.id !== event.id);
      if (selectedCommentId === event.id) selectedCommentId = null;
      for (const f of board.frames) renderPins(f);
      renderThreads(); renderFrameList(); return;
  }
}

/* A snapshot from subscribe() or getBoard() becomes the local board, undo flags included, so no
 * caller re-applies part of it after events may already have moved on. */
function adoptBoard(snapshot) {
  board = snapshot;
  if (snapshot.undo) { canUndo = !!snapshot.undo.canUndo; canRedo = !!snapshot.undo.canRedo; }
}
/* Registers a fresh subscriber and adopts its snapshot into `board` (replaying anything that
 * arrived in between); returns the adopted board for convenience. */
async function subscribe() {
  const subscriber = new Subscriber();
  const result = await gadget.subscribe(subscriber, { clientId, id: me.id, name: me.name, color: me.color });
  subscription = { token: result.token };
  subscriber.adopt(result.board);
  return board;
}

/* The top-level `gadget` stub survives reconnects but our subscriber stub does not: ping the token
 * every few seconds and subscribe again (reloading the board) when the server no longer knows it. */
function startHeartbeat() {
  setInterval(async () => {
    if (isExport) return;
    try {
      const alive = subscription && await gadget.ping(subscription.token);
      if (!alive) {
        await subscribe();
        renderEverything();
        toast("Reconnected.");
      }
    } catch {}
    // Expire cursors we have not heard from.
    const now = Date.now();
    let changed = false;
    for (const [id, p] of presence) if (now - p.at > PRESENCE_TTL_MS * 4) { presence.delete(id); changed = true; }
    if (changed) { renderAvatars(); for (const f of board.frames) renderCursors(f); }
  }, PING_INTERVAL_MS);
  window.addEventListener("pagehide", () => { try { gadget.leavePresence(clientId); } catch {} });
}

function renderEverything() {
  renderHeaderMeta();
  renderAllFrames();
  renderFrameList();
  renderInspector();
  renderThreads();
  renderAvatars();
  updateUndoButtons();
}

/* ======================= Export ========================================== */

function renderExport() {
  document.title = board.meta.title || "Design Review";
  const style = document.createElement("style");
  style.textContent = STYLE + `body{overflow:visible;background:#fff}`;
  document.head.appendChild(style);
  const root = el("div", { class: "dr-export" });
  const open = board.comments.filter(c => c.status === "open").length;
  root.append(
    el("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "12px" } }, [el("div", { class: "dr-wordmark" }, ["thoughtful agency", el("i")])]),
    el("h1", { text: board.meta.title || "Design Review" }),
    el("div", { class: "sub", text: [board.meta.client, board.meta.round, `${board.frames.length} frames`, `${open} open · ${board.comments.length - open} resolved`].filter(Boolean).join(" · ") }),
  );
  // PNG exports are one tall image; keep the whole thing inside the renderer's pixel budget.
  let scale = 1;
  if (exportFormatId === "png") {
    const totalH = board.frames.reduce((s, f) => s + f.height + 140, 200);
    const maxW = Math.max(1200, ...board.frames.map(f => f.width)) + 96;
    const budget = 20_000_000;
    scale = Math.min(1, Math.sqrt(budget / (totalH * maxW)));
  }
  board.frames.forEach((f, i) => {
    const stage = el("div", { class: "stage", style: { width: f.width * scale + "px", height: f.height * scale + "px", overflow: "hidden" } });
    const inner = el("div", { style: { width: f.width + "px", height: f.height + "px", transform: `scale(${scale})`, transformOrigin: "0 0", position: "relative" } });
    const surface = el("div", { style: { position: "absolute", inset: "0" } });
    inner.appendChild(surface);
    if (f.kind === "image") surface.appendChild(el("img", { src: f.src, style: { width: "100%", height: "100%", objectFit: "contain", display: "block" } }));
    else if (f.kind === "html") renderScreen(f, surface, { light: true });
    else renderBoard(f, surface);
    const cs = commentsFor(f.id).sort((a, b) => a.number - b.number);
    for (const c of cs) inner.appendChild(el("div", { class: "pin" + (c.status === "resolved" ? " resolved" : ""), style: { left: (c.x * 100) + "%", top: (c.y * 100) + "%" }, text: String(c.number) }));
    stage.appendChild(inner);
    const list = el("ol");
    for (const c of cs) {
      list.appendChild(el("li", {}, [
        el("b", { text: `#${c.number} ${c.author.name}${c.status === "resolved" ? " (resolved)" : ""}: ` }), c.body,
        ...c.replies.map(r => el("div", { style: { color: T.inkSoft, marginLeft: "12px" } }, [`${r.author.name}: ${r.body}`])),
      ]));
    }
    root.appendChild(el("div", { class: "fr" }, [el("h2", { text: `${i + 1} · ${f.title} (${frameKindLabel(f.kind)}, ${f.width}×${f.height})` }), stage, cs.length ? list : null]));
  });
  document.body.appendChild(root);
}

/* ======================= Boot ============================================ */

if (isExport) {
  try { board = await gadget.getBoard(); } catch (e) { board = { meta: { title: "Design Review" }, frames: [], comments: [] }; }
  renderExport();
} else {
  mountShell();
  await resolveIdentity();
  try {
    await subscribe();
  } catch (e) {
    console.error("subscribe failed", e);
    try { adoptBoard(await gadget.getBoard()); } catch {}
  }
  renderEverything();
  fitToView(board.frames);
  startHeartbeat();
}
