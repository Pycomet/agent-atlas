# Agent Atlas

**A map of your AI setup.** Agent Atlas scans your AI coding environment and turns it into an interactive mind map — so you can see, at a glance, what your agents and skills are actually good at, what you never use, and what's missing.

![Agent Atlas mapping a real Claude Code setup — 103 capabilities clustered by what they're for, sized by usage, grey = never fired](docs/atlas-map.jpg)

You've probably installed dozens of skills, subagents, and MCP servers into your AI tools. But do you actually know what your setup can do? Agent Atlas reads your configuration and your session history, then draws your whole stack as a living map: every skill, agent, and tool as a node, grouped by what it's for, sized by how often you actually use it.

In one picture you can answer questions you currently can't:

- **What is my setup tuned for?** More engineering than writing? Any research capability at all?
- **What am I paying for but never using?** Every installed MCP server loads its tool schemas into context in every session — unused servers silently cost you tokens every single day.
- **Where are the overlaps and gaps?** Two skills doing nearly the same job; whole capability areas with zero coverage.

## Quick start

```bash
npx agent-atlas-cli
```

That's it. No config, no account. v2 maps every supported tool it detects on your machine:

| Tool | Inventory | Usage data |
|---|---|---|
| **Claude Code** | skills, agents, MCP servers, hooks | full (session transcripts) |
| **Codex CLI** | MCP servers (`config.toml`), `AGENTS.md` | full (session logs) — CLI layout only; the desktop app keeps no public surface and shows as "not detected" |
| **ORGN CDE** | agents, MCP servers, commands (`opencode.jsonc`) | partial (local session DB, read-only) |
| **OpenCode** | same as ORGN CDE (shared format) | partial |
| **Cursor** | MCP servers, skills, rules files | none — nodes render at fixed size with a "usage unavailable" badge; we don't fake numbers |

**Why not ChatGPT / claude.ai / Gemini web?** Their configuration lives on company servers — there is nothing local to read, and no API exposes installed connectors plus usage. We'd rather not pretend. (Gemini CLI and Windsurf adapters are planned.)

```bash
npx agent-atlas --list-tools     # what's detected on this machine
npx agent-atlas --tool cursor    # restrict to one tool (repeatable)
```

Don't have an Anthropic API key handy? It still works:

```bash
npx agent-atlas-cli --rough   # keyword-based classification, no API call at all
```

## Privacy — read this part

Agent Atlas is **read-only and local-only**:

- It never modifies anything on your machine.
- Nothing leaves your machine except one optional classification API call — and that call sends **only the names and descriptions** of your skills/agents/servers. Your session transcripts, your code, and your prompts are never sent anywhere.
- With `--rough`, nothing leaves your machine at all.
- It's open source (MIT). Don't take our word for any of this — read the code.

## How it works

Four stages, one pipeline:

```
Scanner  →  Usage Miner  →  Classifier  →  Renderer
(what's      (what actually   (what each     (the map +
installed)    fires)           piece is for)   diagnostics)
```

1. **Scanner** — inventories skills, subagents, MCP servers, and hooks from your `~/.claude` configuration (plus the current project's `.claude/`).
2. **Usage Miner** — streams your local session transcripts and counts what actually fired in the last 30 days (`--days` to change the window).
3. **Classifier** — one cheap LLM pass scores every item across five capability axes: **engineering, writing, research, design, ops**. Results are cached by content hash, so re-runs are fast and nearly free. Got a classification wrong? Pin the right one in `~/.agent-atlas/overrides.json` — overrides always win.
4. **Renderer** — draws the interactive map: clusters by capability, node size = usage, grey = dead weight, plus a "tuning bar" summarizing your whole stack (`Engineering 61% · Research 17% · …`). Below the map, three diagnostic lists: **dead weight** (with estimated tokens wasted per session), **overlaps** (near-duplicate skills/agents), and **gaps** (capability axes you barely cover). The "Share card" button exports a PNG:

![The exported share card — headline stats, tuning bar, and map snapshot](docs/share-card.png)

## Usage

```bash
npx agent-atlas-cli                  # scan, classify, open the map
npx agent-atlas-cli --json           # dump inventory + usage + classification as JSON
npx agent-atlas-cli --days 90        # widen the usage window
npx agent-atlas-cli --rough          # skip the API, use keyword heuristics
npx agent-atlas-cli --atlas-dir DIR  # custom location for cache + overrides
```

Classification uses your `ANTHROPIC_API_KEY` environment variable if set; otherwise it falls back to rough mode automatically.

## Status / roadmap

| Milestone | What | Status |
|---|---|---|
| M1 | Scanner + Usage Miner (`--json` output) | ✅ done |
| M2 | Classifier — LLM pass, cache, overrides, no-key fallback | ✅ done |
| M3 | Renderer — interactive map + tuning bar (`atlas.html`) | ✅ done |
| M4 | Diagnostics (dead weight, overlaps, gaps) + shareable card | ✅ done |
| v2 M5 | Multi-tool adapter core — `detect()`, `--list-tools`, tool badges/filters | ✅ done |
| v2 M6 | Codex CLI + Cursor adapters | ✅ done |
| v2 M7 | ORGN CDE + OpenCode adapters (read-only SQLite usage) | ✅ done |
| v2 M8 | Cross-tool diagnostics + per-tool tuning bars | ✅ done |
| v2.x | Gemini CLI, Windsurf adapters; recommendations | 💭 planned |
| v2 | Adapters for Cursor, Codex CLI, Gemini CLI; recommendations | 💭 planned |

The full design lives in [SPEC.md](SPEC.md).

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # vitest, runs against the fixture tree in fixtures/
```

All tests run against a fake `~/.claude` tree in `fixtures/` — nothing in the test suite touches your real setup. If you're adding a scanner or classifier change, extend the fixtures and the expected outputs alongside it.

### Releasing

Merging to `main` runs CI only. Publishing to npm happens when a version tag is pushed:

```bash
npm version patch    # or minor / major — bumps package.json, commits, tags vX.Y.Z
git push origin main --follow-tags
```

The [publish workflow](.github/workflows/publish.yml) then verifies the tag matches `package.json`, runs the test suite, builds, and publishes to npm via trusted publishing (OIDC) — no tokens involved.

Contributions welcome — especially adapter implementations for other AI coding tools and hand-labeled classification examples for the rubric.

## Teams

Curious what your whole engineering team's AI stack looks like — aggregate maps, redundant spend, shadow tooling? I'm exploring a team version. Email [alfredemmanuelinyang@gmail.com](mailto:alfredemmanuelinyang@gmail.com).

## License

[MIT](LICENSE) © 2026 Alfred Emmanuel
