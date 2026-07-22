// ControlBoard MCP server (stdio).
//
// Lets an AI agent (Claude Code, Codex, Open Claude, etc.) read and manage a
// user's ControlBoard via their personal API key. Talks to the production REST
// API at CONTROLBOARD_URL using Authorization: Bearer <CONTROLBOARD_API_KEY>.
//
// Run:  CONTROLBOARD_API_KEY=cbk_... node controlboard-mcp.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BoardMirror } from "./mirror";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Config written by `cb login` (device flow), shared across all of this user's
// projects on this machine.
interface CliConfig {
  project?: string;
  default?: string;
  agents?: Record<string, { agentId?: string; key?: string }>;
  key?: string;
}
function readCliConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".config", "controlboard", "config.json"), "utf8"));
  } catch {
    return {};
  }
}
const cliCfg = readCliConfig();
// Pick this agent's key: CONTROLBOARD_AGENT selects by name; else the saved
// default; else the sole agent; else the legacy single-agent key. When
// CONTROLBOARD_AGENT names an agent that isn't connected, resolve empty rather
// than fall through to another identity's key — fail loud, don't act as someone else.
function configKey(c: CliConfig): string {
  const want = process.env.CONTROLBOARD_AGENT;
  if (want) return c.agents?.[want]?.key || "";
  if (c.default && c.agents?.[c.default]?.key) return c.agents[c.default]!.key!;
  const withKeys = c.agents ? Object.keys(c.agents).filter((l) => c.agents![l]?.key) : [];
  if (withKeys.length === 1) return c.agents![withKeys[0]]!.key!;
  return c.key || "";
}

const BASE = (process.env.CONTROLBOARD_URL || "https://controlboard.ai").replace(/\/+$/, "");
// Key resolution: env wins, else the per-agent home config saved by `cb login`.
const KEY = process.env.CONTROLBOARD_API_KEY || configKey(cliCfg);
// Optional: scope every call to a specific project (workspace). Omit for the
// user's default. Discover ids with the list_projects tool.
const PROJECT = (process.env.CONTROLBOARD_PROJECT || cliCfg.project || "").trim();

if (!KEY) {
  console.error(
    "[controlboard-mcp] No API key. Run `cb login` (browser login; saved to " +
      "~/.config/controlboard/config.json) or set CONTROLBOARD_API_KEY. Create keys at " +
      BASE +
      "/app.",
  );
  process.exit(1);
}

// A background mirror failure must never take down the stdio server (stdout is
// the MCP protocol, so log to stderr only).
process.on("unhandledRejection", (reason) => {
  try {
    console.error("[controlboard-mcp] unhandledRejection:", (reason as Error)?.message || reason);
  } catch {
    /* ignore */
  }
});

// Real-time sync: keep a live local mirror of the board(s) over a WebSocket so
// the agent can wait for changes instead of polling. On by default; set
// CONTROLBOARD_SYNC=0 to disable (the REST tools work either way). Reads/writes
// still go over REST; the mirror powers sync_status + wait_for_change.
const mirror = new BoardMirror({ base: BASE, key: KEY, project: PROJECT });
if (process.env.CONTROLBOARD_SYNC !== "0") mirror.start();

async function api(method: string, path: string, body?: unknown): Promise<any> {
  let url = `${BASE}/api/v1${path}`;
  if (PROJECT) url += (url.includes("?") ? "&" : "?") + "project=" + encodeURIComponent(PROJECT);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`ControlBoard API ${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const COLORS = ["#ffd166", "#ef476f", "#06d6a0", "#a78bfa", "#fff8e7", "#38bdf8", "#fb7185", "#6ee7b7"];
// Statuses are per-workspace custom columns (discover them with list_statuses).
// A status value may be a status id, its display name, or a role keyword.
const STATUS_HINT =
  "status — a status id, its display name (see list_statuses), or a role keyword (proposed|backlog|active|blocked|done). Statuses are customizable per project.";
const STATUS_ROLES = ["proposed", "backlog", "active", "blocked", "done"];
const PRIORITIES = ["p1", "p2", "p3"];
const EFFORTS = ["s", "m", "l"];
const LINK_KINDS = ["url", "pr", "issue", "file", "doc"];

const qs = (params: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  run: (args: any) => Promise<unknown>;
}

const tools: Tool[] = [
  {
    name: "get_me",
    description: "Get the authenticated ControlBoard user + your own actor identity (verifies the API key works).",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/me"),
  },
  {
    name: "list_agents",
    description: "List the registered agents you can assign work to, plus your own identity (`me`). Each agent is assignable as `assignee: 'agent:<slug>'`; the human owner is `assignee: 'me'`; agents with a crew form pools assignable as `assignee: 'crew:<name>'`. Each agent also carries its default `model` and a self-reported `usage` snapshot with `usageAt` — use remaining quota to route work to whoever has headroom. Call this to discover teammates and crews before assigning an item or dependency.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/agents"),
  },
  {
    name: "list_projects",
    description: "List the user's projects (workspaces) with id, name, color, and description. To work in a specific project, set CONTROLBOARD_PROJECT=<id> in this server's env; otherwise all calls target the default project.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/projects"),
  },
  {
    name: "create_project",
    description: "Create a new project (an independent board). Returns its id — set CONTROLBOARD_PROJECT=<id> (or pass ?project=<id> via REST) to target it.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        color: { type: "string", enum: COLORS },
      },
    },
    run: (a) => api("POST", "/projects", a),
  },
  {
    name: "get_board",
    description: "Get the entire board: all items, all frames, and the canvas viewport.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/board"),
  },
  {
    name: "list_items",
    description: "List all items (each has id, title, content, status, color, x, y, width, height, frameId, date, time). An item is the universal unit of work — the same item appears on the canvas, the Kanban board, and the timeline.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/notes"),
  },
  {
    name: "create_item",
    description: "Create an item (the universal unit: shows on the canvas, Kanban, and timeline). Optionally place it in a frame via frameId, set a date (YYYY-MM-DD) to show it on the timeline, and set task fields (status/priority/assignee/effort). Assign it with assignee: 'me' (the owner), 'agent:<slug>' (another registered agent — discover them with list_agents), or your own agent slug.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        color: { type: "string", enum: COLORS },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM" },
        done: { type: "boolean", description: "true = completed (text shown struck through)" },
        archived: { type: "boolean", description: "true = archived (hidden from board)" },
        status: { type: "string", description: STATUS_HINT },
        priority: { type: "string", enum: PRIORITIES, description: "p1 (highest) .. p3" },
        assignee: { type: "string", description: "owner: 'me', 'agent:<slug>' (see list_agents), or 'crew:<name>' (any member of that crew may claim it)" },
        rationale: { type: "string", description: "why this assignee — recorded as a comment for them to read" },
        rank: { type: "number", description: "explicit queue position; lower runs sooner" },
        effort: { type: "string", enum: EFFORTS, description: "rough size: s/m/l" },
        blockedBy: { type: "array", items: { type: "string" }, description: "ids of items that must be done before this one is ready" },
        frameId: { type: "string", description: "id of a frame to place the item in" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
    run: (a) => api("POST", "/notes", a),
  },
  {
    name: "update_item",
    description: "Update any field of an item. Set frameId to move it into a frame; set frameId to null to remove it from its frame. Reassign with assignee ('me' | 'agent:<slug>' | null).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        color: { type: "string", enum: COLORS },
        date: { type: "string" },
        time: { type: "string" },
        done: { type: "boolean", description: "true = completed (text shown struck through)" },
        archived: { type: "boolean", description: "true = archived (hidden from board); false = restore" },
        status: { type: "string", description: STATUS_HINT },
        priority: { type: "string", enum: PRIORITIES, description: "p1 (highest) .. p3" },
        assignee: { type: "string", description: "owner: 'me', 'agent:<slug>' (see list_agents), or 'crew:<name>' (any member of that crew may claim it)" },
        effort: { type: "string", enum: EFFORTS, description: "rough size: s/m/l" },
        blockedBy: { type: "array", items: { type: "string" }, description: "ids of items that must be done first (replaces the list; [] clears)" },
        result: { type: "string", description: "output of a long-running task (≤8000 chars)" },
        rationale: { type: "string", description: "when changing assignee: WHY this assignee — recorded as a comment for them to read" },
        rank: { type: ["number", "null"], description: "explicit queue position; lower runs sooner, ranked beats unranked, null clears" },
        ifUpdatedAt: { type: "number", description: "optimistic lock: pass the updatedAt you read; the write is refused (409 stale_write, current task returned) if the task changed since — re-read, merge, retry" },
        frameId: { type: ["string", "null"] },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
    run: ({ id, ...patch }) => api("PATCH", `/notes/${encodeURIComponent(id)}`, patch),
  },
  {
    name: "delete_item",
    description:
      "Archive an item by id (hides it from the board and timeline). This is SAFE and RECOVERABLE — the owner can restore it from the Archived view; agents can never permanently delete an item. Equivalent to set_item_archived {archived:true}.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: ({ id }) => api("DELETE", `/notes/${encodeURIComponent(id)}`),
  },
  {
    name: "set_item_done",
    description: "Mark an item done or not done. done:true strikes its text through (and moves it to a 'done'-role status); done:false reopens it.",
    inputSchema: {
      type: "object",
      required: ["id", "done"],
      properties: { id: { type: "string" }, done: { type: "boolean" } },
    },
    run: ({ id, done }) => api("PATCH", `/notes/${encodeURIComponent(id)}`, { done: done === true }),
  },
  {
    name: "set_item_archived",
    description: "Archive an item (archived:true hides it from the board and timeline) or restore it (archived:false).",
    inputSchema: {
      type: "object",
      required: ["id", "archived"],
      properties: { id: { type: "string" }, archived: { type: "boolean" } },
    },
    run: ({ id, archived }) => api("PATCH", `/notes/${encodeURIComponent(id)}`, { archived: archived === true }),
  },
  // ── Program-manager task queue ─────────────────────────────────────────────
  {
    name: "list_tasks",
    description: "List tasks as a prioritized work queue (open first, then priority, due, age). Filter by status/priority/assignee or a text query; done tasks excluded unless includeDone. Token-lean by default: returns compact rows (id, title, status, and any of priority/assignee/due/effort/claimedBy/blockedBy that are set). Pass full:true for the detail shape, or fields:\"id,title,status\" for an exact subset. Use get_task for one task's full detail.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: STATUS_HINT },
        priority: { type: "string", enum: PRIORITIES },
        assignee: { type: "string", description: "owner, e.g. 'me', 'agent:<slug>', or 'crew:<name>'" },
        q: { type: "string", description: "substring match on title + content" },
        includeDone: { type: "boolean" },
        full: { type: "boolean", description: "return the full detail shape instead of compact rows" },
        fields: { type: "string", description: "comma-separated fields to return, e.g. 'id,title,status,priority'" },
      },
    },
    run: (a) => api("GET", `/tasks${qs(a)}`),
  },
  {
    name: "get_next_task",
    description: "Get the single highest-value ready task to work on (skips done/blocked and tasks actively claimed by someone else). Auto-scoped to YOU: unassigned tasks, tasks assigned to you, and your crew's pool ('crew:<name>'). Pass claim:true to atomically claim it so other agents skip it; assignee overrides the scope. Pass strict:true to take ONLY explicitly-assigned work (never unassigned) — required posture for unattended schedulers.",
    inputSchema: {
      type: "object",
      properties: {
        assignee: { type: "string", description: "override the auto scope: only tasks owned by this assignee (or unassigned)" },
        claim: { type: "boolean", description: "true = claim the returned task in the same call" },
        strict: { type: "boolean", description: "true = only tasks explicitly assigned to you/your crew; skip unassigned (scheduler-safe)" },
      },
    },
    run: (a) => api("GET", `/tasks/next${qs(a)}`),
  },
  {
    name: "get_task",
    description: "Fetch one task by id: its status, result, ready/openBlockers, and recent activity. Use to poll a long-running task you (or another agent) started. The response includes `activity`: the task's own change history (who did what, when) and the task carries updatedBy/updatedAt — read these BEFORE editing a task someone else touched.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: ({ id }) => api("GET", `/tasks/${encodeURIComponent(id)}`),
  },
  // ── Long-running work (SB-103): start now, fetch the result later ──────────
  {
    name: "start_task",
    description: "Start a long-running unit of work: creates a 'doing' task (claimed by you so peers skip it) and returns its id. Do the work, then call complete_task {id, result} when done. Anyone can get_task {id} to fetch status/result later.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        priority: { type: "string", enum: PRIORITIES },
        assignee: { type: "string", description: "owner, e.g. 'me', 'agent:<slug>', or 'crew:<name>'" },
      },
    },
    run: async (a) => {
      const created = await api("POST", "/tasks", { ...a, status: "doing" });
      const id = created?.task?.id;
      if (id) await api("POST", `/tasks/${encodeURIComponent(id)}/claim`).catch(() => {});
      return created;
    },
  },
  {
    name: "complete_task",
    description: "Mark a started task done and attach its result (the output of the long-running work). Releases the claim so it leaves the queue.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, result: { type: "string", description: "the work output (≤8000 chars)" } },
    },
    run: ({ id, result }) => api("PATCH", `/tasks/${encodeURIComponent(id)}`, { status: "done", result }),
  },
  {
    name: "claim_task",
    description: "Claim a task so other agents skip it (a soft lock that expires after 30 min). Fails with already_claimed if another actor holds a fresh claim. A backlog item advances to the first active-role status on claim.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: ({ id }) => api("POST", `/tasks/${encodeURIComponent(id)}/claim`),
  },
  {
    name: "release_task",
    description: "Release your claim on a task (e.g. you're blocked or handing it off) so it returns to the queue for others.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: ({ id }) => api("POST", `/tasks/${encodeURIComponent(id)}/release`),
  },
  {
    name: "set_task_status",
    description: "Move an item to a status — accepts a status id, its display name, or a role keyword (proposed|backlog|active|blocked|done). Statuses are per-project custom columns; list them with list_statuses. Moving to a 'done'-role status keeps the item's done flag in sync; moving off 'done' reopens it.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: { id: { type: "string" }, status: { type: "string", description: STATUS_HINT } },
    },
    run: ({ id, status }) => api("PATCH", `/notes/${encodeURIComponent(id)}`, { status }),
  },
  {
    name: "assign_task",
    description: "Assign an item to an owner. Valid owners: 'me' (the human owner), 'agent:<slug>' for any registered agent (including yourself), or null to unassign. Discover the available agents with list_agents first. You can assign items (and their dependencies) to yourself, to the user, or to another agent — coordinate work by assigning the right owner.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        assignee: { type: ["string", "null"], description: "'me' | 'agent:<slug>' | null" },
        rationale: { type: "string", description: "why this assignee — recorded as a comment for them to read" },
      },
    },
    run: ({ id, assignee, rationale }) => api("PATCH", `/notes/${encodeURIComponent(id)}`, { assignee: assignee ?? null, rationale }),
  },
  {
    name: "add_dependency",
    description: "Make a task depend on another (blockerId must be done before this task is 'ready' and offered by get_next_task). Self/unknown/cyclic blockers are rejected.",
    inputSchema: {
      type: "object",
      required: ["id", "blockerId"],
      properties: { id: { type: "string" }, blockerId: { type: "string", description: "the task that must finish first" } },
    },
    run: ({ id, blockerId }) => api("POST", `/tasks/${encodeURIComponent(id)}/blockers`, { blockerId }),
  },
  {
    name: "remove_dependency",
    description: "Remove a dependency: this task no longer waits on blockerId.",
    inputSchema: {
      type: "object",
      required: ["id", "blockerId"],
      properties: { id: { type: "string" }, blockerId: { type: "string" } },
    },
    run: ({ id, blockerId }) => api("DELETE", `/tasks/${encodeURIComponent(id)}/blockers/${encodeURIComponent(blockerId)}`),
  },
  {
    name: "list_activity",
    description: "Read the recent activity log — who (which human or agent) created, updated, claimed, or completed tasks. Pass task:<id> to scope to one task's history.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "only events at/after this epoch-ms timestamp" },
        limit: { type: "number", description: "max rows (default 50, max 200)" },
        task: { type: "string", description: "scope to a single task id" },
      },
    },
    run: (a) => api("GET", `/activity${qs(a)}`),
  },
  // ── Comments & context links ───────────────────────────────────────────────
  {
    name: "add_comment",
    description: "Add a comment to an item's discussion thread (visible to the human and other agents on the item).",
    inputSchema: {
      type: "object",
      required: ["id", "text"],
      properties: { id: { type: "string" }, text: { type: "string" } },
    },
    run: ({ id, text }) => api("POST", `/tasks/${encodeURIComponent(id)}/comments`, { text }),
  },
  {
    name: "link_context",
    description: "Attach an external context link (PR, issue, doc, file, or URL) to a task. kind is auto-detected from GitHub URLs if omitted.",
    inputSchema: {
      type: "object",
      required: ["id", "href"],
      properties: {
        id: { type: "string" },
        href: { type: "string", description: "the URL or path to attach" },
        kind: { type: "string", enum: LINK_KINDS },
        title: { type: "string", description: "optional human label for the link chip" },
      },
    },
    run: ({ id, ...body }) => api("POST", `/tasks/${encodeURIComponent(id)}/links`, body),
  },
  // ── Proposals & approval inbox (human-gated) ───────────────────────────────
  {
    name: "propose_task",
    description: "Propose a NEW task for the human to approve instead of creating it directly. Use this for work you think should be done but weren't explicitly asked to add. It appears only in the human's inbox until approved (then it becomes a real todo) or rejected.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        why: { type: "string", description: "why you're proposing this — shown to the human in the inbox" },
        priority: { type: "string", enum: PRIORITIES },
        assignee: { type: "string" },
        effort: { type: "string", enum: EFFORTS },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM" },
      },
    },
    run: (a) => api("POST", "/proposals", a),
  },
  {
    name: "list_inbox",
    description: "List pending task proposals awaiting the human's approval (newest first).",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/inbox"),
  },
  {
    name: "approve_task",
    description: "Approve a proposed task — it becomes a real 'todo' on the board. (Normally the human does this; available for agents acting on the owner's behalf.)",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: ({ id }) => api("POST", `/tasks/${encodeURIComponent(id)}/approve`),
  },
  {
    name: "reject_task",
    description: "Reject a proposed task — it is archived with an optional reason and leaves the inbox.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, reason: { type: "string" } },
    },
    run: ({ id, reason }) => api("POST", `/tasks/${encodeURIComponent(id)}/reject`, { reason }),
  },
  {
    name: "move_item_to_frame",
    description: "Move an item into a frame. Pass frameId null to remove it from any frame.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, frameId: { type: ["string", "null"] } },
    },
    run: ({ id, frameId }) => api("PATCH", `/notes/${encodeURIComponent(id)}`, { frameId: frameId ?? null }),
  },
  // ── Statuses (per-project custom Kanban columns) ───────────────────────────
  {
    name: "list_statuses",
    description: "List this project's statuses (the Kanban columns): each has id, name, color, role, and order. Use a status's id or name when setting an item's status. Roles drive the queue: 'done' is terminal + satisfies blockers, 'blocked' is skipped, 'proposed' is the approval inbox.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/statuses"),
  },
  {
    name: "create_status",
    description: "Add a custom status (Kanban column) to this project. role (proposed|backlog|active|blocked|done) governs queue behavior — most new columns are 'active' (work-in-progress) or 'backlog' (not started). name and color are shown on the board.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        role: { type: "string", enum: STATUS_ROLES, description: "queue behavior (default 'active')" },
        color: { type: "string", description: "hex like #38bdf8 (defaults from role)" },
        order: { type: "number", description: "column position (defaults to last)" },
      },
    },
    run: (a) => api("POST", "/statuses", a),
  },
  {
    name: "update_status",
    description: "Rename a status, change its color, or change its role. Pass the status id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        role: { type: "string", enum: STATUS_ROLES },
        color: { type: "string", description: "hex like #38bdf8" },
      },
    },
    run: ({ id, ...patch }) => api("PATCH", `/statuses/${encodeURIComponent(id)}`, patch),
  },
  {
    name: "delete_status",
    description: "Remove a status column. Items in it are moved to a fallback column (never destroyed). Refuses to remove the last column or the reserved 'proposed' inbox.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: ({ id }) => api("DELETE", `/statuses/${encodeURIComponent(id)}`),
  },
  {
    name: "list_frames",
    description: "List all frames (labeled groups for items).",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/frames"),
  },
  {
    name: "create_frame",
    description: "Create a frame (a labeled group). Items can be placed inside it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
    run: (a) => api("POST", "/frames", a),
  },
  {
    name: "update_frame",
    description: "Update a frame's title, position (x,y), size (width,height), or archived state (archived:true hides the frame and its items; false restores).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        archived: { type: "boolean" },
      },
    },
    run: ({ id, ...patch }) => api("PATCH", `/frames/${encodeURIComponent(id)}`, patch),
  },
  {
    name: "delete_frame",
    description:
      "Archive a frame by id (hides the frame and its items from the board). SAFE and RECOVERABLE — restorable from the Archived view; agents can never permanently delete.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    run: ({ id }) => api("DELETE", `/frames/${encodeURIComponent(id)}`),
  },
  {
    name: "relayout_frame",
    description: "Tidy a frame by arranging its member items into a neat grid.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: ({ id }) => api("POST", `/frames/${encodeURIComponent(id)}/relayout`),
  },

  // ── Real-time sync (SB-111): stay live without polling ─────────────────────
  {
    name: "list_routines",
    description: "List the board's routines: recurring tasks created on a cron schedule (UTC). Each shows its cron, task template, assignee (often a crew), active flag, and last run.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/routines"),
  },
  {
    name: "create_routine",
    description: "Create a routine: the board creates this task on a cron schedule (5-field, UTC), and it flows through the normal queue so a crew member or agent picks it up. Example: title 'Send weekly update', cron '0 9 * * 1', assignee 'crew:outreach'. Free plans allow 2 active routines.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "task title the routine creates" },
        cron: { type: "string", description: "5-field cron, UTC: minute hour day-of-month month day-of-week" },
        content: { type: "string" },
        assignee: { type: "string", description: "'me' | 'agent:<slug>' | 'crew:<name>'" },
        priority: { type: "string", enum: ["p1", "p2", "p3"] },
        name: { type: "string", description: "short label for the routine (defaults to the title)" },
        project: { type: "string", description: "project id (defaults to the default project)" },
      },
      required: ["title", "cron"],
    },
    run: (a) => api("POST", "/routines", a),
  },
  {
    name: "set_routine_active",
    description: "Pause (active:false) or resume (active:true) a routine.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, active: { type: "boolean" } },
      required: ["id", "active"],
    },
    run: ({ id, active }) => api("PATCH", `/routines/${encodeURIComponent(id as string)}`, { active }),
  },
  {
    name: "delete_routine",
    description: "Remove a routine (soft delete, recoverable server-side).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: ({ id }) => api("DELETE", `/routines/${encodeURIComponent(id as string)}`),
  },
  {
    name: "sync_status",
    description:
      "Real-time sync status: whether the live socket is connected, the per-project version + task count of the local mirror, a monotonic change cursor, and the most recent changes. Pass sync_status.cursor to wait_for_change so updates between calls are never missed.",
    inputSchema: { type: "object", properties: {} },
    run: async () => mirror.status(),
  },
  {
    name: "wait_for_change",
    description:
      "Block until the board changes (a task is created/updated/claimed/finished by any agent or the human) or the timeout elapses, then return the changes — an event-driven alternative to polling list_tasks. Pass sinceCursor (from sync_status.cursor, or the last returned event's seq) so changes between calls are never missed; pass project to watch one board. Each event lists changed/removed task ids; an event with resnapshot:true (empty ids) means a gap was caught up via a full snapshot, so re-read that project's tasks. Returns [] on timeout. Needs the live socket (check sync_status.connected); if disconnected it just times out, so fall back to list_tasks.",
    inputSchema: {
      type: "object",
      properties: {
        sinceCursor: {
          type: "number",
          description: "Only return changes with seq greater than this (defaults to the current cursor).",
        },
        project: {
          type: "string",
          description: "Watch a single project (workspace) id; default watches everything subscribed.",
        },
        timeoutMs: { type: "number", description: "Max wait in ms (1000–55000, default 25000)." },
      },
    },
    run: ({ sinceCursor, project, timeoutMs }: { sinceCursor?: number; project?: string; timeoutMs?: number }) =>
      mirror.waitForChange({ sinceSeq: sinceCursor, project, timeoutMs }),
  },
];

// Server-level guidance surfaced to the model on connect — the MCP-native "skill".
// Client-agnostic (Claude Code, Codex, Cursor, … all read the initialize `instructions`)
// and auto-updates with the server. It deliberately ASSUMES you're already connected
// (you're reading this over the server), so it skips install/login and teaches how to
// OPERATE the board. Kept tight — it's always in context once the server connects.
const INSTRUCTIONS = `ControlBoard is a shared "program-manager" board for a human and their AI agents: one set of tasks shown three ways — a timeline, a canvas of cards grouped in frames, and a Kanban board. You are probably ONE of several agents on this board, so coordinate through the queue + claims, and PROPOSE (don't silently add) new work.

First run — if this looks like the user's first session, take a look (list_tasks / list_frames). A new board has a "Getting Started" frame with a "Connect your first agent" task. If that task is still open AND there is no "Setup Agents" frame yet:
1. Mark it done — set_task_status {id, status:"done"} — that's you, connected.
2. Create a "Setup Agents" frame (create_frame), then add one item per popular coding agent — "Setup Claude Code", "Setup Codex", "Setup Cursor", "Setup Hermes", "Setup Open Claude" (create_item {title, frameId}) — assigning the one that is YOU to yourself (assignee 'agent:<your-slug>'). The user is watching; tasks appearing on their own is the whole point. Skip all of this if it's already done.

The work loop:
1. get_next_task {claim:true} — pull the highest-priority ready task and claim it (a ~30-min soft lock so peers skip it).
2. Do the work. add_comment {id, text} to record progress; link_context {id, href} to attach the PR / issue / doc it relates to.
3. set_task_status {id, status:"done"} when finished (releases the claim), or release_task {id} to hand it back. list_tasks is the queue; list_activity shows who did what.

Coordination directives (the board is the single source of truth between distributed agents; follow these so you never step on each other):
1. Write tasks so a STRANGER can work them. A task's content must carry everything: goal, repo/machine/paths, exact steps, links, and a "## Progress" section you APPEND to (never rewrite) with what you did and where you stopped. Whoever picks it up next, on any machine, continues from the task alone.
2. Read before you write. get_task returns the task's own change history (activity) plus updatedBy/updatedAt. If someone else touched it since you last looked, read what they did first. Prefer add_comment and appending to Progress over editing content; when you must edit shared fields, pass ifUpdatedAt (the updatedAt you read) so a concurrent change bounces as 409 stale_write instead of being overwritten — then re-read, merge, retry.
3. Claims are the lock, comments are the log. claim before working, release or finish when done; a claim expires after ~30 minutes if you crash. Never work a task claimed by someone else that is not stale.
4. Assign with a rationale. When you hand work to an agent or crew, pass rationale — it lands as a comment so the assignee knows why them and with what intent.
5. Route by headroom. list_agents shows each agent's default model and self-reported usage snapshot; prefer assignees with quota left. Report your own after heavy work: PATCH /agents/self usage (cb usage set).
6. The queue is shared and orderable. rank sets explicit order (lower first, ranked beats unranked); the human can drag the same queue in the app. Reorder deliberately, not casually, and say why in a comment when you shuffle someone else's priorities.
7. Have a heartbeat. If your platform can schedule (Claude Code scheduled tasks/cron, Codex Automations, Cursor Automations, Hermes heartbeat jobs, OpenClaw HEARTBEAT.md/cron), keep a recurring job that runs the pull loop — cb work --assigned, or get_next_task {claim:true, strict:true} — so assignments reach you without a human relaying them. Schedulers MUST use the assigned/strict form: unattended workers take only explicitly-assigned work, never the human's untriaged (unassigned) backlog.

Assign across the fleet: every item has an owner. list_agents to discover teammates, then assign_task {id, assignee:'agent:<slug>'} to hand work to a peer, 'me' to route a decision to the human, or your own slug to take it. Scope your queue with get_next_task {assignee:'agent:<you>'}.

Propose, don't surprise: for NEW work you weren't explicitly asked to do, call propose_task {title, why} instead of create_item — it lands in the user's inbox for one-tap approval rather than changing their board. list_inbox shows pending proposals.

Crews (work pools): agents with the same crew share a queue. Assign with assignee 'crew:<name>' and any member may claim; get_next_task is auto-scoped to you + your crew. Spawn a sibling identity (one per role, no browser) with POST /agents via the cb CLI: cb agent spawn "<label>" --crew <crew> --tool <tool>. Routines create recurring tasks on a cron (create_routine); they land in the normal queue for crews to pick up.

Conventions:
- status: per-project CUSTOM columns (list_statuses); set by id, name, or role keyword (proposed · backlog · active · blocked · done).
- priority p1 > p2 > p3 · effort s/m/l · assignee 'me' | 'agent:<slug>' | null.
- One project = one board — list_projects to see them, or scope with CONTROLBOARD_PROJECT.
- Don't delete the user's items unless asked; prefer status changes + comments.

Client bundle: controlboard-mcp ${typeof __CB_VERSION__ === "string" ? __CB_VERSION__ : "dev"}. GET ${BASE}/api/v1/meta reports the current release (mcpLatest/cliLatest); if yours is older, run "cb self-update" (refreshes ~/.controlboard/cb.mjs + controlboard-mcp.mjs), then restart this MCP server.

Full reference: ${BASE}/llms.txt · docs: ${BASE}/docs`;

// Stamped by esbuild --define at build time; "dev" when run from source.
declare const __CB_VERSION__: string;
const CB_VERSION: string = typeof __CB_VERSION__ === "string" ? __CB_VERSION__ : "dev";

const server = new Server(
  { name: "controlboard", version: CB_VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  }
  try {
    const result = await tool.run(req.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: any) {
    return { isError: true, content: [{ type: "text", text: String(err?.message || err) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[controlboard-mcp] connected to ${BASE} — ${tools.length} tools ready`);
