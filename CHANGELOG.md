# Changelog

## 0.2.0 — 2026-07-22

**Multi-tool release** (SPEC_V2 M5–M8): one map across every AI coding tool on the machine.

### Added
- Adapter registry with `detect()` — only present tools are scanned; `--list-tools` and repeatable `--tool <name>` CLI flags; `tools` array in `--json`.
- **Codex CLI** adapter: MCP servers from `~/.codex/config.toml`, `AGENTS.md` (global + project), full usage from `~/.codex/sessions/**/*.jsonl`.
- **Cursor** adapter (inventory-only): global + project `mcp.json`, `skills-cursor/*/SKILL.md`, `.cursor/rules/*.mdc`, `.cursorrules`.
- **ORGN CDE** and **OpenCode** adapters (shared OpenCode-family core): agents/MCP/commands from `opencode.jsonc` (string-aware JSONC parser), partial usage from the local `opencode.db` SQLite store — opened strictly read-only, copy-on-read under WAL locks, degrades to inventory-only on schema surprises or Node < 22.5.
- Cross-tool diagnostics: duplicate MCP servers across tools (matched by normalized command/URL identity, usage contrast where honest), capability imbalance per axis, overlapping rules files flagged for human review.
- Renderer: tool badges (stroke color) + tool filter, "by tool" tuning view, fixed-size "usage unavailable" rendering for tools without usage data.
- Plugin-skill usage is now credited across prefix mismatches when the match is unambiguous (review finding 1).

### Breaking
- Item ids are tool-namespaced: `skill:git-workflow` → `claude-code/skill:git-workflow`. `InventoryItem` gains `tool`; MCP items gain `identity`; `--json` gains `tools` and `crossTool`.
