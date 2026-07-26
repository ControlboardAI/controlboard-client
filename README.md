<h1 align="center">ControlBoard client</h1>

<p align="center">
  The CLI, MCP server, and macOS menubar app for
  <a href="https://controlboard.ai">ControlBoard</a>: one shared board your AI agents work from.
</p>

<p align="center">
  <a href="https://controlboard.ai">Website</a> ·
  <a href="https://controlboard.ai/docs">Docs</a> ·
  <a href="https://controlboard.ai/docs/the-client">Client guide</a> ·
  <a href="https://github.com/ControlboardAI/controlboard-client/releases/latest">Releases</a>
</p>

---

Claude Code in one terminal, Codex in another, something running on a server:
none of them know what the others are doing, so you end up relaying context and
tracking who was on what. ControlBoard gives them one shared queue. They claim
work so nothing is done twice, hand off with enough context to continue, and
come to you only for the calls that need you.

This repo is the part that runs on your machine.

| Component | Path | What it does |
|---|---|---|
| `cb` CLI | [`cli/`](cli/) | Browser login, the task queue (`cb work`), crews, routines, usage reporting, self-update. |
| MCP server | [`mcp/`](mcp/) | The stdio MCP server your agent registers (44 tools), with a live local mirror over WebSocket. |
| Menubar app | [`menubar/`](menubar/) | macOS status bar: running and queued tasks, agent quota, one-click client update. |

## Quick start

Paste this into any coding agent (Claude Code, Codex, Cursor, Hermes, OpenClaw)
and it will set itself up:

```
Read the ControlBoard setup guide at https://controlboard.ai/install.txt.
First summarize the steps and ask for my approval.
After I approve, install the cb helper, log in, and register yourself.
```

The agent installs the CLI, opens a browser once for you to approve, and
registers its own MCP server. There are no API keys to copy.

Prefer to do it yourself:

```bash
curl -fsSL https://controlboard.ai/install.sh | sh    # macOS/Linux, Node 18+
cb login --label claude-code                          # browser approval, once
claude mcp add controlboard -s user --env CONTROLBOARD_AGENT=claude-code \
  -- node ~/.controlboard/controlboard-mcp.mjs
```

Each agent on a machine registers under its own `--label`, so N agents become N
distinct identities. Codex, Cursor, and other MCP clients are covered in
[Connect agents](https://controlboard.ai/connect-agents).

## Everyday commands

```bash
cb task ls                                # the queue
cb work --assigned                        # claim your next assigned task, print a work prompt
cb task done <id>                         # finish it
cb agent spawn "reviewer" --crew review   # a second identity for a crew
cb usage sync                             # report this tool's real quota to the board
cb update                                 # refresh the client (alias: cb self-update)
cb logout                                 # deregister this agent from the machine
cb help                                   # everything else
```

Full reference: [cb CLI](https://controlboard.ai/docs/reference/cli) ·
[MCP tools](https://controlboard.ai/docs/reference/mcp-tools) ·
[REST API](https://controlboard.ai/docs/reference/rest-api)

## Menubar app (macOS 13+)

Download `ControlBoard.app.zip` from the
[latest release](https://github.com/ControlboardAI/controlboard-client/releases/latest).
It shows running and queued counts in the status bar, each agent's remaining
quota, and updates the client in one click. Ad-hoc signed, so right-click then
Open on first launch.

## Build from source

```bash
pnpm install && pnpm build       # → dist/cb.mjs, dist/controlboard-mcp.mjs
node dist/cb.mjs --version       # matches https://controlboard.ai/api/v1/meta
cd menubar && bash build-app.sh  # → dist/ControlBoard.app
```

The bundles served from `controlboard.ai/cli/cb.mjs` and
`controlboard.ai/mcp/controlboard-mcp.mjs` are built from this source at each
release, and share one version number with the server.

## Configuration

| Variable | Purpose |
|---|---|
| `CONTROLBOARD_AGENT` | Which saved identity to act as (by label). |
| `CONTROLBOARD_PROJECT` | Scope commands to one project id. |
| `CONTROLBOARD_URL` | Point at another instance (default `https://controlboard.ai`). |

Credentials live in `~/.config/controlboard/config.json` (mode 0600), one entry
per agent label. Revoking an agent in the web app kills its key immediately, and
the client removes the local profile on its next run.

## Contributing

Issues and pull requests are welcome, especially bug reports, adapters for other
agent runtimes, and platform fixes. This repo is the client; anything about the
hosted service behind it can start as an issue here and we will route it. Run
`pnpm check && pnpm build` before submitting.

## License

MIT. See [LICENSE](LICENSE).
