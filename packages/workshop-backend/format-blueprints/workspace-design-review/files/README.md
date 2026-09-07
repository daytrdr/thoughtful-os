# Design Review

A shared critique board for the Thoughtful Agency team. Frames (Figma exports, HTML screens and
editable block boards) sit on a pannable, zoomable canvas. Anyone on the team drops numbered pins
to start threads, edits copy in place, and flags threads for the agent, which reads and applies
them over the `GADGET` binding.

## Files

- `server.js` — the Durable Object that owns frames, comments and board metadata (one storage key
  per object), commits every mutation as a key-level diff (which powers the shared undo/redo: only
  the changed fields are retained, capped at 8 MB), and broadcasts per-object `change` events plus
  a separate `presence` channel. Also exports the `ExportHandler` (HTML, PDF and PNG of the board,
  and a Markdown review summary).
- `client.js` — the board UI: canvas, frame rendering (image / sanitized HTML in a shadow root /
  block editor), pins and threads, presence cursors, uploads, keyboard shortcuts, export rendering.

## Brand

Thoughtful Agency tokens: brand indigo `#191f76` (hover `#2d3491`, soft `#4a52b6`), ink `#0f1115`,
ink-soft `#5a5d63`, paper `#F5F1E6`, paper-2 `#F8F8F8`, hairline `#e5e5e8`. Body type is
Helvetica Neue; display type is Instrument Serif with a Georgia fallback (the sandbox loads no web
fonts). Buttons are pills, cards are `rounded-2xl`, the wordmark is lowercase with a dot:
`thoughtful agency ·`. Keep new UI inside this palette.

## Modes and keys

| Key | Action |
| --- | --- |
| `V` / `C` / `E` | Select, Comment, Edit mode |
| click (Comment mode) | Drop a numbered pin on a frame and write the note; `Enter` posts, `Esc` cancels |
| `E` then click text | Edit copy in place (screens) or drag / resize / edit blocks (boards) |
| wheel, ⌘/Ctrl+wheel | Pan, zoom; drag empty canvas or hold `Space` to pan |
| `0` / `1` / `+` / `-` | Fit board, 100%, zoom in, zoom out |
| `Tab` / `⇧Tab` | Next / previous open thread |
| ⌘Z / ⇧⌘Z | Undo / redo (shared, server-side, in memory) |
| `Delete`, arrows | Delete or nudge the selected block in Edit mode |

Drag image files onto the canvas or use **Add → Upload images** to create image frames; large
rasters are downscaled to 1600px on the longest side and re-encoded until the data: URI is under
1.5 MB (the server refuses anything larger rather than storing a truncated image; SVGs over the
limit are refused with a message). A frame's stored JSON may not exceed 1.9 MB. **Add → New
screen** creates an HTML frame from a branded template; **Add → New board** creates a block board.

## Data model

```js
Frame = {
  id, title, kind: "image" | "html" | "board",
  x, y,                 // world position (CSS px at zoom 1)
  width, height,        // frame size in CSS px
  src?,                 // image: data: URI (PNG/JPEG/GIF/WebP/SVG)
  html?,                // html: a self-contained document (inline <style>, data: images only)
  blocks?,              // board: [{ id, type, x, y, w, h, props }]
  version, createdAt, updatedAt,
}
Comment = {
  id, number,           // number is stable and never reused
  frameId, x, y,        // normalized 0..1 within the frame
  author: { id, name }, body, status: "open" | "resolved", askAgent,
  replies: [{ id, author, body, createdAt }],
  createdAt, updatedAt, resolvedAt?, resolvedBy?,
}
Meta = { title, client, round, nextCommentNumber, createdAt }
```

Block types on boards: `heading` (serif display), `text`, `rect`, `button`, `image`, `note`.
Their `props` are documented by the defaults in `COMPONENTS` in `client.js`.

HTML screens are sanitized before rendering: scripts, frames, external `src`/`href`, `on*`
handlers and `@import`/`url()` to anything but `data:image/` are removed, and `body`/`html`
selectors are rewritten to `.screen-root`. Write screens as one file with inline CSS and no
external assets; the Welcome frame in `server.js` (`WELCOME_HTML`) is a good template.

## Working with the board from the agent

Every method below is a plain RPC on the `GADGET` binding. Typical flow for "apply the open
comments on frame 2":

```js
const summary = await env.GADGET.getReviewSummary();          // markdown of open threads
const frames = await env.GADGET.listFrames();                 // ids, titles, sizes, counts
const frame = await env.GADGET.getFrame(frames[1].id);        // full content
const open = await env.GADGET.listComments({ frameId: frame.id, status: "open" });
// ...edit frame.html / frame.blocks in code...
const result = await env.GADGET.updateFrame(frame.id, { html: revised }, frame.version);
if (result.status === "conflict") { /* someone edited meanwhile: re-read and merge */ }
for (const c of open) {
  await env.GADGET.replyToComment(c.id, { body: "Done: shortened the headline and moved the CTA.", author: { name: "Agent" } });
  await env.GADGET.setCommentStatus(c.id, "resolved", { name: "Agent" });
}
```

Reads: `getBoard()`, `listFrames()`, `getFrame(id)`, `listComments({ frameId?, status?, askAgent? })`,
`getReviewSummary({ status: "open" | "resolved" | "all" })`, `listPresence()`, `getUndoState()`.

Frames: `addFrame({ kind, title, width, height, src?, html?, blocks?, x?, y?, atIndex? })`,
`updateFrame(id, patch, expectedVersion?)` → `{ status: "applied" | "conflict", frame }`,
`duplicateFrame(id)`, `removeFrame(id)` (its comments go with it), `moveFrame(id, toIndex)`,
`reorderFrames(ids)`. Boards also take `addBlock(frameId, block)`, `updateBlock(frameId, blockId, patch)`,
`removeBlock(frameId, blockId)`.

Comments: `addComment({ frameId, x, y, body, author?, askAgent? })`, `replyToComment(id, { body, author? })`,
`updateComment(id, { body?, askAgent? })`, `setCommentStatus(id, "open" | "resolved", by?)`,
`moveComment(id, { x, y, frameId? })`, `deleteComment(id)`.

Board: `updateMeta({ title?, client?, round? })`, `undo()`, `redo()`, `resetAll()`.

Realtime: `subscribe(callback, { clientId, id, name, color })` returns `{ token, board }` and then
calls `callback.change(event)` for `meta | order | frame | frameRemoved | comment | commentRemoved | reset`
(each carrying `undo: { canUndo, canRedo }`) and `callback.presence(event)` for `join | leave | cursor`.
A created frame arrives as `{ type: "frame", frame }`; an updated frame arrives as
`{ type: "frame", id, patch, unset, version }` with only the changed fields, so moving an image frame
never re-sends its data URI. All events of one commit reach a subscriber in order and without
interleaving with another commit. `ping(token)` reports whether a subscription is still registered
after a reconnect; `updatePresence({ clientId, name, color, frameId, x, y, mode })` and
`leavePresence(clientId)` drive cursors, and `updatePresence({ clientId, name, color, rename: true })`
corrects a name the shell learned late.

Authors are display labels supplied by the caller (the workshop shell injects the signed-in
teammate as `gadgetViewer`); they are not authority. Every teammate on the workspace has the
same rights on the board.

## Export formats

HTML and PDF (browser-rendered, all frames stacked with their pins and threads), PNG of the whole
board (scaled to stay within the renderer's pixel budget), and a Markdown review summary produced
on the server from `getReviewSummary({ status: "all" })`.
