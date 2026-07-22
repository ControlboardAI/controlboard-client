# ControlBoard MCP server

A stdio [MCP](https://modelcontextprotocol.io) server that lets AI agents
(Claude Code, Codex, Open Claude, …) read and manage a user's ControlBoard via
their personal API key.

`server.ts` is bundled at build time (esbuild) into a single self-contained file
served from the production site at:

    https://controlboard.ai/mcp/controlboard-mcp.mjs

## Use

1. Create an API key at https://controlboard.ai/app → avatar menu →
   **API keys for agents** → Create key.
2. Download and register the server:

   ```bash
   curl -fsSL https://controlboard.ai/mcp/controlboard-mcp.mjs -o controlboard-mcp.mjs
   claude mcp add controlboard --env CONTROLBOARD_API_KEY=cbk_... -- node $PWD/controlboard-mcp.mjs
   ```

   Or any MCP client via JSON:

   ```json
   {
     "mcpServers": {
       "controlboard": {
         "command": "node",
         "args": ["/absolute/path/controlboard-mcp.mjs"],
         "env": { "CONTROLBOARD_API_KEY": "cbk_..." }
       }
     }
   }
   ```

## Env

- `CONTROLBOARD_API_KEY` (required) — your ControlBoard key (`cbk_…`).
- `CONTROLBOARD_URL` (optional) — defaults to `https://controlboard.ai`.

## Tools

`get_me`, `list_agents`, `get_board`, `list_items`, `create_item`, `update_item`,
`delete_item`, `set_item_done`, `set_item_archived`, `assign_task`,
`set_task_status`, `list_statuses`, `create_status`, `update_status`,
`delete_status`, `move_item_to_frame`, `list_frames`, `create_frame`,
`update_frame`, `delete_frame`, `relayout_frame` (plus the task-queue tools —
`list_tasks`, `get_next_task`, `claim_task`, dependencies, proposals, sync).

Item flags: `done` (true/false) marks an item complete — the app strikes the text
through; `archived` hides it from the board/timeline (restorable from the profile
menu). Toggle with `set_item_done {id, done}` / `set_item_archived {id, archived}`
(or `update_item {id, done|archived}`). A whole frame and its items can be
archived/restored with `update_frame {id, archived}`.

Statuses are per-project custom Kanban columns (`list_statuses` / `create_status`);
set an item's column with `set_task_status {id, status}` (a status id, name, or role
keyword). Assign work with `assign_task {id, assignee}` — `'me'`, `'agent:<slug>'`
(see `list_agents`), or `null`.

All calls go to the API-key-authenticated REST API under `/api/v1` (see
`/llms.txt` for the full HTTP contract).
