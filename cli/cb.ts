// cb — a thin ControlBoard CLI over the REST API. Shell-out friendly for humans and
// any agent harness (no MCP client needed).
//   curl -fsSL https://controlboard.ai/cli/cb.mjs -o cb.mjs
//   CONTROLBOARD_API_KEY=cbk_... node cb.mjs task next --claim
// Auth: `cb login <cbk_...>` (stored in ~/.config/controlboard/config.json) or the
// CONTROLBOARD_API_KEY env. Target a project with --project <id> / CONTROLBOARD_PROJECT
// / `cb project use <id>`. Global --json for machine output.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, statSync, existsSync, unlinkSync } from "fs";
import { homedir, hostname, userInfo } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";

const BASE = (process.env.CONTROLBOARD_URL || "https://controlboard.ai").replace(/\/+$/, "");
const CONFIG_DIR = join(homedir(), ".config", "controlboard");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Stamped by esbuild --define at build time; "dev" when run from source.
declare const __CB_VERSION__: string;
const CB_VERSION: string = typeof __CB_VERSION__ === "string" ? __CB_VERSION__ : "dev";
const LIB_DIR = join(homedir(), ".controlboard"); // where install.sh puts the bundles
const enc = encodeURIComponent;

type AgentEntry = { agentId: string; key: string };
// Multiple agents can share one machine/config; each is keyed by its label and
// carries its own stable agentId + key. `key`/`agentId` are the legacy single-
// agent fields, still honored as a fallback.
type Config = {
  project?: string;
  default?: string; // active agent (label) for bare `cb` commands
  agents?: Record<string, AgentEntry>;
  key?: string;
  agentId?: string;
};
function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
  } catch {
    return {};
  }
}
function writeConfig(c: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  try {
    chmodSync(CONFIG_FILE, 0o600); // also tighten if the file pre-existed
  } catch {
    /* best effort */
  }
}
// A copy of the config without the legacy single-agent fields (once an agent
// lives in the `agents` map, the top-level key/agentId are dead weight).
function withoutLegacy(c: Config): Config {
  const next = { ...c };
  delete next.key;
  delete next.agentId;
  return next;
}
// Label → URL/id-safe slug, used as the stable agentId stem.
const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

// Flags that never take a value (so they don't swallow the next positional).
const BOOL = new Set(["json", "claim", "help", "done", "force", "once", "watch", "version", "assigned"]);
function parse(argv: string[]): { pos: string[]; flags: Record<string, string | boolean> } {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const k = a.slice(2);
        if (BOOL.has(k)) flags[k] = true;
        else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
        else flags[k] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

const { pos, flags } = parse(process.argv.slice(2));
const asJson = flags.json === true;
const cfg = readConfig();

// Which agent is this invocation acting as: --label / CONTROLBOARD_AGENT, else the
// saved default, else the sole agent with a key.
function activeLabel(c: Config): string | undefined {
  const want = (typeof flags.label === "string" && flags.label) || process.env.CONTROLBOARD_AGENT || "";
  if (want) return want;
  if (c.default && c.agents?.[c.default]?.key) return c.default;
  const withKeys = c.agents ? Object.keys(c.agents).filter((l) => c.agents![l]?.key) : [];
  return withKeys.length === 1 ? withKeys[0] : undefined;
}
function resolveKey(c: Config): string {
  if (process.env.CONTROLBOARD_API_KEY) return process.env.CONTROLBOARD_API_KEY;
  const lbl = activeLabel(c);
  if (lbl && c.agents?.[lbl]?.key) return c.agents[lbl].key;
  // An agent named explicitly (--label / CONTROLBOARD_AGENT) but not yet connected
  // resolves empty — never another agent's or the legacy key. This keeps the
  // per-agent check-then-do honest: `cb whoami --label new` fails → `cb login --label new`.
  const named = (typeof flags.label === "string" && flags.label) || process.env.CONTROLBOARD_AGENT || "";
  if (named) return "";
  return c.key || ""; // legacy single-agent config
}
const KEY = resolveKey(cfg);
const PROJECT =
  (typeof flags.project === "string" && flags.project) ||
  process.env.CONTROLBOARD_PROJECT ||
  cfg.project ||
  "";

function die(msg: string, code = 1): never {
  process.stderr.write(msg + "\n");
  process.exit(code);
}
function out(human: string, data?: unknown): void {
  if (asJson) console.log(JSON.stringify(data ?? {}, null, 2));
  else console.log(human);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  if (!KEY) die("No API key. Run `cb login <cbk_...>` or set CONTROLBOARD_API_KEY.", 2);
  let url = `${BASE}/api/v1${path}`;
  if (PROJECT) url += (url.includes("?") ? "&" : "?") + "project=" + enc(PROJECT);
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
    // A definitive invalid-key on a CONFIG-saved credential means this agent was
    // deregistered (revoked in the app's Registered agents). Self-heal: remove
    // the dead local credentials so the machine matches the server.
    if (res.status === 401 && data?.error === "invalid_api_key" && !process.env.CONTROLBOARD_API_KEY && CANONICAL_BASE) {
      const lbl = activeLabel(cfg);
      if (lbl && cfg.agents?.[lbl]?.key === KEY) {
        pruneAgent(lbl);
        die(
          `Agent "${lbl}" was deregistered (its key was revoked — e.g. from Registered agents in the app).\n` +
            `Removed its local credentials. Re-register with: cb login --label ${lbl}`,
          1,
        );
      }
      if (!lbl && cfg.key === KEY) {
        pruneLegacyKey();
        die(
          "This key was deregistered (revoked — e.g. from Registered agents in the app).\n" +
            "Removed the local credentials. Re-register with: cb login --label <agent-name>",
          1,
        );
      }
    }
    die(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`, res.status === 409 ? 3 : 1);
  }
  return data;
}

// Remove one agent's saved credentials (and repoint the default if needed).
// Re-reads config.json first: a long-lived process (cb work --watch) holds a
// startup snapshot, and rewriting from that would clobber identities added since.
function pruneAgent(label: string): void {
  const fresh = readConfig();
  const agents = { ...(fresh.agents || {}) };
  delete agents[label];
  const next: Config = { ...withoutLegacy(fresh), agents };
  if (next.default === label) delete next.default;
  writeConfig(next);
}
function pruneLegacyKey(): void {
  writeConfig(withoutLegacy(readConfig()));
}
// Only treat a 401 as a definitive revocation against the REAL server: with a
// CONTROLBOARD_URL override (staging/self-hosted), an unknown key there says
// nothing about the credential's home server — never destroy it.
const CANONICAL_BASE = !process.env.CONTROLBOARD_URL;

// cb logout [--label <name>] — full deregistration from the machine side:
// revoke THIS agent's key server-side (self only; the same task cascade the UI
// revoke runs), then remove the local credentials. Mirrors UI-revoke → 401 prune.
async function logout(labelFlag?: string): Promise<void> {
  const label = labelFlag || activeLabel(cfg);
  const legacy = !label && !!cfg.key; // pre-label single-agent config
  const key = label ? cfg.agents?.[label]?.key : cfg.key;
  if (!key) {
    die(`No saved agent${labelFlag ? ` "${labelFlag}"` : ""} to log out (see ${CONFIG_FILE}).`, 2);
  }
  const who = label ? `"${label}"` : "the legacy key";
  let status = 0;
  try {
    const res = await fetch(`${BASE}/api/v1/agents/self`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    status = res.status;
    const d: any = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(
        d.lastKey === false
          ? `Server: revoked this key of "${d.slug}" (other keys for that identity remain active).`
          : `Server: revoked "${d.slug}". Queued tasks unassigned: ${d.unassigned}; in-flight released → Blocked for review: ${d.released}.`,
      );
    } else if (res.status === 401 && CANONICAL_BASE) {
      console.log("Server: key was already revoked (deregistered earlier from the app).");
    } else {
      // The revoke did NOT happen (server error, or a 401 against a non-default
      // CONTROLBOARD_URL that proves nothing). Keep the only copy of the key —
      // pruning now would strand a live credential server-side.
      die(
        `Server revoke did not complete (${res.status}${CANONICAL_BASE ? "" : ` against ${BASE}`}). ` +
          `Local credentials for ${who} were KEPT. Retry when reachable, or revoke it under Registered agents in the app (cb will then clean up on its next 401).`,
        1,
      );
    }
  } catch {
    die(
      `Server unreachable — the key was NOT revoked. Local credentials for ${who} were KEPT. ` +
        "Retry when online, or revoke it under Registered agents in the app.",
      1,
    );
  }
  if (label) pruneAgent(label);
  else if (legacy) pruneLegacyKey();
  console.log(`Logged out ${who} — local credentials removed.`);
  console.log("If this agent had an MCP registration or a scheduler, remove those too (e.g. `claude mcp remove controlboard`, its scheduled task/Automation).");
}

const q = (o: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== "" && v !== false) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? "?" + s : "";
};

function taskLine(t: any): string {
  // role is the stable semantic; status is the (custom) column name shown after.
  const role = t.role || (t.done ? "done" : "backlog");
  const mark = role === "done" ? "✓" : role === "active" ? "▸" : role === "blocked" ? "⊘" : role === "proposed" ? "?" : "○";
  const prio = t.priority ? `[${t.priority}]` : "   ";
  const who = t.assignee ? ` @${t.assignee}` : "";
  const claim = t.claimedBy ? ` (claimed: ${t.claimedBy})` : "";
  return `${mark} ${prio} ${t.id}  ${t.title || "(untitled)"}${who}${claim}`;
}

async function taskCmd(sub: string | undefined, rest: string[]): Promise<void> {
  switch (sub) {
    case undefined:
    case "ls": {
      const d = await api(
        "GET",
        "/tasks" + q({ status: flags.status, priority: flags.priority, assignee: flags.assignee, q: flags.q, includeDone: flags.done }),
      );
      return out(d.tasks.map(taskLine).join("\n") || "(no tasks)", d);
    }
    case "next": {
      const d = await api("GET", "/tasks/next" + q({ assignee: flags.assignee, claim: flags.claim }));
      if (!d.task) return out("No ready task.", d);
      return out(taskLine(d.task) + (d.claimed ? "  (claimed)" : ""), d);
    }
    case "new": {
      const title = rest[0];
      if (!title) die('Usage: cb task new "<title>" [--content "..." --frame <id> --priority --assignee --due --effort]', 2);
      const d = await api("POST", "/tasks", {
        title, content: flags.content, priority: flags.priority, assignee: flags.assignee,
        rationale: flags.rationale ?? flags.why, date: flags.due, effort: flags.effort, frameId: flags.frame,
      });
      return out(`Created ${d.task.id}  ${d.task.title}`, d);
    }
    case "show": {
      const id = rest[0];
      if (!id) die("Usage: cb task show <id>", 2);
      const d = await api("GET", `/tasks/${enc(id)}`);
      if (asJson) return out("", d);
      const t = d.task;
      const lines = [
        taskLine(t),
        t.content ? `  ${t.content}` : null,
        ...(t.links || []).map((l: any) => `  link [${l.kind}] ${l.href}`),
        ...(t.comments || []).map((c: any) => `  ${c.actor}: ${c.text}`),
      ].filter(Boolean) as string[];
      return out(lines.join("\n"));
    }
    case "claim": {
      const id = rest[0];
      if (!id) die("Usage: cb task claim <id>", 2);
      return out(`Claimed ${id}`, await api("POST", `/tasks/${enc(id)}/claim`));
    }
    case "release": {
      const id = rest[0];
      if (!id) die("Usage: cb task release <id>", 2);
      return out(`Released ${id}`, await api("POST", `/tasks/${enc(id)}/release`));
    }
    case "done": {
      const id = rest[0];
      if (!id) die("Usage: cb task done <id>", 2);
      return out(`Done ${id}`, await api("PATCH", `/tasks/${enc(id)}`, { status: "done" }));
    }
    case "status": {
      const id = rest[0];
      const s = rest[1];
      if (!id || !s) die("Usage: cb task status <id> <status>  (a status id, name, or role: backlog|active|blocked|done)", 2);
      return out(`${id} -> ${s}`, await api("PATCH", `/tasks/${enc(id)}`, { status: s }));
    }
    case "assign": {
      const id = rest[0];
      const who = rest[1];
      if (!id || !who) die('Usage: cb task assign <id> <me|agent:<slug>|crew:<name>> [--why "..."]', 2);
      const d = await api("PATCH", `/tasks/${enc(id)}`, { assignee: who === "none" ? null : who, rationale: flags.why });
      return out(`${id} → ${d.task.assignee ?? "unassigned"}`, d);
    }
    case "rank": {
      // Explicit queue position: lower rank runs sooner; ranked tasks beat
      // unranked. "top" puts it ahead of everything currently ranked.
      const id = rest[0];
      const val = rest[1];
      if (!id || !val) die("Usage: cb task rank <id> <top|none|number>", 2);
      let rank: number | null;
      if (val === "none") rank = null;
      else if (val === "top") {
        const all = (await api("GET", "/tasks")).tasks || [];
        const ranks = all.map((t: any) => t.rank).filter((r: any) => typeof r === "number");
        rank = ranks.length ? Math.min(...ranks) - 1 : 0;
      } else {
        rank = Number(val);
        if (!isFinite(rank)) die("rank must be a number, top, or none", 2);
      }
      const d = await api("PATCH", `/tasks/${enc(id)}`, { rank });
      return out(`${id} rank → ${d.task.rank ?? "none"}`, d);
    }
    case "comment": {
      const id = rest[0];
      const text = rest[1];
      if (!id || !text) die('Usage: cb task comment <id> "<text>"', 2);
      return out(`Commented on ${id}`, await api("POST", `/tasks/${enc(id)}/comments`, { text }));
    }
    case "link": {
      const id = rest[0];
      const href = rest[1];
      if (!id || !href) die("Usage: cb task link <id> <href> [--kind]", 2);
      return out(`Linked ${href} to ${id}`, await api("POST", `/tasks/${enc(id)}/links`, { href, kind: flags.kind }));
    }
    default:
      die("Usage: cb task ls|next|new|show|claim|release|done|status|comment|link", 2);
  }
}

async function watch(): Promise<void> {
  let since = Date.now();
  process.stderr.write("Watching activity (Ctrl-C to stop)…\n");
  for (;;) {
    const d = await api("GET", "/activity" + q({ since, limit: 50 }));
    const evs = (d.activity || []).filter((a: any) => a.createdAt >= since).sort((a: any, b: any) => a.createdAt - b.createdAt);
    for (const a of evs) {
      console.log(`${new Date(a.createdAt).toISOString().slice(11, 19)}  ${a.actorLabel}  ${a.verb}  ${a.summary || ""}`);
      since = Math.max(since, a.createdAt + 1);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function openBrowser(url: string): void {
  const p = process.platform;
  const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* the URL is printed as a fallback */
    });
    child.unref();
  } catch {
    /* fallback: the URL was printed */
  }
}

// Device-authorization login: open the browser, the human approves, the minted
// key is captured and saved to the home config — shared across all projects.
function mcpHint(label: string): string {
  const mcpPath = join(homedir(), ".controlboard", "controlboard-mcp.mjs");
  return (
    `\nRegister this agent's MCP server (it selects this agent's key by name):\n` +
    `  claude mcp add controlboard -s user --env CONTROLBOARD_AGENT=${label} -- node ${mcpPath}\n`
  );
}

async function deviceLogin(): Promise<void> {
  const force = flags.force === true;
  let username = "agent";
  try {
    username = userInfo().username;
  } catch {
    /* keep default */
  }
  const host = hostname();
  const label = (typeof flags.label === "string" && flags.label) || `${username}@${host}`;
  const slug = slugify(label);
  const agents: Record<string, AgentEntry> = { ...(cfg.agents || {}) };

  // One-time upgrade of a legacy single-agent config ({key, agentId}, no agents
  // map) into the per-agent map under this label, REUSING the stable legacy
  // agentId so the server keeps exactly one key (no orphaned duplicate when this
  // same agent re-links). Persist immediately and drop the dead top-level fields.
  if (!agents[label] && !cfg.agents && cfg.key) {
    agents[label] = { agentId: cfg.agentId || `${slug}-${randomBytes(4).toString("hex")}`, key: cfg.key };
    const def = cfg.default || label;
    writeConfig({ ...withoutLegacy(cfg), agents, default: def });
    cfg.agents = agents;
    cfg.default = def;
    delete cfg.key;
    delete cfg.agentId;
  }
  const existing = agents[label];

  // Idempotent PER AGENT: if this agent already has a working key, stop.
  if (!force && existing?.key) {
    try {
      const r = await fetch(`${BASE}/api/v1/me`, { headers: { Authorization: `Bearer ${existing.key}` } });
      if (r.ok) {
        const d: any = await r.json().catch(() => ({}));
        out(`Agent "${label}" already connected as ${d?.actor?.label || label} (${BASE}). Re-link with:  cb login --label ${label} --force`, {
          connected: true,
          label,
          actor: d?.actor,
        });
        process.stderr.write(mcpHint(label));
        return;
      }
    } catch {
      /* fall through to a fresh login */
    }
  }

  // Stable per-agent id (reused on re-link so the server keeps one key per agent).
  const agentId = existing?.agentId || `${slug}-${randomBytes(4).toString("hex")}`;

  const startRes = await fetch(`${BASE}/api/v1/auth/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: { label, host, agentId } }),
  });
  if (!startRes.ok) die(`Could not start login: ${startRes.status}`, 1);
  const start: any = await startRes.json();
  const url = start.verification_uri_complete || start.verification_uri;
  const interval = (start.interval || 3) * 1000;
  const deadline = Date.now() + (start.expires_in ? start.expires_in * 1000 : 600000);

  process.stderr.write(
    `\nConnect agent "${label}" to ControlBoard:\n  open  ${url}\n  confirm the code matches:  ${start.user_code}\n\nWaiting for approval in the browser…\n`,
  );
  openBrowser(url);

  for (;;) {
    if (Date.now() > deadline) die("Login timed out. Run `cb login` again.", 1);
    await new Promise((r) => setTimeout(r, interval));
    const pollRes = await fetch(`${BASE}/api/v1/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    const p: any = await pollRes.json().catch(() => ({}));
    if (p.status === "approved") {
      agents[label] = { agentId, key: p.apiKey };
      const def = cfg.default || label;
      writeConfig({ ...withoutLegacy(cfg), agents, default: def });
      cfg.agents = agents;
      cfg.default = def;
      out(`Connected agent "${label}" as ${p.actor?.label || label}. Saved to ${CONFIG_FILE}.`, {
        connected: true,
        label,
        actor: p.actor,
      });
      process.stderr.write(mcpHint(label));
      return;
    }
    if (p.status === "denied") die("Login was denied in the browser.", 1);
    if (p.status === "expired") die("Login request expired. Run `cb login` again.", 1);
    // pending → keep polling
  }
}

// ── cb work: the one-line worker loop (docs/design/agent-crews.md) ──────────
// --once: claim the next ready task (auto-scoped to me + my crew) and print a
// self-contained work prompt to stdout, so any headless tool becomes a worker:
//   t=$(cb work --once) && claude -p "$t"
// Exit 4 = queue empty (prints nothing). --watch loops forever and runs --exec
// with the prompt whenever a task lands; a nonzero exec releases the claim.
function workPrompt(t: any): string {
  return [
    `You are working one ControlBoard task through the cb CLI (already authenticated).`,
    `Task ${t.id}: ${t.title}${t.priority ? `  [${t.priority}]` : ""}`,
    t.content ? `\nDetails:\n${t.content}` : "",
    `\nDo the work now. Then record it:`,
    `  cb task comment ${t.id} "<one line on what you did>"`,
    `  cb task link ${t.id} <pr-or-doc-url>      (if there is an artifact)`,
    `  cb task done ${t.id}`,
    `If you cannot finish: cb task status ${t.id} blocked (and comment why), or cb task release ${t.id}.`,
  ].filter(Boolean).join("\n") + "\n";
}

async function workOnce(assignedOnly = false): Promise<void> {
  const d = await api("GET", `/tasks/next?claim=true${assignedOnly ? "&strict=true" : ""}`);
  if (!d.task) {
    process.exitCode = 4; // empty queue — callers guard with: t=$(cb work --once) && ...
    return;
  }
  process.stdout.write(workPrompt(d.task));
}

function runExec(cmd: string, prompt: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `${cmd} "$CB_TASK_PROMPT"`], {
      stdio: "inherit",
      env: { ...process.env, CB_TASK_PROMPT: prompt },
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function workWatch(execCmd: string, intervalS: number, assignedOnly = false): Promise<void> {
  process.stderr.write(`[cb work] watching the queue (every ${intervalS}s) → ${execCmd}\n`);
  // Hot-loop guard: our own live claim is re-offered to us (idempotent), so if
  // the exec exits 0 without completing/releasing the task, the same id comes
  // straight back. Release it and back off instead of spinning on it.
  let prevOkId: string | null = null;
  for (;;) {
    let d: any = null;
    try {
      d = await api("GET", `/tasks/next?claim=true${assignedOnly ? "&strict=true" : ""}`);
    } catch {
      /* transient network error — retry after the interval */
    }
    if (d?.task) {
      if (d.task.id === prevOkId) {
        try { await api("POST", `/tasks/${enc(d.task.id)}/release`); } catch { /* ignore */ }
        process.stderr.write(`[cb work] exec finished but ${d.task.id} was not completed; released it\n`);
        prevOkId = null;
        await new Promise((r) => setTimeout(r, intervalS * 1000));
        continue;
      }
      process.stderr.write(`[cb work] claimed ${d.task.id}  ${d.task.title}\n`);
      const code = await runExec(execCmd, workPrompt(d.task));
      if (code !== 0) {
        try { await api("POST", `/tasks/${enc(d.task.id)}/release`); } catch { /* ignore */ }
        process.stderr.write(`[cb work] exec exited ${code}; released ${d.task.id}\n`);
        prevOkId = null;
      } else {
        prevOkId = d.task.id;
      }
      continue; // look for the next task immediately
    }
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
}

function printHelp(): void {
  console.log(`cb — ControlBoard CLI  (${BASE})

Auth:  cb login  (browser device login)  |  cb login <cbk_...>  (paste a key)  |  CONTROLBOARD_API_KEY=cbk_...
Project:  --project <id>  |  CONTROLBOARD_PROJECT=<id>  |  cb project use <id>

  cb whoami
  cb agent ls | spawn "<label>" [--crew <c> --tool <t>] | set [--crew --tool]   # crews = work pools
  cb project ls | new <name> [--color --description] | use <id>
  cb frame ls | new "<title>"            # labeled groups of items on the canvas
  cb task ls [--status --priority --assignee --q --done]
  cb task next [--claim] [--assignee]
  cb task new "<title>" [--content "..." --frame <id> --priority p1 --assignee me|agent:<slug>|crew:<name> --due YYYY-MM-DD --effort m]
  cb task show <id>                      # full detail + per-task history (who changed what)
  cb task assign <id> <who> [--why "…"]  # the why is recorded for the assignee to read
  cb task rank <id> <top|none|n>         # explicit queue position (lower runs sooner)
  cb task claim|release|done <id>
  cb task status <id> <status>          # a status id, name, or role: backlog|active|blocked|done
  cb task comment <id> "<text>"
  cb task link <id> <href> [--kind pr|issue|doc|file|url]
  cb work [--once]                       # claim next task + print a work prompt (exit 4 = empty)
  cb work --watch --exec 'claude -p'     # loop: claim → run your tool with the prompt
  cb routine ls | add "<title>" --cron "0 9 * * 1" [--assignee crew:<c>] | pause|resume|rm <id>
  cb usage ls | set '<json>' | clear     # self-report quota so assigners can route by headroom
  cb usage sync [--tool codex|claude] [--watch [--interval <min>]]  # read the local tool's real quota and push it
  cb work --assigned                     # scheduler-safe: only tasks explicitly assigned to you/your crew
  cb skill install                       # ambient board skill for Claude Code + Codex (offer-to-track)
  cb ambient on|off                      # toggle the ambient "track this?" offer
  cb version | self-update               # show the client version / refresh ~/.controlboard from the server
  cb logout [--label <name>]             # deregister this agent: revoke its key (self only) + remove local creds
  cb propose "<title>" [--why "..."]
  cb inbox | approve <id> | reject <id> [--reason "..."]
  cb activity [--since <ms> --limit <n>]
  cb watch

Global:  --json (machine output)   ·   exit: 0 ok, 1 error, 2 usage, 3 conflict(409)`);
}

// ── cb skill install — ambient board awareness in every session ──────────────
// Claude Code loads ~/.claude/skills/*/SKILL.md into every conversation; Codex
// reads ~/.codex/AGENTS.md. Both get the same behavior: when a session turns
// into real work, offer ONCE to track it on the board; "no" stays silent for
// the session; "never" flips the cb ambient marker.
const AMBIENT_RULES = `When a conversation turns into real work — a multi-step build/fix/investigation that will take a while or produce commits, PRs, or documents — offer ONCE to track it on the user's ControlBoard board (controlboard.ai). Rules:

1. First check: if ~/.config/controlboard/ambient-off exists, or cb is not installed, make NO offer — only act when the user explicitly asks for ControlBoard.
2. The offer, exactly once per session, short: "Want me to track this on ControlBoard? (yes / no / never ask)". Never interrupt mid-action; ask at a natural pause.
3. yes → pick the project yourself: run \`cb project ls\` and choose the one whose name matches the repo/directory/topic; otherwise the default. Create the task with a SELF-CONTAINED description (goal, repo + paths, steps done and remaining, how to verify), status "doing"/active, assigned to yourself, then claim it. As you hit milestones append short "## Progress" comments (\`cb task comment <id> "..."\`), and mark it done (\`cb task done <id>\`) when the work completes. If the session ends unfinished, append a final Progress comment saying exactly where you stopped.
4. no → do not mention ControlBoard again this session. The user asking explicitly always overrides.
5. never ask → run \`cb ambient off\`, confirm, and treat as "no" from then on.
6. Board writes are best-effort: never block or delay the actual work on a board failure; mention it once and move on.`;

async function skillInstall(): Promise<void> {
  const wrote: string[] = [];
  // Claude Code skill (picked up in every session).
  const skillDir = join(homedir(), ".claude", "skills", "controlboard");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---
name: controlboard
description: Track substantive work on the user's ControlBoard board (controlboard.ai) with the cb CLI. Use when a session becomes a real multi-step task (build, fix, ship, investigate), when the user mentions ControlBoard, their board, task tracking, or asks what to work on next.
---

# ControlBoard session tracking

${AMBIENT_RULES}

Useful commands: \`cb project ls\` · \`cb task new "<title>" --content "<handoff details>" --assignee agent:<you> --status doing\` · \`cb task comment <id> "## Progress ..."\` · \`cb task done <id>\` · \`cb work --assigned\` (pull your next assigned task) · \`cb help\` for everything else.
`,
  );
  wrote.push("~/.claude/skills/controlboard/SKILL.md");
  // Codex global AGENTS.md — managed block, idempotent.
  const agentsMd = join(homedir(), ".codex", "AGENTS.md");
  if (existsSync(join(homedir(), ".codex"))) {
    const START = "<!-- controlboard:start -->";
    const END = "<!-- controlboard:end -->";
    const block = `${START}
## ControlBoard

${AMBIENT_RULES}
${END}`;
    let md = "";
    try { md = readFileSync(agentsMd, "utf8"); } catch { /* new file */ }
    if (md.includes(START)) {
      md = md.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
    } else {
      md = (md ? md.trimEnd() + "\n\n" : "") + block + "\n";
    }
    writeFileSync(agentsMd, md);
    wrote.push("~/.codex/AGENTS.md (ControlBoard section)");
  }
  out(`Installed ambient ControlBoard skill:\n  ${wrote.join("\n  ")}\nDisable offers anytime with: cb ambient off`);
}

// ── Usage adapters (cb usage sync) — CodexBar-style local quota readers ──────
// Normalized shape pushed to the board; assigners route work by remaining
// headroom, so keep it small: a few windows of { label, usedPct, resetsAt(ms) }.
type UsageReport = {
  windows: { label: string; usedPct: number; resetsAt?: number }[];
  plan?: string;
  source: string;
};

function winLabel(minutes?: number): string {
  if (!minutes || !isFinite(minutes)) return "window";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// Which local tool to read for this identity: the tool recorded at registration
// wins; otherwise whichever tool actually has data on this machine.
async function detectUsageTool(): Promise<string | null> {
  try {
    const me = await api("GET", "/me");
    const agents = await api("GET", "/agents");
    const mine = (agents.agents || []).find((a: any) => a.label === me?.actor?.label);
    const t = String(mine?.tool || "");
    if (t.includes("codex")) return "codex";
    if (t.includes("claude")) return "claude";
  } catch {
    /* offline or unregistered — probe locally */
  }
  if (existsSync(join(homedir(), ".codex", "sessions"))) return "codex";
  if (
    process.platform === "darwin" ||
    existsSync(join(homedir(), ".claude", ".credentials.json"))
  ) return "claude";
  return null;
}

// codex writes a rate_limits snapshot into every session rollout; the newest
// one is the current quota. Pure local file read, no process spawned.
function readCodexUsage(): UsageReport | null {
  const root = join(homedir(), ".codex", "sessions");
  const files: { f: string; m: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth < 5) walk(p, depth + 1);
        else if (e.endsWith(".jsonl")) files.push({ f: p, m: st.mtimeMs });
      } catch { /* raced */ }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.m - a.m);
  const findRl = (o: unknown): any => {
    if (!o || typeof o !== "object") return null;
    const rl = (o as any).rate_limits;
    if (rl && typeof rl === "object" && rl.primary) return rl;
    for (const v of Object.values(o as object)) {
      const r = findRl(v);
      if (r) return r;
    }
    return null;
  };
  for (const { f } of files.slice(0, 5)) {
    let lines: string[];
    try { lines = readFileSync(f, "utf8").split("\n"); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const rl = findRl(JSON.parse(lines[i]));
        if (!rl) continue;
        const windows: UsageReport["windows"] = [];
        for (const w of [rl.primary, rl.secondary]) {
          if (w && typeof w.used_percent === "number") {
            windows.push({
              label: winLabel(w.window_minutes),
              usedPct: Math.round(w.used_percent),
              resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : undefined,
            });
          }
        }
        if (!windows.length) continue;
        const rep: UsageReport = { windows, source: "codex-sessions" };
        if (typeof rl.plan_type === "string") rep.plan = rl.plan_type;
        return rep;
      } catch { /* malformed line */ }
    }
  }
  return null;
}

// Claude Code: the saved OAuth token (macOS keychain, or ~/.claude/.credentials.json
// elsewhere) → Anthropic's own usage endpoint. The token is only ever sent to
// api.anthropic.com and is never printed or stored by cb.
async function readClaudeUsage(): Promise<UsageReport | null> {
  let token: string | undefined;
  if (process.platform === "darwin") {
    const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" });
    if (r.status === 0) {
      try { token = JSON.parse(r.stdout.trim())?.claudeAiOauth?.accessToken; } catch { /* not JSON */ }
    }
  }
  if (!token) {
    try {
      token = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"))?.claudeAiOauth?.accessToken;
    } catch { /* no file */ }
  }
  if (!token) return null;
  let d: any;
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!res.ok) return null;
    d = await res.json();
  } catch {
    return null;
  }
  const windows: UsageReport["windows"] = [];
  const add = (label: string, o: any) => {
    if (o && typeof o.utilization === "number") {
      const resetsAt = o.resets_at ? Date.parse(o.resets_at) : NaN;
      windows.push({ label, usedPct: Math.round(o.utilization), ...(isFinite(resetsAt) ? { resetsAt } : {}) });
    }
  };
  add("5h", d.five_hour);
  add("7d", d.seven_day);
  add("7d-opus", d.seven_day_opus);
  return windows.length ? { windows, source: "claude-oauth" } : null;
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = pos;
  if (flags.version) return out(`cb ${CB_VERSION}`, { version: CB_VERSION });
  if (!cmd || flags.help || cmd === "help") return printHelp();

  switch (cmd) {
    case "login": {
      if (sub && sub.startsWith("cbk_")) {
        const lbl = typeof flags.label === "string" ? flags.label : "";
        if (lbl) {
          const agents = { ...(cfg.agents || {}) };
          agents[lbl] = { agentId: agents[lbl]?.agentId || `${slugify(lbl)}-manual`, key: sub };
          writeConfig({ ...withoutLegacy(cfg), agents, default: cfg.default || lbl });
          return out(`Saved key for agent "${lbl}" to ${CONFIG_FILE}`);
        }
        writeConfig({ ...cfg, key: sub });
        return out(`Saved key ${sub.slice(0, 11)}… to ${CONFIG_FILE}`);
      }
      if (sub) die("Usage: cb login [--label <name>]      (browser login)\n       cb login <cbk_...> [--label <name>] (paste an existing key)", 2);
      return deviceLogin();
    }
    case "whoami": {
      const d = await api("GET", "/me");
      // The natural "check my state" command also reconciles the whole profile
      // list with the server right now (revoked-elsewhere profiles get pruned).
      await sweepProfiles(true);
      return out(`${d.user?.email || "?"}  (actor: ${d.actor?.label} · ${d.actor?.kind})`, d);
    }
    case "project": {
      if (!sub || sub === "ls") {
        const d = await api("GET", "/projects");
        return out(
          d.projects
            .map((p: any) => `${p.id === PROJECT ? "* " : "  "}${p.id}  ${p.name}${p.color ? " " + p.color : ""}`)
            .join("\n"),
          d,
        );
      }
      if (sub === "new") {
        const name = rest[0];
        if (!name) die("Usage: cb project new <name> [--color --description]", 2);
        const d = await api("POST", "/projects", { name, color: flags.color, description: flags.description });
        return out(`Created project ${d.project.id}  ${d.project.name}`, d);
      }
      if (sub === "use") {
        const id = rest[0];
        if (!id) die("Usage: cb project use <id>", 2);
        writeConfig({ ...cfg, project: id });
        return out(`Default project set to ${id}`);
      }
      return die("Usage: cb project ls|new|use", 2);
    }
    case "agent": {
      if (!sub || sub === "ls") {
        const d = await api("GET", "/agents");
        if (asJson) return out("", d);
        const rows = (d.agents || []).map((a: any) =>
          `${a.slug}${a.crew ? `  crew:${a.crew}` : ""}${a.tool ? `  [${a.tool}]` : ""}  ${a.label}${a.lastUsedAt ? "" : "  (never used)"}`,
        );
        return out(rows.join("\n") || "(no agents registered)", d);
      }
      if (sub === "spawn") {
        // Mint a sibling identity with THIS agent's key — no browser approval.
        // Crews: one identity per crew (docs/design/agent-crews.md).
        const label = rest[0];
        if (!label) die('Usage: cb agent spawn "<label>" [--crew <crew> --tool <tool>]', 2);
        const d = await api("POST", "/agents", { label, crew: flags.crew, tool: flags.tool });
        const agents = { ...(cfg.agents || {}) };
        agents[label] = { agentId: d.agent.slug, key: d.key };
        writeConfig({ ...withoutLegacy(cfg), agents, default: cfg.default || label });
        return out(
          `Registered "${label}"${d.agent.crew ? ` in crew ${d.agent.crew}` : ""}${d.agent.tool ? ` (${d.agent.tool})` : ""}.\n` +
          `Act as it with --label "${label}" or CONTROLBOARD_AGENT="${label}".`,
          d,
        );
      }
      if (sub === "set") {
        const body: Record<string, unknown> = {};
        if (flags.crew !== undefined) body.crew = flags.crew === "none" ? null : flags.crew;
        if (flags.tool !== undefined) body.tool = flags.tool === "none" ? null : flags.tool;
        if (flags.model !== undefined) body.model = flags.model === "none" ? null : flags.model;
        if (!Object.keys(body).length) die("Usage: cb agent set [--crew <crew>|none] [--tool <tool>|none] [--model <m>|none]", 2);
        const d = await api("PATCH", "/agents/self", body);
        return out(`Updated ${d.slug}${"crew" in d ? `  crew: ${d.crew ?? "none"}` : ""}${"tool" in d ? `  tool: ${d.tool ?? "none"}` : ""}`, d);
      }
      return die("Usage: cb agent ls|spawn|set", 2);
    }
    case "frame": {
      if (!sub || sub === "ls") {
        const d = await api("GET", "/frames");
        if (asJson) return out("", d);
        const rows = (d.frames || [])
          .filter((f: any) => !f.archived)
          .map((f: any) => `${f.id}  ${f.title}`);
        return out(rows.join("\n") || "(no frames)", d);
      }
      if (sub === "new") {
        const title = rest[0];
        if (!title) die('Usage: cb frame new "<title>"', 2);
        const d = await api("POST", "/frames", { title });
        return out(`Created frame ${d.frame.id}  ${d.frame.title}`, d);
      }
      return die("Usage: cb frame ls|new", 2);
    }
    case "task":
      return taskCmd(sub, rest);
    case "propose": {
      if (!sub) die('Usage: cb propose "<title>" [--why "..."]', 2);
      const d = await api("POST", "/proposals", { title: sub, why: flags.why, priority: flags.priority });
      return out(`Proposed ${d.task.id}  ${d.task.title}`, d);
    }
    case "inbox": {
      const d = await api("GET", "/inbox");
      if (!d.proposals.length) return out("Inbox empty.", d);
      return out(d.proposals.map((t: any) => `? ${t.id}  ${t.title}  (by ${t.proposedBy || "agent"})`).join("\n"), d);
    }
    case "approve": {
      if (!sub) die("Usage: cb approve <id>", 2);
      return out(`Approved ${sub}`, await api("POST", `/tasks/${enc(sub)}/approve`));
    }
    case "reject": {
      if (!sub) die("Usage: cb reject <id> [--reason]", 2);
      return out(`Rejected ${sub}`, await api("POST", `/tasks/${enc(sub)}/reject`, { reason: flags.reason }));
    }
    case "usage": {
      // Self-report this agent's remaining quota so assigners (human or agent)
      // can route work to whoever has headroom. Feed it from a CodexBar-style
      // reporter, your scheduler, or by hand.
      if (sub === "set") {
        const raw = rest[0] ?? (typeof flags.json === "string" ? flags.json : "");
        if (!raw) die('Usage: cb usage set \'{"plan":"pro","windows":[{"label":"5h","usedPct":38,"resetsAt":"18:00Z"}]}\'', 2);
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { die("usage must be valid JSON", 2); }
        const d = await api("PATCH", "/agents/self", { usage: parsed });
        return out(`Usage reported for ${d.slug}`, d);
      }
      if (sub === "clear") {
        const d = await api("PATCH", "/agents/self", { usage: null });
        return out(`Usage cleared for ${d.slug}`, d);
      }
      if (sub === "sync") {
        // Read real quota from the local tool (CodexBar-style) and push it:
        //   codex  → newest rate_limits snapshot in ~/.codex/sessions/**.jsonl
        //   claude → the saved Claude Code OAuth token → the /api/oauth/usage
        //            endpoint (token never leaves this machine except to Anthropic)
        const tool = typeof flags.tool === "string" ? flags.tool : await detectUsageTool();
        if (tool !== "codex" && tool !== "claude") {
          die("Can't tell which tool to read. Pass --tool codex or --tool claude.", 2);
        }
        const once = async (): Promise<string> => {
          const u = tool === "codex" ? readCodexUsage() : await readClaudeUsage();
          if (!u) {
            die(tool === "codex"
              ? "No codex rate-limit data found (run codex once so ~/.codex/sessions has a session)."
              : "No Claude Code credentials found (sign in to Claude Code first).", 1);
          }
          const d = await api("PATCH", "/agents/self", { usage: u });
          return `Usage synced for ${d.slug} from ${tool}: ` +
            (u as UsageReport).windows.map((w) => `${w.label} ${w.usedPct}%`).join(", ");
        };
        if (flags.watch) {
          const mins = Math.max(5, Number(flags.interval) || 30);
          for (;;) {
            try { console.log(await once()); } catch (e) { console.error(String(e)); }
            await new Promise((r) => setTimeout(r, mins * 60_000));
          }
        }
        return out(await once(), {});
      }
      if (!sub || sub === "ls") {
        const d = await api("GET", "/agents");
        if (asJson) return out("", d);
        const rows = (d.agents || []).map((a: any) => {
          const u = a.usage ? JSON.stringify(a.usage).slice(0, 80) : "-";
          return `${a.slug}${a.model ? `  [${a.model}]` : ""}  ${u}${a.usageAt ? `  (as of ${new Date(a.usageAt).toISOString().slice(0, 16)}Z)` : ""}`;
        });
        return out(rows.join("\n") || "(no agents)", d);
      }
      return die("Usage: cb usage ls|set|sync|clear", 2);
    }
    case "work": {
      if (flags.watch) {
        const execCmd = typeof flags.exec === "string" ? flags.exec : "";
        if (!execCmd) die('Usage: cb work --watch --exec \'claude -p\' [--interval 60]', 2);
        const interval = Math.max(10, Number(flags.interval) || 60);
        return workWatch(execCmd, interval, flags.assigned === true);
      }
      return workOnce(flags.assigned === true);
    }
    case "routine": {
      if (!sub || sub === "ls") {
        const d = await api("GET", "/routines");
        if (asJson) return out("", d);
        const rows = (d.routines || []).map((r: any) =>
          `${r.active ? "●" : "○"} ${r.id}  [${r.cron}]  ${r.name}${r.task?.assignee ? `  → ${r.task.assignee}` : ""}${r.lastRun ? `  (last ${new Date(r.lastRun).toISOString().slice(0, 16)}Z)` : ""}`,
        );
        return out(rows.join("\n") || "(no routines)", d);
      }
      if (sub === "add") {
        const title = rest[0];
        const cron = typeof flags.cron === "string" ? flags.cron : "";
        if (!title || !cron) die('Usage: cb routine add "<task title>" --cron "0 9 * * 1" [--assignee crew:<name> --priority p2 --content "..." --name <label>]', 2);
        const d = await api("POST", "/routines", {
          title, cron, name: flags.name, content: flags.content,
          assignee: flags.assignee, priority: flags.priority, effort: flags.effort,
        });
        return out(`Routine ${d.routine.id} [${d.routine.cron} UTC] creates "${title}"${d.routine.task.assignee ? ` for ${d.routine.task.assignee}` : ""}.`, d);
      }
      if (sub === "pause" || sub === "resume") {
        const id = rest[0];
        if (!id) die(`Usage: cb routine ${sub} <id>`, 2);
        await api("PATCH", `/routines/${enc(id)}`, { active: sub === "resume" });
        return out(`${sub === "resume" ? "Resumed" : "Paused"} ${id}`);
      }
      if (sub === "rm") {
        const id = rest[0];
        if (!id) die("Usage: cb routine rm <id>", 2);
        await api("DELETE", `/routines/${enc(id)}`);
        return out(`Removed ${id} (recoverable server-side)`);
      }
      return die("Usage: cb routine ls|add|pause|resume|rm", 2);
    }
    case "activity": {
      const d = await api("GET", "/activity" + q({ since: flags.since, limit: flags.limit }));
      return out(
        d.activity.map((a: any) => `${new Date(a.createdAt).toISOString().slice(0, 19)}  ${a.actorLabel}  ${a.verb}  ${a.summary || ""}`).join("\n"),
        d,
      );
    }
    case "watch":
      return watch();
    case "version":
      return out(`cb ${CB_VERSION}`, { version: CB_VERSION });
    case "self-update":
      return selfUpdate();
    case "logout":
      return logout(typeof flags.label === "string" ? flags.label : undefined);
    case "skill": {
      if (sub === "install") return skillInstall();
      return die("Usage: cb skill install", 2);
    }
    case "ambient": {
      // Toggle the ambient offer ("track this on ControlBoard?") that the
      // installed skill makes when a session turns into real work.
      const marker = join(CONFIG_DIR, "ambient-off");
      if (sub === "off") {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(marker, "ambient offers disabled by the user; only act on explicit requests.\n");
        return out("Ambient ControlBoard offers are OFF (explicit asks still work). Re-enable: cb ambient on");
      }
      if (sub === "on") {
        try { unlinkSync(marker); } catch { /* was already on */ }
        return out("Ambient ControlBoard offers are ON.");
      }
      return out(`Ambient offers are ${existsSync(marker) ? "OFF" : "ON"}. Use: cb ambient on|off`);
    }
    default:
      return die(`Unknown command: ${cmd}. Run \`cb help\`.`, 2);
  }
}

// ── Client updates ───────────────────────────────────────────────────────────
// The server is the release channel: every deploy publishes fresh bundles at
// <BASE>/cli/cb.mjs and <BASE>/mcp/controlboard-mcp.mjs, and /api/v1/meta says
// what's current. self-update refreshes the installed copies in ~/.controlboard.
async function selfUpdate(): Promise<void> {
  let latest = "unknown";
  try {
    const m = await (await fetch(`${BASE}/api/v1/meta`)).json();
    latest = m.cliLatest || "unknown";
  } catch { /* meta is informational */ }
  const targets = [
    { url: `${BASE}/cli/cb.mjs`, path: join(LIB_DIR, "cb.mjs") },
    { url: `${BASE}/mcp/controlboard-mcp.mjs`, path: join(LIB_DIR, "controlboard-mcp.mjs") },
  ];
  mkdirSync(LIB_DIR, { recursive: true });
  for (const t of targets) {
    const r = await fetch(t.url);
    if (!r.ok) die(`Download failed: ${t.url} -> ${r.status}`, 1);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length < 10_000 || !body.toString("utf8", 0, 30).startsWith("#!/usr/bin/env node")) {
      die(`Sanity check failed for ${t.url} — not updating.`, 1);
    }
    writeFileSync(t.path, body, { mode: 0o755 });
  }
  writeUpdateCache({ checkedAt: Date.now(), latest });
  console.log(`Updated ~/.controlboard/{cb.mjs, controlboard-mcp.mjs} to ${latest} (was running cb ${CB_VERSION}).`);
  console.log("Restart any MCP clients (Claude Code, Codex) to pick up the new bundle.");
}

// Once-a-day, zero-latency update notice: read the cached latest synchronously
// (stderr, so command substitution like t=$(cb work) is never polluted), then
// refresh the cache in the background for next time.
const UPDATE_CACHE = join(CONFIG_DIR, "update-check.json");
function readUpdateCache(): { checkedAt: number; latest: string } | null {
  try { return JSON.parse(readFileSync(UPDATE_CACHE, "utf8")); } catch { return null; }
}
function writeUpdateCache(c: { checkedAt: number; latest: string }): void {
  try { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(UPDATE_CACHE, JSON.stringify(c)); } catch { /* best-effort */ }
}
const semverLt = (a: string, b: string): boolean => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) return false;
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0); }
  return false;
};
async function updateNotice(): Promise<void> {
  if (CB_VERSION === "dev") return;
  const c = readUpdateCache();
  if (c && semverLt(CB_VERSION, c.latest)) {
    console.error(`cb ${CB_VERSION} → ${c.latest} available. Run: cb self-update`);
  }
  if (!c || Date.now() - c.checkedAt > 24 * 3600e3) {
    try {
      const m = await (await fetch(`${BASE}/api/v1/meta`, { signal: AbortSignal.timeout(1500) })).json();
      if (typeof m.cliLatest === "string") writeUpdateCache({ checkedAt: Date.now(), latest: m.cliLatest });
    } catch { writeUpdateCache({ checkedAt: Date.now(), latest: c?.latest ?? CB_VERSION }); }
    // Same daily window: reconcile ALL saved profiles with the server, so a
    // revoke made in the app removes the profile here even if this machine
    // never runs a command as that identity.
    await sweepProfiles(false);
  }
}

// Validate every saved profile against the server and prune the ones the server
// says are deregistered (definitive 401 invalid_api_key). Canonical base only —
// a staging override proves nothing about a credential's home server.
async function sweepProfiles(loud: boolean): Promise<void> {
  if (!CANONICAL_BASE) return;
  const fresh = readConfig();
  const entries = Object.entries(fresh.agents || {}).filter(([, a]) => a?.key);
  for (const [label, a] of entries) {
    try {
      const res = await fetch(`${BASE}/api/v1/me`, {
        headers: { Authorization: `Bearer ${a.key}` },
        signal: AbortSignal.timeout(2500),
      });
      if (res.status === 401) {
        const d: any = await res.json().catch(() => ({}));
        if (d?.error === "invalid_api_key") {
          pruneAgent(label);
          console.error(`Removed profile "${label}" — it was deregistered (revoked in the app). Re-register with: cb login --label ${label}`);
        }
      }
    } catch {
      /* offline/slow — never prune on uncertainty */
    }
  }
  if (loud && entries.length === 0) console.error("(no saved agent profiles to check)");
}

main()
  .then(() => updateNotice())
  .catch((e) => die(String(e?.message || e), 1));
