import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/**
 * Design Review board — Thoughtful Agency.
 *
 * The board is a set of *frames* (a Figma export, an HTML screen, or an editable block board)
 * laid out on an infinite canvas, plus *comments* pinned to normalized (0..1) positions on a
 * frame. Every object lives under its own storage key so a board full of inlined images never
 * has to be rewritten as one blob:
 *
 *   meta               { schema, title, client, round, nextCommentNumber, createdAt }
 *   order              [frameId, ...]                      (canvas / list order)
 *   frame:<id>         Frame
 *   comment:<id>       Comment
 *
 * Frame = {
 *   id, title, kind: "image" | "html" | "board",
 *   x, y,                 // world position of the frame's top-left, in CSS px at zoom 1
 *   width, height,        // frame size in CSS px
 *   src?,                 // image frames: data: URI (PNG/JPEG/SVG), inlined by the client
 *   html?,                // html frames: a self-contained document (inline CSS, data: images)
 *   blocks?,              // board frames: [{ id, type, x, y, w, h, props }]
 *   version,              // bumped on every update; updateFrame() can demand a version
 *   createdAt, updatedAt,
 * }
 *
 * Comment = {
 *   id, number,           // number is stable and never reused (Figma-style)
 *   frameId, x, y,        // normalized 0..1 within the frame
 *   author: { id, name }, body, status: "open" | "resolved",
 *   askAgent: boolean,    // the team flagged this thread for the agent to act on
 *   replies: [{ id, author, body, createdAt }],
 *   createdAt, updatedAt, resolvedAt?, resolvedBy?,
 * }
 *
 * Mutations are committed as key-level diffs (`#commit`), which gives one generic undo/redo stack
 * and one generic broadcast. The undo stack lives in memory (shared by every connected client,
 * lost on restart) and stores only the fields an update changed, so dragging an image frame does
 * not retain two copies of its data URI; it is also capped by bytes. Subscribers receive
 * `change(event)` per touched object: a created frame arrives whole, an updated frame arrives as
 * `{ type: "frame", id, patch, unset, version }`, comments arrive whole (they are small). All of a
 * commit's events are handed to each subscriber synchronously, so overlapping commits cannot
 * interleave. Presence (cursors, who is here) travels on a separate `presence(event)` channel and
 * is never persisted.
 *
 * All rendering, sanitizing and editing logic lives in client.js; the server validates shapes
 * and sizes, assigns ids/numbers/versions, and keeps everyone in sync.
 */

const SCHEMA = "design-review.1";
const MAX_UNDO = 50;
const MAX_UNDO_BYTES = 8_000_000;   // total retained undo state, oldest entries evicted first
const MAX_FRAME_BYTES = 1_900_000;  // one frame (with its inlined content) as JSON
const LIMITS = {
  title: 120,
  text: 4000,
  name: 40,
  html: 600_000,      // characters of HTML per frame
  src: 1_600_000,     // characters of data: URI per image frame
  frames: 200,
  comments: 2000,
  blocks: 400,
  replies: 200,
};
const FRAME_KINDS = new Set(["image", "html", "board"]);

export class Gadget extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.subscribers = new Map();  // dup stub -> { token, clientId, name, color }
    this.undoStack = [];           // [{ ops: [UndoOp], bytes }] — see #pushUndo
    this.redoStack = [];
    this.undoBytes = 0;
  }

  // ---------------------------------------------------------------- reads --

  async getBoard() {
    await this.#ensureSeeded();
    const meta = await this.state.storage.get("meta");
    const order = (await this.state.storage.get("order")) || [];
    const frameMap = order.length
      ? await this.state.storage.get(order.map(id => "frame:" + id))
      : new Map();
    const frames = [];
    for (const id of order) {
      const f = frameMap.get("frame:" + id);
      if (f) frames.push(f);
    }
    const commentMap = await this.state.storage.list({ prefix: "comment:" });
    const comments = [...commentMap.values()].sort((a, b) => a.number - b.number);
    return { meta, frames, comments, undo: this.#undoState() };
  }

  /** Frame summaries without the heavy `src` / `html` / `blocks` payloads. */
  async listFrames() {
    const board = await this.getBoard();
    return board.frames.map((f, index) => ({
      id: f.id, index, title: f.title, kind: f.kind,
      x: f.x, y: f.y, width: f.width, height: f.height, version: f.version,
      openComments: board.comments.filter(c => c.frameId === f.id && c.status === "open").length,
      resolvedComments: board.comments.filter(c => c.frameId === f.id && c.status === "resolved").length,
      updatedAt: f.updatedAt,
    }));
  }

  async getFrame(frameId) {
    await this.#ensureSeeded();
    return (await this.state.storage.get("frame:" + String(frameId))) || null;
  }

  async listComments(filter = {}) {
    const board = await this.getBoard();
    return board.comments.filter(c =>
      (!filter.frameId || c.frameId === filter.frameId) &&
      (!filter.status || filter.status === "all" || c.status === filter.status) &&
      (filter.askAgent === undefined || !!c.askAgent === !!filter.askAgent));
  }

  /**
   * Markdown digest of the board for the agent (and for exports). Defaults to open threads only;
   * pass { status: "all" } for everything.
   */
  async getReviewSummary(options = {}) {
    const status = options.status || "open";
    const board = await this.getBoard();
    const lines = [];
    lines.push(`# Design Review: ${board.meta.title}`);
    const sub = [board.meta.client && `Client: ${board.meta.client}`,
      board.meta.round && `Round: ${board.meta.round}`].filter(Boolean);
    if (sub.length) lines.push(sub.join(" · "));
    const open = board.comments.filter(c => c.status === "open").length;
    lines.push(`${board.frames.length} frame(s) · ${open} open comment(s) · ` +
      `${board.comments.length - open} resolved`);
    lines.push("");
    board.frames.forEach((f, i) => {
      const cs = board.comments.filter(c => c.frameId === f.id &&
        (status === "all" || c.status === status));
      lines.push(`## Frame ${i + 1}: ${f.title} (${f.kind}, ${f.width}×${f.height}, id ${f.id})`);
      if (cs.length === 0) { lines.push("_No matching comments._"); lines.push(""); return; }
      for (const c of cs) {
        const pos = `${Math.round(c.x * 100)}%, ${Math.round(c.y * 100)}%`;
        const flags = [c.status, c.askAgent ? "ask-agent" : null].filter(Boolean).join(", ");
        lines.push(`- #${c.number} [${flags}] at (${pos}) ${c.author.name}: ${oneLine(c.body)}`);
        for (const r of c.replies) lines.push(`    - ${r.author.name}: ${oneLine(r.body)}`);
      }
      lines.push("");
    });
    return lines.join("\n");
  }

  async getUndoState() { return this.#undoState(); }

  // --------------------------------------------------------------- frames --

  async addFrame(input = {}) {
    await this.#ensureSeeded();
    const order = (await this.state.storage.get("order")) || [];
    if (order.length >= LIMITS.frames) throw new Error(`A board holds at most ${LIMITS.frames} frames.`);
    const kind = FRAME_KINDS.has(input.kind) ? input.kind : "board";
    const now = new Date().toISOString();
    const width = clampInt(input.width, 40, 8000, 1440);
    const height = clampInt(input.height, 40, 20000, 1024);
    const frame = {
      id: genId(),
      title: str(input.title, LIMITS.title) || defaultTitle(kind, order.length + 1),
      kind, width, height,
      x: 0, y: 0,
      version: 1, createdAt: now, updatedAt: now,
    };
    if (kind === "image") frame.src = dataUri(input.src);
    if (kind === "html") frame.html = bounded(input.html, LIMITS.html, "Screen HTML");
    if (kind === "board") frame.blocks = normalizeBlocks(input.blocks || []);
    assertFrameSize(frame);
    // Place new frames to the right of the current rightmost frame unless told otherwise.
    if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
      frame.x = Math.round(input.x); frame.y = Math.round(input.y);
    } else {
      const existing = order.length
        ? [...(await this.state.storage.get(order.map(id => "frame:" + id))).values()] : [];
      let right = 0;
      for (const f of existing) right = Math.max(right, (f.x || 0) + (f.width || 0));
      frame.x = existing.length ? right + 120 : 0;
      frame.y = 0;
    }
    const at = Number.isInteger(input.atIndex)
      ? Math.max(0, Math.min(order.length, input.atIndex)) : order.length;
    const nextOrder = order.slice();
    nextOrder.splice(at, 0, frame.id);
    await this.#commit([
      { key: "frame:" + frame.id, before: undefined, after: frame },
      { key: "order", before: order, after: nextOrder },
    ]);
    return frame;
  }

  /**
   * Patch a frame. Accepts title, x, y, width, height, src, html, blocks. When `expectedVersion`
   * is given and does not match, nothing is written and { status: "conflict", frame } comes back
   * with the current frame so the caller can merge.
   */
  async updateFrame(frameId, patch = {}, expectedVersion) {
    await this.#ensureSeeded();
    const key = "frame:" + String(frameId);
    const before = await this.state.storage.get(key);
    if (!before) throw new Error("No such frame: " + frameId);
    if (expectedVersion !== undefined && expectedVersion !== null &&
        before.version !== expectedVersion) {
      return { status: "conflict", frame: before };
    }
    const after = { ...before };
    if (patch.title !== undefined) after.title = str(patch.title, LIMITS.title) || before.title;
    if (patch.x !== undefined) after.x = clampInt(patch.x, -200000, 200000, before.x);
    if (patch.y !== undefined) after.y = clampInt(patch.y, -200000, 200000, before.y);
    if (patch.width !== undefined) after.width = clampInt(patch.width, 40, 8000, before.width);
    if (patch.height !== undefined) after.height = clampInt(patch.height, 40, 20000, before.height);
    let contentChanged = false;
    if (patch.src !== undefined && before.kind === "image") { after.src = dataUri(patch.src); contentChanged = true; }
    if (patch.html !== undefined && before.kind === "html") { after.html = bounded(patch.html, LIMITS.html, "Screen HTML"); contentChanged = true; }
    if (patch.blocks !== undefined && before.kind === "board") { after.blocks = normalizeBlocks(patch.blocks); contentChanged = true; }
    if (contentChanged) assertFrameSize(after);
    after.version = before.version + 1;
    after.updatedAt = new Date().toISOString();
    await this.#commit([{ key, before, after }]);
    return { status: "applied", frame: after };
  }

  async removeFrame(frameId) {
    await this.#ensureSeeded();
    const key = "frame:" + String(frameId);
    const before = await this.state.storage.get(key);
    if (!before) return false;
    const order = (await this.state.storage.get("order")) || [];
    const ops = [
      { key, before, after: undefined },
      { key: "order", before: order, after: order.filter(id => id !== before.id) },
    ];
    // Comments die with their frame (undo restores them too).
    const comments = await this.state.storage.list({ prefix: "comment:" });
    for (const [ckey, c] of comments) {
      if (c.frameId === before.id) ops.push({ key: ckey, before: c, after: undefined });
    }
    await this.#commit(ops);
    return true;
  }

  async duplicateFrame(frameId) {
    await this.#ensureSeeded();
    const source = await this.state.storage.get("frame:" + String(frameId));
    if (!source) return null;
    const copy = structuredClone(source);
    copy.id = genId();
    copy.title = source.title + " copy";
    copy.x = (source.x || 0) + (source.width || 0) + 120;
    copy.version = 1;
    copy.createdAt = copy.updatedAt = new Date().toISOString();
    if (copy.blocks) copy.blocks = copy.blocks.map(b => ({ ...b, id: genId() }));
    const order = (await this.state.storage.get("order")) || [];
    const at = order.indexOf(source.id);
    const nextOrder = order.slice();
    nextOrder.splice(at < 0 ? order.length : at + 1, 0, copy.id);
    await this.#commit([
      { key: "frame:" + copy.id, before: undefined, after: copy },
      { key: "order", before: order, after: nextOrder },
    ]);
    return copy;
  }

  async moveFrame(frameId, toIndex) {
    await this.#ensureSeeded();
    const order = (await this.state.storage.get("order")) || [];
    const i = order.indexOf(String(frameId));
    if (i < 0) return;
    const next = order.slice();
    const [id] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, toIndex | 0)), 0, id);
    await this.#commit([{ key: "order", before: order, after: next }]);
  }

  /** Replace the whole order; ids not on the board are ignored, missing ones are appended. */
  async reorderFrames(ids) {
    await this.#ensureSeeded();
    const order = (await this.state.storage.get("order")) || [];
    const wanted = (Array.isArray(ids) ? ids : []).map(String).filter(id => order.includes(id));
    const next = [...new Set([...wanted, ...order])];
    await this.#commit([{ key: "order", before: order, after: next }]);
  }

  // ----------------------------------------------------------- board blocks --

  async addBlock(frameId, block) {
    const frame = await this.getFrame(frameId);
    if (!frame || frame.kind !== "board") throw new Error("Not a board frame: " + frameId);
    const blocks = frame.blocks.slice();
    if (blocks.length >= LIMITS.blocks) throw new Error("Too many blocks on this frame.");
    const [b] = normalizeBlocks([{ ...block, id: undefined }]);
    blocks.push(b);
    await this.updateFrame(frameId, { blocks });
    return b;
  }

  async updateBlock(frameId, blockId, patch = {}) {
    const frame = await this.getFrame(frameId);
    if (!frame || frame.kind !== "board") throw new Error("Not a board frame: " + frameId);
    const blocks = frame.blocks.map(b => {
      if (b.id !== blockId) return b;
      const next = { ...b, ...patch, id: b.id, props: { ...b.props, ...(patch.props || {}) } };
      return normalizeBlocks([next])[0];
    });
    await this.updateFrame(frameId, { blocks });
  }

  async removeBlock(frameId, blockId) {
    const frame = await this.getFrame(frameId);
    if (!frame || frame.kind !== "board") throw new Error("Not a board frame: " + frameId);
    await this.updateFrame(frameId, { blocks: frame.blocks.filter(b => b.id !== blockId) });
  }

  // ------------------------------------------------------------- comments --

  async addComment(input = {}) {
    await this.#ensureSeeded();
    const frame = await this.state.storage.get("frame:" + String(input.frameId));
    if (!frame) throw new Error("No such frame: " + input.frameId);
    const count = (await this.state.storage.list({ prefix: "comment:", limit: LIMITS.comments })).size;
    if (count >= LIMITS.comments) throw new Error(`A board holds at most ${LIMITS.comments} comments.`);
    const body = str(input.body, LIMITS.text);
    if (!body) throw new Error("A comment needs a body.");
    const meta = await this.state.storage.get("meta");
    const now = new Date().toISOString();
    const comment = {
      id: genId(),
      number: meta.nextCommentNumber,
      frameId: frame.id,
      x: unit(input.x), y: unit(input.y),
      author: author(input.author),
      body,
      status: "open",
      askAgent: !!input.askAgent,
      replies: [],
      createdAt: now, updatedAt: now,
    };
    // The number is allocated outside the undo diff so an undone note never frees its number for
    // reuse: numbers are cited in chat and must stay unique for the life of the board.
    await this.state.storage.put("meta", { ...meta, nextCommentNumber: meta.nextCommentNumber + 1 });
    await this.#commit([{ key: "comment:" + comment.id, before: undefined, after: comment }]);
    return comment;
  }

  async replyToComment(commentId, input = {}) {
    const { key, before } = await this.#comment(commentId);
    const body = str(input.body, LIMITS.text);
    if (!body) throw new Error("A reply needs a body.");
    if (before.replies.length >= LIMITS.replies) throw new Error("This thread is full.");
    const now = new Date().toISOString();
    const reply = { id: genId(), author: author(input.author), body, createdAt: now };
    const after = { ...before, replies: [...before.replies, reply], updatedAt: now };
    await this.#commit([{ key, before, after }]);
    return reply;
  }

  async updateComment(commentId, patch = {}) {
    const { key, before } = await this.#comment(commentId);
    const after = { ...before, updatedAt: new Date().toISOString() };
    if (patch.body !== undefined) after.body = str(patch.body, LIMITS.text) || before.body;
    if (patch.askAgent !== undefined) after.askAgent = !!patch.askAgent;
    await this.#commit([{ key, before, after }]);
    return after;
  }

  async setCommentStatus(commentId, status, by) {
    const { key, before } = await this.#comment(commentId);
    const next = status === "resolved" ? "resolved" : "open";
    if (before.status === next) return before;
    const now = new Date().toISOString();
    const after = { ...before, status: next, updatedAt: now };
    if (next === "resolved") { after.resolvedAt = now; after.resolvedBy = author(by); }
    else { delete after.resolvedAt; delete after.resolvedBy; }
    await this.#commit([{ key, before, after }]);
    return after;
  }

  async moveComment(commentId, position = {}) {
    const { key, before } = await this.#comment(commentId);
    const after = { ...before, x: unit(position.x, before.x), y: unit(position.y, before.y) };
    if (position.frameId && position.frameId !== before.frameId) {
      const frame = await this.state.storage.get("frame:" + String(position.frameId));
      if (frame) after.frameId = frame.id;
    }
    await this.#commit([{ key, before, after }]);
    return after;
  }

  async deleteComment(commentId) {
    const { key, before } = await this.#comment(commentId);
    await this.#commit([{ key, before, after: undefined }]);
    return true;
  }

  // ----------------------------------------------------------------- meta --

  async updateMeta(patch = {}) {
    await this.#ensureSeeded();
    const before = await this.state.storage.get("meta");
    const after = { ...before };
    if (patch.title !== undefined) after.title = str(patch.title, LIMITS.title) || before.title;
    if (patch.client !== undefined) after.client = str(patch.client, LIMITS.title);
    if (patch.round !== undefined) after.round = str(patch.round, LIMITS.title);
    await this.#commit([{ key: "meta", before, after }]);
    return after;
  }

  async resetAll() {
    await this.state.storage.deleteAll();
    this.undoStack = []; this.redoStack = []; this.undoBytes = 0;
    await this.#seed();
    const board = await this.getBoard();
    await this.#broadcast({ type: "reset", board, undo: this.#undoState() });
    return board;
  }

  // ------------------------------------------------------------ undo/redo --

  async undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.undoBytes -= entry.bytes;
    const changes = await this.#applyEntry(entry, "before");
    this.redoStack.push(entry);
    this.#broadcastChanges(changes);
    return true;
  }

  async redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const changes = await this.#applyEntry(entry, "after");
    this.undoStack.push(entry);
    this.undoBytes += entry.bytes;
    this.#broadcastChanges(changes);
    return true;
  }

  // ------------------------------------------------------------- realtime --

  /**
   * Subscribe to board changes and presence. `client` is { clientId, name, color, id? } — the
   * caller's self-description (display only). Returns { token, board }; call ping(token) to check
   * the subscription survived a reconnect, and subscribe again when it did not.
   */
  async subscribe(callback, client = {}) {
    const dup = callback.dup();
    const info = {
      token: genId() + genId(),
      clientId: String(client.clientId || genId()),
      userId: client.id ? String(client.id).slice(0, 200) : null,
      name: String(client.name || "Guest").slice(0, LIMITS.name),
      color: color(client.color),
    };
    const existing = [...this.subscribers.values()];
    this.subscribers.set(dup, info);
    dup.onRpcBroken(() => {
      this.subscribers.delete(dup);
      this.#broadcastPresence({ type: "leave", clientId: info.clientId, at: Date.now() });
    });
    queueMicrotask(async () => {
      for (const person of existing) {
        try {
          await dup.presence({ type: "join", clientId: person.clientId, name: person.name,
            color: person.color, at: Date.now() });
        } catch (e) { break; }
      }
      await this.#broadcastPresence({ type: "join", clientId: info.clientId, name: info.name,
        color: info.color, at: Date.now() });
    });
    return { token: info.token, board: await this.getBoard() };
  }

  async ping(token) {
    for (const info of this.subscribers.values()) if (info.token === token) return true;
    return false;
  }

  async updatePresence(presence = {}) {
    if (presence.rename) {
      // The viewer's name resolved after they subscribed (the shell learns it asynchronously);
      // update the roster so later joiners are seeded with the right name, then re-announce.
      for (const info of this.subscribers.values()) {
        if (info.clientId !== String(presence.clientId || "")) continue;
        info.name = String(presence.name || "Guest").slice(0, LIMITS.name);
        info.color = color(presence.color);
        await this.#broadcastPresence({ type: "join", clientId: info.clientId, name: info.name, color: info.color, at: Date.now() });
      }
      return;
    }
    await this.#broadcastPresence({
      type: "cursor",
      clientId: String(presence.clientId || ""),
      name: String(presence.name || "Guest").slice(0, LIMITS.name),
      color: color(presence.color),
      frameId: presence.frameId ? String(presence.frameId) : null,
      x: unit(presence.x), y: unit(presence.y),
      mode: String(presence.mode || "select").slice(0, 12),
      at: Date.now(),
    });
  }

  async leavePresence(clientId) {
    await this.#broadcastPresence({ type: "leave", clientId: String(clientId || ""), at: Date.now() });
  }

  async listPresence() {
    return [...this.subscribers.values()].map(p => ({ clientId: p.clientId, name: p.name, color: p.color }));
  }

  // -------------------------------------------------------------- private --

  async #comment(commentId) {
    await this.#ensureSeeded();
    const key = "comment:" + String(commentId);
    const before = await this.state.storage.get(key);
    if (!before) throw new Error("No such comment: " + commentId);
    return { key, before };
  }

  async #ensureSeeded() {
    const meta = await this.state.storage.get("meta");
    if (!meta || meta.schema !== SCHEMA) await this.#seed();
  }

  async #seed() {
    const now = new Date().toISOString();
    const seed = seedBoard(now);
    await this.state.storage.put("meta", seed.meta);
    await this.state.storage.put("order", seed.frames.map(f => f.id));
    for (const f of seed.frames) await this.state.storage.put("frame:" + f.id, f);
    for (const c of seed.comments) await this.state.storage.put("comment:" + c.id, c);
  }

  /** ops: [{ key, before, after }] with full values; `undefined` means absent. */
  async #commit(ops) {
    for (const op of ops) {
      if (op.after === undefined) await this.state.storage.delete(op.key);
      else await this.state.storage.put(op.key, op.after);
    }
    this.#pushUndo(ops);
    this.redoStack = [];
    this.#broadcastChanges(ops);
  }

  /**
   * Undo entries keep only what an update changed: a create or delete stores the whole object once,
   * an update stores the changed fields before and after (`undefined` = field absent). Applying a
   * patch merges onto the object's *current* state, so undoing an old move does not revert edits
   * that landed since. The stack is bounded by count and by bytes.
   */
  #pushUndo(ops) {
    const compact = ops.map(op => {
      if (isObject(op.before) && isObject(op.after)) {
        const diff = diffObjects(op.before, op.after);
        return { key: op.key, kind: "patch", patchBefore: diff.before, patchAfter: diff.after };
      }
      return { key: op.key, kind: "set", before: op.before, after: op.after };
    });
    const entry = { ops: compact, bytes: jsonSize(compact) };
    this.undoStack.push(entry);
    this.undoBytes += entry.bytes;
    while (this.undoStack.length > MAX_UNDO || (this.undoBytes > MAX_UNDO_BYTES && this.undoStack.length > 1)) {
      this.undoBytes -= this.undoStack.shift().bytes;
    }
  }

  /** Applies an undo entry in one direction; returns [{ key, before, after }] for broadcasting. */
  async #applyEntry(entry, direction) {
    const changes = [];
    for (const op of entry.ops) {
      const current = await this.state.storage.get(op.key);
      let next;
      if (op.kind === "patch") {
        // The object may have been deleted by a later commit; then there is nothing to patch.
        if (current === undefined) continue;
        next = applyPatch(current, direction === "before" ? op.patchBefore : op.patchAfter);
      } else {
        next = direction === "before" ? op.before : op.after;
      }
      if (next === undefined) await this.state.storage.delete(op.key);
      else await this.state.storage.put(op.key, next);
      changes.push({ key: op.key, before: current, after: next });
    }
    return changes;
  }

  /**
   * Turns key changes into events and hands every event of this batch to each subscriber
   * synchronously, so two overlapping commits cannot interleave their events for a client.
   * Failures are collected afterwards; a broken stub is dropped.
   */
  #broadcastChanges(changes) {
    const undo = this.#undoState();
    const events = [];
    for (const { key, before, after } of changes) {
      if (key.startsWith("frame:")) {
        const id = key.slice(6);
        if (after === undefined) events.push({ type: "frameRemoved", id });
        else if (before === undefined) events.push({ type: "frame", frame: after });
        else {
          const diff = diffObjects(before, after);
          const patch = {}, unset = [];
          for (const k of Object.keys(diff.after)) {
            if (diff.after[k] === undefined) unset.push(k); else patch[k] = diff.after[k];
          }
          events.push({ type: "frame", id, patch, unset, version: after.version });
        }
      } else if (key.startsWith("comment:")) {
        events.push(after === undefined ? { type: "commentRemoved", id: key.slice(8) } : { type: "comment", comment: after });
      } else if (key === "order") {
        events.push({ type: "order", order: after || [] });
      } else if (key === "meta") {
        events.push({ type: "meta", meta: after });
      }
    }
    if (events.length === 0) return;
    for (const [stub] of this.subscribers) {
      const calls = events.map(event => Promise.resolve(stub.change({ ...event, undo })));
      Promise.all(calls).catch(() => this.subscribers.delete(stub));
    }
  }

  async #broadcast(event) {
    const calls = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.change(event)).catch(() => this.subscribers.delete(stub)));
    }
    await Promise.all(calls);
  }

  async #broadcastPresence(event) {
    const calls = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.presence(event)).catch(() => this.subscribers.delete(stub)));
    }
    await Promise.all(calls);
  }

  #undoState() {
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }
}

// ------------------------------------------------------------------ helpers --

function genId() { return crypto.randomUUID().slice(0, 8); }

function str(value, max) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, max);
}

/** Like str() but refuses over-long input instead of silently clipping it. */
function bounded(value, max, what) {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (s.length > max) throw new Error(`${what} is too large (${s.length.toLocaleString()} characters; the limit is ${max.toLocaleString()}).`);
  return s;
}

function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function jsonSize(value) {
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function assertFrameSize(frame) {
  const bytes = jsonSize(frame);
  if (bytes > MAX_FRAME_BYTES) {
    throw new Error(`This frame is too large to store (${(bytes / 1_000_000).toFixed(1)} MB; the limit is ${(MAX_FRAME_BYTES / 1_000_000).toFixed(1)} MB). Move images into their own frames or reduce their size.`);
  }
}

/** Shallow field diff. `undefined` on a side means the field is absent there. */
function diffObjects(before, after) {
  const b = {}, a = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const x = before[k], y = after[k];
    if (x === y) continue;
    if (typeof x !== "object" && typeof y !== "object" && x === y) continue;
    if (typeof x === "object" && typeof y === "object" && x !== null && y !== null && JSON.stringify(x) === JSON.stringify(y)) continue;
    b[k] = x; a[k] = y;
  }
  return { before: b, after: a };
}

function applyPatch(current, patch) {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k]; else next[k] = v;
  }
  return next;
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function unit(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function author(value) {
  if (!value || typeof value !== "object") return { id: null, name: "Guest" };
  return {
    id: value.id ? String(value.id).slice(0, 200) : null,
    name: String(value.name || "Guest").slice(0, LIMITS.name),
  };
}

function color(value) {
  const s = String(value || "");
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : "#191f76";
}

function dataUri(value) {
  const s = bounded(value, LIMITS.src, "Image data");
  if (!s) return "";
  if (!/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(s) &&
      !/^data:image\/svg\+xml[;,]/i.test(s)) {
    throw new Error("Image frames take an inlined data: URI (PNG, JPEG, GIF, WebP or SVG).");
  }
  return s;
}

function defaultTitle(kind, n) {
  return { image: "Export", html: "Screen", board: "Board" }[kind] + " " + n;
}

const BLOCK_TYPES = new Set(["text", "heading", "rect", "image", "button", "note"]);

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.slice(0, LIMITS.blocks).map(b => {
    const type = BLOCK_TYPES.has(b?.type) ? b.type : "text";
    const props = (b && typeof b.props === "object" && b.props) ? { ...b.props } : {};
    if (props.text !== undefined) props.text = str(props.text, LIMITS.text);
    if (props.src !== undefined) props.src = props.src ? dataUri(props.src) : "";
    return {
      id: (b && b.id) ? String(b.id).slice(0, 16) : genId(),
      type,
      x: clampInt(b?.x, -20000, 20000, 0),
      y: clampInt(b?.y, -20000, 20000, 0),
      w: clampInt(b?.w, 8, 8000, 240),
      h: clampInt(b?.h, 8, 8000, 48),
      props,
    };
  });
}

// ---------------------------------------------------------------- seeding --

function seedBoard(now) {
  const welcome = {
    id: "welcome1", title: "Welcome", kind: "html",
    x: 0, y: 0, width: 1200, height: 760, version: 1, createdAt: now, updatedAt: now,
    html: WELCOME_HTML,
  };
  const sketch = {
    id: "sketch01", title: "Onboarding · first pass", kind: "board",
    x: 1320, y: 0, width: 1200, height: 760, version: 1, createdAt: now, updatedAt: now,
    blocks: [
      { id: "b1", type: "rect", x: 0, y: 0, w: 1200, h: 760,
        props: { fill: "#F5F1E6", radius: 0, stroke: "" } },
      { id: "b2", type: "heading", x: 96, y: 120, w: 620, h: 140,
        props: { text: "Set up your workspace in three steps.", size: 48, color: "#0f1115", align: "left" } },
      { id: "b3", type: "text", x: 96, y: 300, w: 520, h: 96,
        props: { text: "A short, plain-language explanation of what happens next. Two sentences at most, so the button below stays the obvious move.", size: 18, color: "#5a5d63", align: "left" } },
      { id: "b4", type: "button", x: 96, y: 428, w: 200, h: 52,
        props: { text: "Get started", fill: "#191f76", color: "#ffffff", radius: 999 } },
      { id: "b5", type: "rect", x: 780, y: 96, w: 324, h: 560,
        props: { fill: "#ffffff", radius: 24, stroke: "#e5e5e8" } },
      { id: "b6", type: "text", x: 812, y: 132, w: 260, h: 40,
        props: { text: "Preview panel", size: 14, color: "#5a5d63", align: "left" } },
      { id: "b7", type: "note", x: 812, y: 196, w: 260, h: 120,
        props: { text: "Placeholder for the live preview. Ask the agent to fill this in from the real product screens.", color: "#0f1115" } },
    ],
  };
  const comments = [
    {
      id: "c0000001", number: 1, frameId: "sketch01", x: 0.31, y: 0.19,
      author: { id: null, name: "Thoughtful Agency" },
      body: "Headline reads well. Try one shorter alternative that still names the outcome, then ask the agent for two more.",
      status: "open", askAgent: true, replies: [], createdAt: now, updatedAt: now,
    },
  ];
  return {
    meta: { schema: SCHEMA, title: "Design Review", client: "", round: "Round 1",
      nextCommentNumber: 2, createdAt: now },
    frames: [welcome, sketch],
    comments,
  };
}

const WELCOME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  .screen-root { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #0f1115; background: #ffffff; width: 1200px; min-height: 760px; box-sizing: border-box; padding: 72px 96px; }
  .eyebrow { font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #191f76; margin: 0 0 20px; }
  h1 { font-family: "Instrument Serif", Georgia, "Times New Roman", serif; font-weight: 400; font-size: 64px; line-height: 1.02; letter-spacing: -0.03em; margin: 0 0 28px; max-width: 820px; }
  p { font-size: 18px; line-height: 1.55; color: #5a5d63; max-width: 640px; margin: 0 0 18px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 44px; }
  .card { border: 1px solid #e5e5e8; border-radius: 20px; padding: 24px; background: #F8F8F8; }
  .card b { display: block; font-size: 15px; margin-bottom: 8px; color: #0f1115; }
  .card span { font-size: 14px; line-height: 1.5; color: #5a5d63; }
  kbd { display: inline-block; border: 1px solid #e5e5e8; border-radius: 6px; padding: 1px 7px; font-size: 12px; font-family: inherit; background: #fff; color: #191f76; font-weight: 600; }
  .wordmark { position: absolute; right: 96px; top: 72px; font-weight: 600; letter-spacing: -0.03em; font-size: 18px; color: #0f1115; }
  .wordmark i { display: inline-block; width: 6px; height: 6px; border-radius: 999px; background: #191f76; margin-left: 5px; vertical-align: middle; }
</style></head><body><div class="screen-root" style="position:relative">
  <div class="wordmark">thoughtful agency<i></i></div>
  <p class="eyebrow">Design review</p>
  <h1>Pin a note where it belongs. Let the agent do the rework.</h1>
  <p>Drop Figma exports or agent-built screens onto this board. Anyone on the team can leave a numbered note, tweak copy in place, and flag a thread for the agent. Open threads become the brief for the next pass.</p>
  <div class="grid">
    <div class="card"><b><kbd>C</kbd> Comment</b><span>Click anywhere on a frame to drop a numbered pin and start a thread. Resolve it when the change lands.</span></div>
    <div class="card"><b><kbd>E</kbd> Edit</b><span>Edit copy directly on screens and move or restyle blocks on boards. Every change syncs live for the whole team.</span></div>
    <div class="card"><b><kbd>A</kbd> Ask the agent</b><span>Flag a thread, then tell the chat “apply the open comments on frame 2”. The agent reads the thread, edits the frame and replies.</span></div>
  </div>
</div></body></html>`;

// ---------------------------------------------------------------- export --

const EXPORT_FORMATS = [
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
  { id: "png", label: "PNG (board)", mode: "browser", contentType: "image/png", fileExtension: ".png" },
  { id: "summary", label: "Review summary (Markdown)", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return EXPORT_FORMATS;
  }

  async export(gadget, id) {
    if (id === "summary") {
      const text = await gadget.getReviewSummary({ status: "all" });
      return new Blob([text], { type: "text/markdown" }).stream();
    }
    throw new Error("Unsupported design review export format: " + id);
  }
}
