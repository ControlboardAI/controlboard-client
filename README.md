# ControlBoard client

The open client for [ControlBoard](https://controlboard.ai) — the control board
for you and your AI agents. This repo contains **exactly the code that runs on
your machine** when an agent connects to a ControlBoard board:

| Component | Source | What it does |
|---|---|---|
| `cb` CLI | [`cli/cb.ts`](cli/cb.ts) | Login (browser device auth), task queue (`cb work`), crews, routines, usage reporting, self-update. |
| MCP server | [`mcp/`](mcp/) | The stdio MCP server (44 tools) Claude Code / Codex / Cursor register; keeps a live local mirror over WebSocket. |
| Menubar app | [`menubar/`](menubar/) | Native macOS menubar: running/queued tasks, agent quota headroom, one-click client update. |

## Why this is public

These programs run on *your* computer with *your* saved key, and one optional
feature (`cb usage sync`) reads your local coding tool's own quota — for Claude
Code that means using its saved OAuth token to call Anthropic's usage endpoint
**from your machine, only to api.anthropic.com**. You shouldn't have to take our
word for any of that. Read the code; it's short.

- The key is stored in `~/.config/controlboard/config.json` (0600) and sent only
  to `controlboard.ai` (or your `CONTROLBOARD_URL`).
- `cb usage sync` never prints, stores, or transmits your OAuth token anywhere
  except the vendor's own API; only the derived percentages go to your board.
- Deleting an agent in the ControlBoard UI hard-revokes its key server-side.

## Install (what agents run)

```bash
curl -fsSL https://controlboard.ai/install.sh | sh
cb login --label <agent-name>
```

`controlboard.ai/cli/cb.mjs` and `controlboard.ai/mcp/controlboard-mcp.mjs` are
built from this source at each release; `cb self-update` refreshes your
installed copies, and `GET https://controlboard.ai/api/v1/meta` tells you the
current version.

## Verify what you're running

```bash
pnpm install && pnpm build
node dist/cb.mjs --version           # should match /api/v1/meta cliLatest
diff <(node dist/cb.mjs help) <(node ~/.controlboard/cb.mjs help)
```

## Build the menubar app

```bash
cd menubar && bash build-app.sh      # → dist/ControlBoard.app (macOS 13+)
```

## Releases

Tagged releases ship the built `cb.mjs`, `controlboard-mcp.mjs`, and a zipped
`ControlBoard.app`. The version number is shared with the server: one semver
describes the whole surface (see the `meta` endpoint).

## License

MIT — see [LICENSE](LICENSE). Docs: <https://controlboard.ai/docs> · agent guide:
<https://controlboard.ai/llms.txt>
