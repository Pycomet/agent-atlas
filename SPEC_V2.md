# Agent Atlas — v2 Spec: Multi-Tool Adapters

**Builds on:** `SPEC.md` (v1, shipped) — this spec covers the headline item deliberately cut from v1 (§9): support for AI assistants beyond Claude Code.
**Date:** 2026-07-22

---

## 1. Goal

v1 answers "what can my Claude Code setup do?" v2 answers **"what can my whole AI setup do?"** — one map across every AI coding assistant installed on the machine, plus the ORGN workspace, with cross-tool insights no single-tool view can give:

- *"You have the GitHub MCP server installed in four different tools — it fires in one of them."*
- *"Your Cursor setup is 80% engineering; your Claude Code setup carries all your writing and research capability."*
- *"Three tools have overlapping rules files that say different things."*

The honest boundary from v1 stands: **we can only map tools that keep their data where we can read it** (local files, or an API the user authorizes). Web-hosted assistants with server-side config (ChatGPT web, claude.ai, Gemini web) remain out of scope — there is nothing local to scan and no API that exposes installed connectors + usage.

## 2. Prerequisites (before any v2 work)

1. **Fix `report.md` findings 1 and 2** (plugin-skill usage attribution; project-scoped MCP servers in `~/.claude.json`). v2 multiplies inventory sources; attribution bugs multiply with them.
2. **One real-machine validation run** of v1 (`--json` against the real home dir) recorded as a golden reference.

## 3. Supported tools (the adapter roster)

Tiered by data quality. Every adapter is **verify-first**: config paths below are the implementation starting point, but each adapter's first task is confirming paths/formats against a real install and encoding them into fixtures — these tools change their layouts without notice.

### Tier A — full support (inventory + usage)

| Tool | Inventory sources | Usage source |
|---|---|---|
| **Claude Code** (v1, baseline) | `~/.claude` skills/agents/plugins, `~/.claude.json`, settings | `~/.claude/projects/*/*.jsonl` transcripts |
| **OpenAI Codex CLI** | `~/.codex/config.toml` (MCP servers, profiles), `AGENTS.md` (global + project) | `~/.codex/sessions/**/*.jsonl` session logs |
| **ORGN CDE** (OpenCode-based) | `~/.config/orgn/opencode.jsonc` (agents, MCP servers, commands, models via ORGN Gateway), `AGENTS.md` rules | `~/.local/share/orgn/opencode.db` — local SQLite session store (read-only queries) |
| **OpenCode** (vanilla) | `~/.config/opencode/opencode.json(c)` — same format as ORGN CDE | `~/.local/share/opencode/opencode.db` — shared adapter code with ORGN CDE |

### Tier B — inventory + partial or no usage

| Tool | Inventory sources | Usage caveat |
|---|---|---|
| **Cursor** | `~/.cursor/mcp.json`, project `.cursor/mcp.json`, `.cursor/rules/*.mdc`, `.cursorrules` | No reliably parseable local usage log — ships **inventory-only**; nodes render at uniform size with a "usage unavailable" badge |
| **Gemini CLI** | `~/.gemini/settings.json` (mcpServers), `GEMINI.md`, extensions dir | Local logs exist but format is unstable — attempt, degrade to inventory-only |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json`, rules files | Inventory-only |

### Tier C — explicitly out (say so in the README)

ChatGPT web / claude.ai / Gemini web (server-side config, no local data); VS Code Copilot (extension-internal storage, no stable surface); anything requiring scraping an app's private database. Listed in the README as "why not X" — honesty is part of the product's trust story.

**Adding a tool later** = one new adapter file + fixtures + a roster entry. That's the whole point of the interface.

## 4. Architecture changes

### 4.1 Adapter interface (generalized from v1)

v1's `ToolAdapter` assumed local filesystem + `homeDir`. v2 generalizes:

```ts
interface ToolAdapter {
  name: string;                          // 'claude-code' | 'codex' | 'cursor' | 'orgn' | ...
  displayName: string;
  usageSupport: 'full' | 'partial' | 'none';
  detect(ctx: AdapterContext): Promise<boolean>;   // is this tool present/configured?
  scan(ctx: AdapterContext): Promise<Inventory>;
  mineUsage(ctx: AdapterContext): Promise<Usage>;  // returns {totalSessions: 0, items: {}} when unsupported
}
```

- `AdapterContext` carries `homeDir`, `projectDir`, `days`, and (new) optional per-adapter config from `~/.agent-atlas/config.json` — this is where the ORGN API token lives.
- **Item ids become tool-namespaced:** `claude-code/skill:git-workflow`, `codex/mcp:github`. Every `InventoryItem` gains a `tool` field. This prevents cross-tool id collisions and makes attribution unambiguous. (v1 ids migrate to the `claude-code/` prefix — a breaking change to the `--json` shape; bump to 0.2.0 and note it.)
- **`detect()` before `scan()`:** the CLI runs every registered adapter's `detect()`, scans only the present ones, and reports "found: Claude Code, Codex, Cursor" so the user sees coverage explicitly.

### 4.2 The ORGN CDE adapter (OpenCode family)

ORGN CDE is built on OpenCode, so it is a **local, file-based Tier A adapter** — verified on a real install (2026-07-22):

- **Inventory:** `~/.config/orgn/opencode.jsonc` — OpenCode-format config carrying agents, MCP servers, commands, and model/provider setup (ORGN Gateway); plus `AGENTS.md` rules files (global + project) in the "context, not classified" bucket.
- **Usage:** `~/.local/share/orgn/opencode.db` — a local SQLite session store. The adapter opens it **read-only** (SQLite `mode=ro`, and copy-on-read if the DB is locked by a running CDE) and counts tool/agent/MCP invocations per session within the window. `better-sqlite3` or `node:sqlite` — pick at implementation time; schema survey is the milestone's first task.
- **Shared OpenCode core:** the parser for config + DB lives in an `opencode-family` module; the vanilla **OpenCode** adapter (`~/.config/opencode`, `~/.local/share/opencode`) is the same code with different paths. Two adapters for the price of one.
- **Optional workspace enrichment (stretch, not required for M7):** the ORGN studio API (the same surface the `ask-orgn` MCP server uses) can add workspace-level data — registered agents, task runs across the team. Auth via token in `~/.agent-atlas/config.json`, never a CLI flag. Without it, the adapter is fully functional on local data alone.
- **Privacy note:** the ORGN config contains team/user ids and the DB contains session content — same rule as v1 transcripts: mined locally, never sent to the classification API (only names/descriptions go out).

### 4.3 Classifier — unchanged, one addition

The classifier is already tool-agnostic (it sees name + description + kind). One addition: **rules files** (`.cursorrules`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/*.mdc`) join `CLAUDE.md` in the "memory/context, counted but not classified" bucket from v1 — same treatment, new sources.

### 4.4 Renderer additions

- **Tool badge on every node** (small icon/color ring) + a **tool filter** in the legend panel alongside the kind filter.
- **Per-tool tuning bars:** the header gains a "by tool" view — one mini tuning bar per detected tool, stacked. This is the "Cursor is all engineering, Claude Code carries your writing" insight in one glance.
- **Uniform-size rendering for usage-less tools** with a visible "usage unavailable" badge — never fake sizes, never grey them (grey means *never used*, which we can't claim without usage data).

### 4.5 Cross-tool diagnostics (the v2 payoff)

Three new diagnostic lists, alongside v1's three:

1. **Cross-tool duplicates:** the same MCP server (matched by command/URL, not just name) installed in N tools. Rendered with usage contrast where available: *"`github` MCP is installed in Claude Code, Codex, and Cursor — it has only ever fired in Claude Code."*
2. **Capability imbalance:** per-tool tuning profiles diverging sharply — surfaced as a plain-English line, not a judgment: *"All research capability lives in Claude Code; Codex and Cursor have none."*
3. **Conflicting rules files:** rules/context files across tools whose instructions overlap in topic (classifier similarity on their summaries) — flagged for human review only, no automated conflict detection: *"`.cursorrules` and `CLAUDE.md` both give code-style instructions — worth checking they agree."*

Dead-weight token math stays per-tool (context cost is per-session *within* a tool).

## 5. CLI surface

```bash
npx agent-atlas                  # auto-detect all tools, unified map
npx agent-atlas --tool codex     # restrict to one tool (repeatable)
npx agent-atlas --list-tools     # show detected tools + data quality, then exit
```

`--json` output gains `tools: [{name, detected, usageSupport, itemCount}]` and the namespaced ids.

## 6. What stays cut (v3+)

- Recommendations / auto-fix ("install X to fill this gap") — still reporting-only
- Hosted web version, accounts, **team aggregation** (note: the ORGN adapter is the natural seed for the team version discussed for the paid tier — but v2 keeps it single-user)
- Historical trends over time
- Windows beyond best-effort paths

## 7. Milestones

| # | Feature | Done when |
|---|---|---|
| M5 | Adapter interface v2 + tool-namespaced ids + `detect()`/`--list-tools` + tool badges/filter in renderer | v1 behavior identical through the new interface; fixtures green; `--list-tools` correct on the real machine |
| M6 | Codex adapter (full) + Cursor adapter (inventory-only) | Fixture trees for both; real-machine verification of paths/formats recorded in the fixture README; Codex usage counts match a hand-checked session log |
| M7 | ORGN CDE + vanilla OpenCode adapters (shared `opencode-family` module) | SQLite schema survey doc committed; inventory + session usage render from the real `~/.config/orgn` + `opencode.db`; read-only DB access verified against a running CDE |
| M8 | Gemini CLI + Windsurf adapters + cross-tool diagnostics + per-tool tuning bars | All three cross-tool diagnostic lists render with real numbers; unified map on the real machine shows ≥3 tools |

Sequencing rationale: M5 is pure refactor (riskiest to delay), M6 proves the interface on the two most-requested tools, M7 is the showcase tie-in, M8 is the payoff layer. Each milestone is demo-able — M6 alone yields the "one map, three tools" screenshot that headlines the v2 announcement.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Config paths/formats drift per tool version | Verify-first rule per adapter; fixtures encode the verified format; parsers tolerate unknown fields; degrade to partial inventory rather than crash |
| Usage claims on partial data mislead | `usageSupport` surfaced in UI and README; uniform-size + badge for usage-less tools; never grey without data |
| OpenCode DB schema undocumented / may change between versions | M7 starts with a schema survey against the real DB; queries tolerate missing tables (degrade to inventory-only); DB opened read-only so a schema surprise can never corrupt anything |
| Id migration breaks v1 consumers of `--json` | Version bump to 0.2.0, changelog note, `tool` field additive |
| Scope creep ("support everything") | Roster is fixed for v2; new tools are v2.x point releases, one adapter each |
