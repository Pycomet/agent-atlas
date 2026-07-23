# OpenCode / ORGN CDE — local data survey (2026-07-22)

Surveyed read-only on a real ORGN CDE install (`~/.local/share/orgn/opencode.db`, 102 sessions).

## Config: `~/.config/orgn/opencode.jsonc`
JSONC (comments + trailing commas). Relevant keys: `agent` (record), `mcp` (record),
`command` (record), `provider`/`model` (ignored — not capabilities). **Caution:** naive
`//`-comment stripping corrupts URLs inside strings (`"$schema": "https://…"`) — the
parser must be string-aware.

## DB schema (tables used)
- `session(id, project_id, title, time_created, …)` — `time_created` epoch **ms**.
- `message(id, session_id, time_created, data JSON)` — `data.agent` is the agent name
  (e.g. `"build"`), `data.role` user/assistant.
- `part(id, message_id, session_id, time_created, data JSON)` — `data.type`:
  `tool | step-start | step-finish | text | reasoning | patch | compaction | file`.
  For `type='tool'`: `data.tool` is the tool name.

## Tool naming
- Builtins: `read`, `bash`, `glob`, `skill`, … (not inventory items — not counted).
- MCP tools: `<configMcpKey>_<toolName>`, e.g. `origin-edge-mcp_health_check` for config
  server `origin-edge-mcp`. Attribution = longest config-key prefix match on `_`.

## Queries the miner uses (read-only)
```sql
SELECT json_extract(data,'$.tool') AS tool, time_created, session_id
  FROM part WHERE json_extract(data,'$.type')='tool' AND time_created >= :cutoffMs;
SELECT json_extract(data,'$.agent') AS agent, time_created, session_id
  FROM message WHERE json_extract(data,'$.agent') IS NOT NULL AND time_created >= :cutoffMs;
SELECT COUNT(DISTINCT session_id) FROM part WHERE time_created >= :cutoffMs;
```
Missing table/column ⇒ degrade to inventory-only (`{totalSessions: 0, items: {}}`).
DB opened with `node:sqlite` `DatabaseSync(path, {readOnly: true})`; when unavailable
(Node < 22.5) the adapter degrades the same way. usageSupport: 'partial' (tool parts
cover MCP + agents; skills/commands usage not yet attributable).
