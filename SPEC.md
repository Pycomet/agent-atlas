# Agent Atlas — v1 Spec

**One-liner:** Agent Atlas scans your AI coding setup and turns it into an interactive mind map — so you can see, at a glance, what your agents and skills are actually good at, what you never use, and what's missing.

**Status:** v1 spec, 2026-07-16. Built on ORGN as a real-world showcase project.

---

## 1. Problem

People using AI coding tools accumulate dozens of skills, subagents, MCP servers, and hooks — and lose track of what they have. Three questions nobody can currently answer without manually reading config files:

1. **What is my setup actually tuned for?** (More engineering than writing? Any research capability at all?)
2. **What am I paying for but never using?** Every installed MCP server loads its tool schemas into context on every session — unused servers silently cost tokens every single day.
3. **Where are the overlaps and gaps?** Two skills that do nearly the same thing; whole capability areas with zero coverage.

Prior-art check (July 2026) confirmed nobody has built this: existing tools do text-only config audits, usage-stats "Wrapped" cards, or run-time flow graphs — none combine **what's installed + how often it fires + what it means** into one visual map.

## 2. Target user & scope

- **v1 target:** Claude Code users (biggest, most vocal audience; richest local data).
- **Out of scope for v1:** Cursor, ChatGPT, Windsurf, other tools. The scanner is built behind an adapter interface so these can be added later, but v1 ships Claude Code only. (M1 shipped the adapter-shaped seam — pure `scan()`/`mineUsage()` functions returning tool-agnostic JSON; the formal `ToolAdapter` interface is an M2 task, see §8.)

## 3. What v1 does (user experience)

```
npx agent-atlas-cli
```

That's the whole product. It:

1. Scans the local machine (read-only — it never modifies anything).
2. Optionally runs one classification pass (needs `ANTHROPIC_API_KEY`; works without it, see §6).
3. Writes a single self-contained `atlas.html` and opens it in the browser.

The page shows:

- **The map** — a force-directed graph (D3, inlined in the HTML, no CDN). Every skill, subagent, MCP server, and hook is a node. Nodes cluster by capability axis, node size = how often it actually fired in the last 30 days, grey = never fired. Click a node → side panel with its description, source file path, invocation count, and classification.
- **The tuning bar** — a header strip summarizing the whole setup: e.g. `Engineering 61% · Research 17% · Writing 12% · Design 6% · Ops 4%`. This answers "what is my stack tuned toward" in one glance.
- **The diagnostics panel** — three lists (see §7).

Flags:

- `--share` — also renders a PNG "Wrapped-style" card (tuning bar + headline stats + map thumbnail) sized for social posts. This is the virality hook.
- `--json` — dump the raw inventory + usage + classification as JSON (makes the tool scriptable and testable).
- `--days <n>` — usage window (default 30).

## 4. Architecture — four stages, one pipeline

```
Scanner → Usage Miner → Classifier → Renderer
  (inventory)   (frequency)    (meaning)     (map + diagnostics)
```

Each stage outputs plain JSON to the next. Stages are independently runnable — this is what makes the build parallelizable on ORGN (one feature per stage).

### 4.1 Scanner (inventory: what's installed)

Reads, read-only:

| Source | What it yields |
|---|---|
| `~/.claude/skills/` + plugin skill dirs | Skills: name, description (from frontmatter), body size |
| `~/.claude/agents/` + project `.claude/agents/` | Subagents: name, description, allowed tools |
| `~/.claude.json` + `settings.json` (user/project/local) | MCP servers: name, transport, and their tool lists where discoverable |
| `settings.json` hooks section | Hooks: event, matcher, command |
| `CLAUDE.md` / memory files | Counted and shown as context load, not classified |

Output: `inventory.json` — a flat list of items, each with `{id, kind, name, description, sourcePath, sizeBytes}`.

Edge cases: missing directories are fine (empty inventory section); malformed frontmatter → item included with `description: null` and flagged, never a crash.

### 4.2 Usage Miner (frequency: what actually fires)

Parses session transcripts at `~/.claude/projects/*/*.jsonl` for the window (default last 30 days), counting per item:

- Skill invocations (`Skill` tool calls, matched by skill name)
- Subagent spawns (`Agent`/`Task` tool calls, matched by `subagent_type`)
- MCP tool calls (`mcp__<server>__*`, attributed to the server)
- Sessions total (denominator for "fires per session")

Output: `usage.json` — `{itemId: {count, lastUsed, sessionsSeen}}` plus `{totalSessions}`.

Notes: transcripts can be large — stream line-by-line, never load whole files. Items in the inventory but absent here get `count: 0`; that's the dead-weight signal, not an error.

### 4.3 Classifier (meaning: what each piece is for)

One LLM pass over the inventory (Claude Haiku — cheap, this is bulk classification). For each item, given its name + description (+ first ~500 chars of body for skills), return:

```json
{ "itemId": "...", "weights": { "engineering": 0.7, "writing": 0.0, "research": 0.2, "design": 0.0, "ops": 0.1 }, "primary": "engineering", "summary": "one plain-English line" }
```

**The five axes (fixed for v1):** engineering, writing, research, design/creative, ops/automation. Deliberately few — five clusters make a readable map; twelve don't.

Quality measures (this is the hard 20% of the project):

- Few-shot rubric in the prompt: 8–10 hand-labeled examples covering ambiguous cases (e.g. a "doc-writer" agent = writing, a "git-workflow" skill = ops, not engineering).
- Batched calls (20 items per request) with strict JSON schema output.
- **Cache by content hash** — re-runs only classify new/changed items, so repeat runs are near-free and fast.
- **Override file** — `~/.agent-atlas/overrides.json` lets the user pin any item's classification; overrides always win. This is the escape hatch for misclassifications.

### 4.4 Renderer (the map)

Generates one self-contained `atlas.html`:

- D3 force-directed graph, inlined (no external requests — works offline, safe to share the file).
- Cluster force by primary axis; node radius scaled by `log(count+1)`; grey fill for `count === 0`; node shape or icon by kind (skill / agent / MCP / hook).
- Edges: item → its axis hub; plus dashed edges between overlap pairs (from diagnostics).
- Tuning bar computed as the usage-weighted sum of axis weights (so it reflects what you *use*, with an "installed vs used" toggle to compare against what you merely *have* — the gap between the two bars is itself an insight).
- `--share` card: rendered via the same HTML in a headless pass, or a plain SVG→PNG export button in the page (v1 does the in-page export button; zero extra dependencies).

## 5. Diagnostics (the "helps you improve the system" part)

Three lists under the map, each with a plain-English one-liner per finding:

1. **Dead weight** — items with 0 invocations in the window. For MCP servers, include the estimated context cost: sum the server's tool-schema JSON size, ÷4 for a token estimate, × total sessions. Rendered as: *"`notion-mcp`: never used in 30 days, ~2,100 tokens loaded into every one of your 84 sessions (~176k tokens total)."* This is the single most shareable finding.
2. **Overlaps** — pairs whose classification weights and descriptions are highly similar (cosine similarity on weights + embedding or LLM yes/no check on descriptions). Rendered as: *"`code-reviewer` and `feature-dev:code-reviewer` appear to do the same job — you've used one 31 times and the other never."*
3. **Gaps** — axes whose installed-capability share is below a threshold (e.g. <5%): *"You have no research-oriented skills or agents. If you do research tasks, everything runs on the raw model."*

v1 stops at *reporting*. It does not auto-uninstall, auto-install, or recommend specific marketplace items — that's v2 territory and keeping v1 read-only keeps it trustworthy.

## 6. No-API-key fallback

Without `ANTHROPIC_API_KEY`, classification falls back to a keyword heuristic (term lists per axis over name+description). Clearly labeled "rough mode" in the UI with a note that a key upgrades accuracy. This matters: the demo must work for anyone who runs `npx agent-atlas-cli` with zero setup.

## 7. Tech stack

- **Node + TypeScript CLI**, published as `agent-atlas-cli` on npm (`agent-atlas` was taken by an unrelated package). No server, no accounts, no telemetry. Nothing leaves the machine except the classification API call (and the prompt sends only names/descriptions, never transcript content — say this in the README).
- D3 (bundled/inlined), `commander` for the CLI, Anthropic SDK for classification. No other heavy deps.
- Testing: golden-fixture tests — a fake `~/.claude` directory tree + fake transcripts in `fixtures/`, assert on the JSON output of each stage. The renderer is tested by asserting on the data embedded in the HTML, not pixels.

## 8. Milestones (ORGN features)

| # | Feature | Done when |
|---|---|---|
| M1 | Scanner + Usage Miner | `npx agent-atlas-cli --json` prints correct inventory+usage for the fixture tree and for Alfred's real machine |
| M2 | Classifier | Fixture items classified correctly against hand-labeled expectations; cache + overrides work; heuristic fallback works with no key. Also: formalize the §2 adapter interface — declare a `ToolAdapter` interface (`scan() → Inventory`, `mineUsage() → Usage`), rename the M1 Claude Code implementation to `ClaudeCodeAdapter`, and have the CLI iterate adapters. No behavior change; existing golden tests still pass unmodified |
| M3 | Renderer | `atlas.html` opens with clustered map, tuning bar, working node detail panel |
| M4 | Diagnostics + share card | Three diagnostic lists render with real numbers; PNG export works |

M1 is the demo-able core in itself ("look what it found on my machine"); each later milestone strictly improves the same demo.

## 9. Cut from v1 (explicitly)

- Other AI tools (Cursor/ChatGPT/etc.) — adapter interface only
- Recommendations ("install X to fill this gap") and any write actions
- Hosted web version, accounts, team/org aggregation
- Historical trends over time ("your stack in March vs July")
- Windows support beyond best-effort path handling (macOS/Linux first)

## 10. Risks

| Risk | Mitigation |
|---|---|
| Classification quality (the hard 20%) | Few-shot rubric, override file, heuristic fallback, hand-labeled fixture set as regression tests |
| Transcript format changes between Claude Code versions | Parser tolerates unknown line types; usage counts degrade gracefully to 0 rather than crash |
| Map unreadable with 100+ items | Cluster collapse/expand, filter by kind, hide-zero-usage toggle |
| Privacy concerns ("it reads my transcripts") | Read-only, local-only, only names/descriptions sent to API — stated loudly in README and in the page footer |

## 11. Demo shape (for the ORGN post)

Screen-recording, ~45 seconds: type `npx agent-atlas-cli`, the map blooms open, hover two big nodes, point at the grey cluster, show the dead-weight line with the token number, end on the share card. Caption: *"I asked my AI setup what it's actually good at. Built with ORGN."*
