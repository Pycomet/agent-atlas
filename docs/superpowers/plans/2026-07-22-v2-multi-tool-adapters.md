# Agent Atlas v2 — Multi-Tool Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Agent Atlas from Claude-Code-only to a unified map across Codex CLI, Cursor, ORGN CDE, and vanilla OpenCode, with cross-tool diagnostics (SPEC_V2.md M5–M8).

**Architecture:** Generalize the v1 `ToolAdapter` into a registry of detectable adapters with tool-namespaced item ids (`<tool>/<kind>:<name>`). Each adapter is a self-contained module + fixture tree + test file; the classifier is untouched; the renderer gains tool badges/filters and per-tool tuning; a new cross-tool diagnostics module consumes the merged inventory.

**Tech Stack:** Node 20+/TypeScript ESM (existing), vitest golden-fixture tests (existing), `smol-toml` (new dep, Codex config), `node:sqlite` (built-in, ORGN CDE/OpenCode session DB — guarded, degrade to inventory-only on older Node).

## Global Constraints

- Branch: `feat/v2-multi-tool-adapters` off current main (`47e52c1`); commit per task; conventional-commit messages.
- All work read-only against user machines: SQLite opened `readOnly: true`; never write outside the repo/`--out`/atlas dir.
- Fixtures only in tests — no test may touch the real `~/.claude`, `~/.codex`, `~/.cursor`, `~/.config/orgn`.
- Privacy invariant (SPEC.md §7): only item names/descriptions ever reach the classification API. Session/transcript/DB content is mined locally only.
- Id format v2: `<tool>/<kind>:<name>` (e.g. `claude-code/skill:git-workflow`). `InventoryItem.tool` is required. `--json` shape change ⇒ version bump to 0.2.0 in the final task, not before.
- Existing 64 tests must stay green after every task (updated expectations allowed in Task 2 only, where ids change).
- Usage honesty: adapters with `usageSupport: 'none'` return `{totalSessions: 0, items: {}}`; renderer must badge, never grey, their nodes.

---

### Task 0: Branch + prereq fix — plugin-skill usage fallback (report.md finding 1)

**Files:**
- Modify: `src/miner.ts` (add fallback matching), `src/scanner.ts` (no change expected — read only)
- Test: `test/miner.test.ts`

**Interfaces:**
- Consumes: v1 `mineUsage(opts)`, `mergeUsage(inventory, usage)`.
- Produces: `mergeUsage` gains a third optional param `inventory`-aware bare-name fallback: a usage entry `skill:X` with no inventory match is credited to the unique inventory item whose id ends with `:X` or `:<suffix after last colon>` when exactly one candidate exists.

- [ ] **Step 1:** `git checkout -b feat/v2-multi-tool-adapters`
- [ ] **Step 2: Failing test** in `test/miner.test.ts`:

```ts
it('credits prefixed plugin skills when transcripts use a different prefix', () => {
  const inventory = { items: [{ id: 'skill:vercel-plugin:deploy', kind: 'skill' as const, name: 'vercel-plugin:deploy', description: null, sourcePath: '/x', sizeBytes: 1 }] };
  const usage = { totalSessions: 2, items: { 'skill:vercel:deploy': { count: 3, lastUsed: '2026-07-01T00:00:00.000Z', sessionsSeen: 2 } } };
  const merged = mergeUsage(inventory, usage);
  expect(merged.items['skill:vercel-plugin:deploy'].count).toBe(3);
});
```

- [ ] **Step 3:** Run `npm test -- miner` → FAIL (count 0).
- [ ] **Step 4:** Implement in `mergeUsage`: after exact-id pass, for each unmatched usage id of shape `skill:<prefix>:<name>` (or bare `skill:<name>`), find inventory ids matching `/^skill:(.+:)?<name>$/` — if exactly one and it has zero exact usage, transfer the entry (sum counts if multiple usage ids map to it, keep max lastUsed). Same rule for `agent:` ids. Never guess when ≥2 candidates.
- [ ] **Step 5:** `npm test` → all green. Commit: `fix: credit plugin-skill usage across prefix mismatches (review finding 1)`.

### Task 1 (M5): Adapter interface v2 + registry

**Files:**
- Modify: `src/adapter.ts` (interface + registry), `src/types.ts` (AdapterContext), `src/cli.ts` (consume registry)
- Test: `test/adapter.test.ts`

**Interfaces (produced — all later tasks depend on these exact shapes):**

```ts
// src/types.ts
export interface AdapterContext {
  homeDir: string;
  projectDir?: string;
  days: number;
  now?: Date;
  /** Per-adapter config from ~/.agent-atlas/config.json, keyed by adapter name. */
  config?: Record<string, unknown>;
}
export type UsageSupport = 'full' | 'partial' | 'none';

// src/adapter.ts
export interface ToolAdapter {
  name: string;          // 'claude-code' | 'codex' | 'cursor' | 'orgn-cde' | 'opencode'
  displayName: string;
  usageSupport: UsageSupport;
  detect(ctx: AdapterContext): Promise<boolean>;
  scan(ctx: AdapterContext): Promise<Inventory>;
  mineUsage(ctx: AdapterContext): Promise<Usage>;
}
export const adapters: ToolAdapter[];               // registry, claude-code first
export async function detectAdapters(ctx: AdapterContext): Promise<ToolAdapter[]>;
```

- [ ] **Step 1: Failing tests** — claude-code adapter satisfies the new interface; `detect()` true iff `<home>/.claude` exists (fixture home → true; empty tmp dir → false); `detectAdapters` returns only detected.
- [ ] **Step 2:** Wrap v1 `scan`/`mineUsage` in `claudeCodeAdapter` implementing the new interface (`usageSupport: 'full'`; `detect` = `fs.stat(join(homeDir, '.claude'))` truthy). CLI builds one `AdapterContext` and iterates `await detectAdapters(ctx)`.
- [ ] **Step 3:** `npm test` green; `node dist/cli.js --json --home fixtures/home --project fixtures/project` output byte-identical to pre-task (ids unchanged in this task). Commit: `refactor: adapter interface v2 with detect() and registry`.

### Task 2 (M5): Tool-namespaced ids + `tool` field

**Files:**
- Modify: `src/types.ts` (`InventoryItem.tool: string`), `src/scanner.ts` (id prefix), `src/miner.ts` (prefix usage ids incl. fallback logic), `src/cli.ts`, `src/diagnostics.ts` (no logic change — ids opaque), `src/renderer/assets/app.js` (ids opaque — verify only)
- Test: every existing test file's expected ids; `fixtures/expected-classifications.json` keys

**Interfaces:**
- Produces: all ids are `<adapter.name>/<kind>:<name>`. The **adapter** applies the prefix: `scan()`/`mineUsage()` in `adapter.ts` wrap the raw v1 functions and rewrite ids (`prefixIds(inv, 'claude-code')`), so `scanner.ts`/`miner.ts` stay tool-agnostic and reusable by other adapters' internals.

- [ ] **Step 1:** Add `prefixInventory(inv: Inventory, tool: string): Inventory` and `prefixUsage(usage: Usage, tool: string): Usage` helpers in `src/adapter.ts` (pure functions: `id = `${tool}/${id}``, set `item.tool = tool`). Unit-test both directly.
- [ ] **Step 2:** Apply in `claudeCodeAdapter.scan/mineUsage`. Update every test expectation and `expected-classifications.json` keys to `claude-code/…`. The Task 0 fallback regex must operate on the un-prefixed tail (`id.split('/').pop()`).
- [ ] **Step 3:** `npm test` green. Real-machine smoke: `node dist/cli.js --json | head` shows `claude-code/` ids. Commit: `feat!: tool-namespaced item ids and InventoryItem.tool`.

### Task 3 (M5): `--list-tools` + `--tool` filter

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces: `--list-tools` prints one line per registered adapter: `name  displayName  detected|not detected  usage:full|partial|none` and exits 0. `--tool <name>` (repeatable) restricts scanning to named adapters (error 1 + list of valid names on unknown). `--json` gains `tools: [{name, displayName, detected, usageSupport, itemCount}]`.

- [ ] **Step 1:** Failing CLI tests (spawn `dist/cli.js` as existing cli tests do): `--list-tools` against fixture home lists `claude-code … detected`; `--tool nope` exits 1; `--json` contains `tools` array.
- [ ] **Step 2:** Implement; `itemCount` computed post-scan (0 for undetected/skipped).
- [ ] **Step 3:** Green; commit: `feat: --list-tools, --tool filter, tools array in --json`.

### Task 4 (M5): Renderer — tool badges + tool filter

**Files:**
- Modify: `src/renderer/assets/app.js`, `src/renderer/assets/style.css`, `src/renderer/index.ts` (pass `tools` metadata into AtlasData), `src/types.ts` (`AtlasData.tools`)
- Test: `test/renderer.test.ts`

**Interfaces:**
- Consumes: `item.tool`, `AtlasData.tools: {name, displayName, usageSupport}[]`.
- Produces: node stroke color keyed by tool (deterministic palette by roster order; single-tool maps render exactly as v1 — no visual regression); "Tools" filter group in `#filters` (same checkbox pattern as kind filters); nodes from `usageSupport==='none'` adapters render at fixed radius 9 with class `no-usage` (dashed stroke) and tooltip line "usage unavailable for <displayName>", never `DEAD` grey; guard from report finding 3: `renderTuning` early-returns with an `.empty-state` message when shares are null.

- [ ] **Step 1:** Failing renderer tests: embedded JSON contains `tools`; HTML contains `id="tool-filters"`; empty-inventory AtlasData renders (no throw) and contains `class="empty-state"`.
- [ ] **Step 2:** Implement (data assertions, not pixels, per SPEC.md §7).
- [ ] **Step 3:** Green; open `atlas.html` from real machine once to eyeball. Commit: `feat: tool badges, tool filter, usage-unavailable + empty states in renderer`.

### Task 5 (M6): Codex CLI adapter (full usage)

**Files:**
- Create: `src/adapters/codex.ts`, `fixtures/codex-home/.codex/config.toml`, `fixtures/codex-home/.codex/sessions/2026/07/session1.jsonl`, `fixtures/codex-home/AGENTS.md`
- Modify: `src/adapter.ts` (register), `package.json` (`smol-toml`)
- Test: `test/codex.test.ts`

**Interfaces:**
- Consumes: `AdapterContext`, `prefixInventory`/`prefixUsage`, `parseFrontmatter` if needed.
- Produces: adapter `{name: 'codex', displayName: 'Codex CLI', usageSupport: 'full'}`; ids `codex/mcp:<server>`, `codex/memory:AGENTS.md (global|project)`; detect = `~/.codex/config.toml` exists.

**Verify-first (SPEC_V2 §3):** before coding, run `cat ~/.codex/config.toml 2>/dev/null | head -30; ls ~/.codex/sessions 2>/dev/null | head` on the real machine. If Codex is not installed locally, fixtures follow the documented format: `[mcp_servers.<name>]` tables with `command`/`args` or `url`; sessions = JSONL with `{"timestamp": iso, "type": "response_item", "payload": {"type": "function_call", "name": "<tool>"}}`-style records. Encode whatever is verified into the fixture README comment.

- [ ] **Step 1:** Write fixture files (≥2 MCP servers, one AGENTS.md, one session log with 3 tool calls incl. one MCP-prefixed name and one out-of-window timestamp).
- [ ] **Step 2:** Failing tests: `detect` true/false; `scan` yields exactly the fixture servers + AGENTS.md memory items with correct `sourcePath`/`sizeBytes`; `mineUsage` respects `days` window and attributes MCP calls to `codex/mcp:<server>`; corrupt TOML → empty inventory, no throw.
- [ ] **Step 3:** Implement with `smol-toml` `parse()` wrapped in try/catch; sessions streamed line-by-line (reuse the readline pattern from `src/miner.ts`).
- [ ] **Step 4:** Green; commit: `feat: Codex CLI adapter (config.toml inventory + session-log usage)`.

### Task 6 (M6): Cursor adapter (inventory-only)

**Files:**
- Create: `src/adapters/cursor.ts`, `fixtures/cursor-home/.cursor/mcp.json`, `fixtures/cursor-project/.cursor/mcp.json`, `fixtures/cursor-project/.cursor/rules/style.mdc`, `fixtures/cursor-project/.cursorrules`
- Modify: `src/adapter.ts` (register)
- Test: `test/cursor.test.ts`

**Interfaces:**
- Produces: `{name: 'cursor', displayName: 'Cursor', usageSupport: 'none'}`; ids `cursor/mcp:<name>`, `cursor/memory:<rules file>`; `mineUsage` returns `{totalSessions: 0, items: {}}`; detect = `~/.cursor` dir exists. `mcp.json` shape is the same `mcpServers` record v1 already parses — export `mcpItems` from `src/scanner.ts` (make it a named export) and reuse; project entries win name-dedup and are attributed to the project path (fixes report finding 6b direction for this adapter).

- [ ] **Step 1:** Fixtures (global + project server with one name collision; one `.mdc` rule with frontmatter `description:`; one `.cursorrules`).
- [ ] **Step 2:** Failing tests → implement → green.
- [ ] **Step 3:** Commit: `feat: Cursor adapter (inventory-only, mcp.json + rules files)`.

### Task 7 (M7): OpenCode family — ORGN CDE + vanilla OpenCode

**Files:**
- Create: `src/adapters/opencode-family.ts` (shared core), `src/adapters/orgn-cde.ts`, `src/adapters/opencode.ts`, `fixtures/opencode-home/.config/orgn/opencode.jsonc`, fixture DB builder in test setup
- Modify: `src/adapter.ts` (register both)
- Test: `test/opencode-family.test.ts`

**Interfaces:**
- Produces: two adapters sharing one core: `orgn-cde` (config `~/.config/orgn/opencode.jsonc`, data `~/.local/share/orgn/opencode.db`, displayName 'ORGN CDE') and `opencode` (`~/.config/opencode/opencode.json(c)`, `~/.local/share/opencode/opencode.db`). `usageSupport: 'partial'`. Ids: `orgn-cde/agent:<name>`, `orgn-cde/mcp:<name>`, `orgn-cde/command:<name>` (new kind `command` added to `ItemKind`), `orgn-cde/memory:AGENTS.md`.
- Config parse: strip `//` line + `/* */` block comments + trailing commas, then `JSON.parse` (tolerant `parseJsonc` helper in the shared core, unit-tested; on failure → empty inventory + `flags: ['invalid-config']` root note, no throw). Inventory from keys: `agent`, `mcp`, `command`, `plugin` records if present.
- Usage: **survey-first.** Step 1 below runs the real-machine survey; queries are written against the discovered schema and wrapped so that a missing table/column ⇒ `{totalSessions: 0, items: {}}` (inventory-only degrade). `node:sqlite` (`new DatabaseSync(path, {readOnly: true})`) guarded behind dynamic import — if unavailable (Node <22) degrade the same way. DB file is copied to a temp path before opening when a `-wal` sibling exists (running CDE lock safety).

- [ ] **Step 1: Schema survey (real machine, read-only)** — `sqlite3 ~/.local/share/orgn/opencode.db '.tables'` and `.schema` for candidate tables (`session`, `message`, `part`…). Commit findings as `docs/opencode-db-survey.md` with the exact query the miner will use (expected shape: count tool-call parts per session in window, grouped by tool name; map `mcp_<server>_<tool>`-style names to `mcp:<server>`, agent invocations to `agent:<name>`).
- [ ] **Step 2:** `parseJsonc` unit tests (comments, trailing commas, corrupt input) → implement.
- [ ] **Step 3:** Fixture `opencode.jsonc` mirroring the real one's shape (provider/model + one `agent`, one `mcp`, one `command` entry); test scan output.
- [ ] **Step 4:** Fixture DB built in test setup via `node:sqlite` using the surveyed schema (skip suite with `describe.skipIf` when `node:sqlite` unavailable); test mineUsage counts + window filtering + missing-table degrade.
- [ ] **Step 5:** Register both adapters; real-machine smoke `node dist/cli.js --list-tools` shows `orgn-cde detected`. Commit: `feat: ORGN CDE + OpenCode adapters (opencode-family core, read-only sqlite usage)`.

### Task 8 (M8): Cross-tool diagnostics + per-tool tuning bars

**Files:**
- Create: `src/cross-tool.ts`
- Modify: `src/types.ts` (report types below), `src/cli.ts` (wire in), `src/diagnostics.ts` (untouched logic; cross-tool lives separately), `src/renderer/assets/app.js` + `style.css` (render new lists + per-tool tuning view)
- Test: `test/cross-tool.test.ts`, `test/renderer.test.ts`

**Interfaces:**

```ts
export interface CrossToolDuplicate { key: string; itemIds: string[]; usedIn: string[]; line: string; }
export interface CapabilityImbalance { axis: Axis; concentratedIn: string; share: number; line: string; }
export interface RulesOverlap { itemIds: string[]; line: string; }
export interface CrossToolReport { duplicates: CrossToolDuplicate[]; imbalance: CapabilityImbalance[]; rulesOverlaps: RulesOverlap[]; }
export function crossToolDiagnose(inventory: Inventory, usage: Usage, classification: ClassificationOutput, tools: ToolMeta[]): CrossToolReport;
```

- Duplicate key = normalized MCP identity: `url` host+path when present else `command`+sorted args (extend `mcpItems` to retain `identity` on the item in Task 6 if not already); only emitted when ≥2 distinct tools share the key. `usedIn` = tools where count>0 (omit usage claim entirely when all owners are usage-less).
- Imbalance: for each axis with total installed weight >0, if one tool holds >80% of it and ≥2 tools are detected → line "All/most <axis> capability lives in <tool>".
- Rules overlap: among `kind==='memory'` items across ≥2 tools, flag pairs whose *file names* indicate instruction files (AGENTS.md, CLAUDE.md, .cursorrules, GEMINI.md, *.mdc) — plain "worth checking they agree" line, no content diffing (SPEC_V2 §4.5.3: human review only).
- Renderer: three new lists appended to the diagnostics section (same DOM pattern as v1 lists); "by tool" toggle in tuning header renders one mini bar per detected tool (reuse `renderTuning` with a per-tool node subset).

- [ ] **Step 1:** Failing unit tests for each of the three detectors with hand-built inventories (incl. the ≥2-tools guards and the no-usage-claim case) → implement `crossToolDiagnose` (pure, no I/O).
- [ ] **Step 2:** Wire into CLI (`--json` gains `crossTool`) + AtlasData; renderer tests assert embedded `crossTool` data + `id="tuning-by-tool"` container; implement rendering.
- [ ] **Step 3:** Green; real-machine run and eyeball. Commit: `feat: cross-tool diagnostics and per-tool tuning bars`.

### Task 9: Release prep 0.2.0

**Files:**
- Modify: `package.json` (0.2.0), `README.md` (v2 tools table + Tier C "why not X" + breaking-change note), `CHANGELOG.md` (create)

- [ ] **Step 1:** README: replace roadmap table (M1–M4 ✅, v2 rows per SPEC_V2 tiers), add `--list-tools`/`--tool` docs, id-format breaking-change note.
- [ ] **Step 2:** `npm run build && npm test` green; full real-machine run `node dist/cli.js` — map shows ≥2 tools (claude-code + orgn-cde minimum).
- [ ] **Step 3:** Commit: `chore: v0.2.0 — multi-tool release prep`. **Do not publish** — npm publish stays a human decision.

## Self-Review (done at write time)

- Spec coverage: M5→Tasks 1–4, M6→5–6, M7→7, M8→8, prereq→0, release→9. SPEC_V2 §4.2 studio-API enrichment is stretch/not-required — deliberately unplanned (YAGNI). Gemini CLI + Windsurf (SPEC_V2 M8 scope) **deferred to a follow-up plan**: verify-first requires real installs, neither is present on this machine; noted in README as "coming".
- Placeholder scan: schema-dependent Task 7 queries are gated behind its Step-1 survey by design, not left "TBD" — the survey commits the exact query before implementation.
- Type consistency: `AdapterContext`, `prefixInventory/prefixUsage`, `UsageSupport`, `CrossToolReport` defined once (Tasks 1–2, 8) and referenced by name elsewhere.
