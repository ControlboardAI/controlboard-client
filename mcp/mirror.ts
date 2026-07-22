// ControlBoard local mirror (client side of real-time sync).
//
// Opens a WebSocket to <BASE>/api/v1/socket, authenticates with the API key, and
// keeps a live in-memory copy of the board(s) by applying the server's deltas.
// The point: an agent stays in sync without polling, and can wait for changes
// (the "status flag") so it re-reads only when something it cares about moved.
//
// The socket carries machine bytes, not model context — staying synced is free.
// Reads/writes still go over REST in the MCP tools; this mirror powers the
// sync_status + wait_for_change tools and tracks a monotonic change cursor.
//
// Graceful by design: if the WebSocket global is missing (old Node) or the
// socket can't connect, the mirror stays "disconnected" and the REST tools are
// unaffected. Reconnects with capped backoff; re-snapshots on a version gap.

interface MirrorBoard {
  notes: Map<string, Record<string, unknown>>;
  frames: Map<string, Record<string, unknown>>;
  version: number;
}

export interface ChangeEvent {
  seq: number; // monotonic cursor across all workspaces
  at: number; // epoch ms
  project: string; // workspaceId
  version: number; // the workspace version after this change
  changed: string[]; // upserted task (note) ids (empty when resnapshot)
  removed: string[]; // removed task (note) ids (empty when resnapshot)
  // When true the precise ids are unknown (a gap/initial sync caught up via a
  // full snapshot): treat it as "something moved in this project, re-read it".
  resnapshot?: boolean;
}

interface Waiter {
  sinceSeq: number;
  project?: string;
  resolve: (events: ChangeEvent[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MirrorStatus {
  connected: boolean;
  subscribe: string | string[];
  cursor: number;
  lastChangeAt: number | null;
  workspaces: { id: string; version: number; tasks: number }[];
  recent: ChangeEvent[];
}

const RECENT_MAX = 500;

export class BoardMirror {
  private base: string;
  private key: string;
  private project: string; // "" = all the user's workspaces

  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private reconnectDelay = 1000;

  private boards = new Map<string, MirrorBoard>();
  private snapshotting = new Set<string>(); // workspaces with a snapshot in flight
  private maxSeen = new Map<string, number>(); // highest delta version seen per ws
  private recent: ChangeEvent[] = [];
  private waiters: Waiter[] = [];
  private seq = 0;
  private lastChangeAt: number | null = null;

  constructor(opts: { base: string; key: string; project?: string }) {
    this.base = opts.base;
    this.key = opts.key;
    this.project = (opts.project || "").trim();
  }

  // Whether real-time sync is even possible in this runtime.
  static available(): boolean {
    return typeof WebSocket !== "undefined";
  }

  start(): void {
    if (this.stopped || !BoardMirror.available()) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  private wsUrl(): string {
    return this.base.replace(/^http/, "ws") + "/api/v1/socket";
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ t: "hello", key: this.key, subscribe: this.project ? [this.project] : "*" }));
      } catch {
        /* the close handler will reconnect */
      }
    };
    ws.onmessage = (ev) => {
      this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* onclose schedules the reconnect */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 30000); // cap backoff at 30s
    const t = setTimeout(() => this.connect(), delay);
    t.unref?.();
  }

  // Synchronous + fully guarded: a malformed frame or unexpected shape must never
  // reject (this runs fire-and-forget from ws.onmessage and would otherwise crash
  // the MCP stdio process).
  private onMessage(raw: string): void {
    try {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === "welcome") {
        this.connected = true;
        this.reconnectDelay = 1000;
        const wss = Array.isArray(msg.workspaces) ? (msg.workspaces as { id: string }[]) : [];
        const versions = (msg.versions as Record<string, number>) || {};
        const ids = this.project ? [this.project] : wss.map((w) => w.id);
        for (const id of ids) {
          const v = versions[id] ?? 0;
          this.maxSeen.set(id, Math.max(this.maxSeen.get(id) ?? 0, v));
          const have = this.boards.get(id);
          if (!have || have.version < v) this.requestSnapshot(id);
        }
      } else if (msg.t === "delta") {
        this.applyDelta(msg as unknown as ChangeDelta);
      } else if (msg.t === "workspaces" && !this.project) {
        const wss = Array.isArray(msg.workspaces) ? (msg.workspaces as { id: string }[]) : [];
        for (const w of wss) if (!this.boards.has(w.id)) this.requestSnapshot(w.id);
      }
    } catch (e) {
      try {
        console.error("[controlboard-mcp] sync error:", (e as Error)?.message || e);
      } catch {
        /* ignore */
      }
    }
  }

  // Serialize snapshots per workspace: at most one in flight, and if deltas
  // advanced past the version we fetched, snapshot again until caught up. This
  // closes the window where deltas arriving during an in-flight snapshot would
  // be lost when the snapshot overwrote the board.
  private requestSnapshot(id: string): void {
    if (this.snapshotting.has(id)) return; // one in flight; it re-checks on resolve
    this.snapshotting.add(id);
    void this.runSnapshot(id);
  }

  private async runSnapshot(id: string): Promise<void> {
    try {
      await this.snapshot(id);
    } finally {
      this.snapshotting.delete(id);
    }
    const b = this.boards.get(id);
    if (b && (this.maxSeen.get(id) ?? 0) > b.version) this.requestSnapshot(id);
  }

  private async snapshot(id: string): Promise<void> {
    try {
      const res = await fetch(`${this.base}/api/v1/board?project=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${this.key}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { board?: { notes?: AnyNote[]; frames?: AnyNote[] }; version?: number };
      const board = data.board || {};
      const b: MirrorBoard = { notes: new Map(), frames: new Map(), version: data.version ?? 0 };
      for (const n of board.notes || []) b.notes.set(String(n.id), n);
      for (const f of board.frames || []) b.frames.set(String(f.id), f);
      this.boards.set(id, b);
    } catch {
      /* leave untracked; a later delta gap (or runSnapshot retry) re-fetches */
    }
  }

  private applyDelta(d: ChangeDelta): void {
    const id = d.workspaceId;
    const version = typeof d.version === "number" ? d.version : 0;
    this.maxSeen.set(id, Math.max(this.maxSeen.get(id) ?? 0, version));

    const b = this.boards.get(id);
    let resnapshot = false;
    if (!b || version > b.version + 1) {
      // Untracked or a gap: catch up via a (serialized) snapshot rather than
      // applying a partial/stale delta. The snapshot is the source of truth for
      // what changed, so this event is signal-only (re-read the project).
      resnapshot = true;
      this.requestSnapshot(id);
    } else {
      // In-order delta: apply directly. (Assumes in-order delivery per the
      // server contract; Math.max only guards an equal-version replay.)
      for (const n of d.notes || []) b.notes.set(String(n.id), n);
      for (const rid of d.removedNotes || []) b.notes.delete(rid);
      for (const f of d.frames || []) b.frames.set(String(f.id), f);
      for (const rid of d.removedFrames || []) b.frames.delete(rid);
      b.version = Math.max(b.version, version);
    }

    // An in-order delta with no note/frame changes (e.g. a status-column-only
    // write) carries nothing for this note/frame mirror — advance the version
    // silently rather than wake waiters with an empty event. (Status config is
    // always re-read fresh via list_statuses.)
    const touched =
      (d.notes?.length || 0) + (d.removedNotes?.length || 0) +
      (d.frames?.length || 0) + (d.removedFrames?.length || 0);
    if (!resnapshot && touched === 0) return;

    const ev: ChangeEvent = {
      seq: ++this.seq,
      at: Date.now(),
      project: id,
      version,
      changed: resnapshot ? [] : (d.notes || []).map((n) => String(n.id)),
      removed: resnapshot ? [] : d.removedNotes || [],
      ...(resnapshot ? { resnapshot: true } : {}),
    };
    this.lastChangeAt = ev.at;
    this.recent.push(ev);
    if (this.recent.length > RECENT_MAX) this.recent.shift();
    this.notifyWaiters();
  }

  private notifyWaiters(): void {
    if (!this.waiters.length) return;
    const remaining: Waiter[] = [];
    for (const w of this.waiters) {
      const events = this.recent.filter((e) => e.seq > w.sinceSeq && (!w.project || e.project === w.project));
      if (events.length) {
        clearTimeout(w.timer);
        w.resolve(events);
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
  }

  status(): MirrorStatus {
    const workspaces = Array.from(this.boards.entries()).map(([id, b]) => ({
      id,
      version: b.version,
      tasks: b.notes.size,
    }));
    return {
      connected: this.connected,
      subscribe: this.project || "*",
      cursor: this.seq,
      lastChangeAt: this.lastChangeAt,
      workspaces,
      recent: this.recent.slice(-20),
    };
  }

  // Resolve with changes newer than `sinceSeq` (immediately if some already
  // exist), else block until the next matching change or the timeout.
  waitForChange(opts: { sinceSeq?: number; project?: string; timeoutMs?: number }): Promise<ChangeEvent[]> {
    const sinceSeq = typeof opts.sinceSeq === "number" ? opts.sinceSeq : this.seq;
    const project = opts.project || undefined;
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 25000, 1000), 55000);

    // Caller's cursor fell behind the retained window — we can't enumerate what
    // they missed, so tell them to re-snapshot instead of waiting and then
    // falsely reporting "idle".
    const oldest = this.recent.length ? this.recent[0].seq : 0;
    if (this.recent.length >= RECENT_MAX && sinceSeq < oldest) {
      return Promise.resolve([
        { seq: this.seq, at: Date.now(), project: project ?? "", version: 0, changed: [], removed: [], resnapshot: true },
      ]);
    }

    const already = this.recent.filter((e) => e.seq > sinceSeq && (!project || e.project === project));
    if (already.length) return Promise.resolve(already);

    return new Promise((resolve) => {
      const w: Waiter = {
        sinceSeq,
        project,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve([]);
        }, timeoutMs),
      };
      w.timer.unref?.();
      this.waiters.push(w);
    });
  }
}

type AnyNote = Record<string, unknown> & { id: string };
interface ChangeDelta {
  workspaceId: string;
  version: number;
  notes?: AnyNote[];
  removedNotes?: string[];
  frames?: AnyNote[];
  removedFrames?: string[];
}
