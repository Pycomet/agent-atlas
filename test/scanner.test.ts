import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scan } from '../src/scanner.js';
import type { InventoryItem } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');

const fileSize = (p: string): number => statSync(p).size;
const mcpEntrySize = (configFile: string, server: string): number => {
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  return Buffer.byteLength(JSON.stringify(config.mcpServers[server]), 'utf8');
};
const nestedMcpEntrySize = (configFile: string, projectPath: string, server: string): number => {
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
    projects: Record<string, { mcpServers: Record<string, unknown> }>;
  };
  return Buffer.byteLength(JSON.stringify(config.projects[projectPath]!.mcpServers[server]), 'utf8');
};

describe('scan', () => {
  it('produces the full golden inventory for the fixture tree', async () => {
    const inventory = await scan({ homeDir: HOME, projectDir: PROJECT });

    const expected: InventoryItem[] = [
      {
        id: 'agent:code-reviewer',
        kind: 'agent',
        name: 'code-reviewer',
        description: 'Reviews code for quality, security, and maintainability.',
        sourcePath: join(HOME, '.claude', 'agents', 'code-reviewer.md'),
        sizeBytes: fileSize(join(HOME, '.claude', 'agents', 'code-reviewer.md')),
        tools: ['Read', 'Glob', 'Grep'],
      },
      {
        id: 'agent:doc-writer',
        kind: 'agent',
        name: 'doc-writer',
        description: 'Writes and updates documentation, READMEs, and changelogs.',
        sourcePath: join(HOME, '.claude', 'agents', 'doc-writer.md'),
        sizeBytes: fileSize(join(HOME, '.claude', 'agents', 'doc-writer.md')),
        tools: ['Read', 'Write', 'Edit'],
      },
      {
        id: 'agent:proposal-agent',
        kind: 'agent',
        name: 'proposal-agent',
        description: 'Writes targeted client proposals and job application responses.',
        sourcePath: join(PROJECT, '.claude', 'agents', 'proposal-agent.md'),
        sizeBytes: fileSize(join(PROJECT, '.claude', 'agents', 'proposal-agent.md')),
        tools: ['Read', 'Glob'],
      },
      {
        id: 'hook:PostToolUse:Bash',
        kind: 'hook',
        name: 'PostToolUse(Bash)',
        // Never the raw command — commands can hold secrets and descriptions reach the API.
        description: 'PostToolUse hook (Bash)',
        sourcePath: join(HOME, '.claude', 'settings.json'),
        sizeBytes: Buffer.byteLength(
          JSON.stringify({ type: 'command', command: "echo 'bash done' >> ~/.claude/hook.log" }),
          'utf8',
        ),
        event: 'PostToolUse',
        matcher: 'Bash',
        command: "echo 'bash done' >> ~/.claude/hook.log",
      },
      {
        id: 'hook:SessionStart:*',
        kind: 'hook',
        name: 'SessionStart(*)',
        description: 'SessionStart hook (*)',
        sourcePath: join(PROJECT, '.claude', 'settings.local.json'),
        sizeBytes: Buffer.byteLength(
          JSON.stringify({ type: 'command', command: './scripts/load-context.sh' }),
          'utf8',
        ),
        event: 'SessionStart',
        matcher: '*',
        command: './scripts/load-context.sh',
      },
      {
        id: 'mcp:grafana',
        kind: 'mcp',
        name: 'grafana',
        description: null,
        sourcePath: join(PROJECT, '.mcp.json'),
        sizeBytes: mcpEntrySize(join(PROJECT, '.mcp.json'), 'grafana'),
        transport: 'http',
        identity: 'url:grafana.example.com/mcp',
      },
      {
        id: 'mcp:linear',
        kind: 'mcp',
        name: 'linear',
        description: null,
        sourcePath: join(HOME, '.claude.json'),
        sizeBytes: mcpEntrySize(join(HOME, '.claude.json'), 'linear'),
        transport: 'sse',
        identity: 'url:mcp.linear.app/sse',
      },
      {
        id: 'mcp:notion',
        kind: 'mcp',
        name: 'notion',
        description: null,
        sourcePath: join(HOME, '.claude.json'),
        sizeBytes: mcpEntrySize(join(HOME, '.claude.json'), 'notion'),
        transport: 'stdio',
        identity: 'cmd:npx -y @notionhq/notion-mcp-server',
      },
      {
        id: 'mcp:playwright',
        kind: 'mcp',
        name: 'playwright',
        description: null,
        sourcePath: join(HOME, '.claude.json'),
        sizeBytes: nestedMcpEntrySize(join(HOME, '.claude.json'), '/Users/alfred/proj-a', 'playwright'),
        transport: 'stdio',
        identity: 'cmd:npx @playwright/mcp@*',
      },
      {
        id: 'memory:project:CLAUDE.md',
        kind: 'memory',
        name: 'CLAUDE.md (project)',
        description: null,
        sourcePath: join(PROJECT, 'CLAUDE.md'),
        sizeBytes: fileSize(join(PROJECT, 'CLAUDE.md')),
      },
      {
        id: 'memory:user:CLAUDE.md',
        kind: 'memory',
        name: 'CLAUDE.md (user)',
        description: null,
        sourcePath: join(HOME, '.claude', 'CLAUDE.md'),
        sizeBytes: fileSize(join(HOME, '.claude', 'CLAUDE.md')),
      },
      {
        id: 'skill:broken-skill',
        kind: 'skill',
        name: 'broken-skill',
        description: null,
        sourcePath: join(HOME, '.claude', 'skills', 'broken-skill', 'SKILL.md'),
        sizeBytes: fileSize(join(HOME, '.claude', 'skills', 'broken-skill', 'SKILL.md')),
        flags: ['invalid-frontmatter'],
      },
      {
        id: 'skill:deep-research',
        kind: 'skill',
        name: 'deep-research',
        description:
          'Deep research harness — fan-out web searches, fetch sources, verify claims, synthesize a cited report.',
        sourcePath: join(HOME, '.claude', 'skills', 'deep-research', 'SKILL.md'),
        sizeBytes: fileSize(join(HOME, '.claude', 'skills', 'deep-research', 'SKILL.md')),
      },
      {
        id: 'skill:deploy-checklist',
        kind: 'skill',
        name: 'deploy-checklist',
        description: 'Pre-deploy checklist for this project.',
        sourcePath: join(PROJECT, '.claude', 'skills', 'deploy-checklist', 'SKILL.md'),
        sizeBytes: fileSize(join(PROJECT, '.claude', 'skills', 'deploy-checklist', 'SKILL.md')),
      },
      {
        id: 'skill:frontend-design:frontend-design',
        kind: 'skill',
        name: 'frontend-design:frontend-design',
        description: 'Distinctive visual design and typography guidance.',
        sourcePath: join(
          HOME, '.claude', 'plugins', 'cache', 'acme', 'frontend-design', 'unknown',
          'skills', 'frontend-design', 'SKILL.md',
        ),
        sizeBytes: fileSize(
          join(
            HOME, '.claude', 'plugins', 'cache', 'acme', 'frontend-design', 'unknown',
            'skills', 'frontend-design', 'SKILL.md',
          ),
        ),
      },
      {
        id: 'skill:git-workflow',
        kind: 'skill',
        name: 'git-workflow',
        description: 'Git conventions for commits, branches, and pull requests.',
        sourcePath: join(HOME, '.claude', 'skills', 'git-workflow', 'SKILL.md'),
        sizeBytes: fileSize(join(HOME, '.claude', 'skills', 'git-workflow', 'SKILL.md')),
      },
      {
        id: 'skill:superpowers:brainstorming',
        kind: 'skill',
        name: 'superpowers:brainstorming',
        description: 'Explore user intent, requirements and design before implementation.',
        sourcePath: join(
          HOME,
          '.claude',
          'plugins',
          'cache',
          'acme',
          'superpowers',
          '1.0.0',
          'skills',
          'brainstorming',
          'SKILL.md',
        ),
        sizeBytes: fileSize(
          join(
            HOME,
            '.claude',
            'plugins',
            'cache',
            'acme',
            'superpowers',
            '1.0.0',
            'skills',
            'brainstorming',
            'SKILL.md',
          ),
        ),
      },
    ];

    expect(inventory.items).toEqual(expected);
  });

  it('returns an empty inventory for missing directories, never crashing', async () => {
    const inventory = await scan({
      homeDir: join(ROOT, 'fixtures', 'does-not-exist'),
      projectDir: join(ROOT, 'fixtures', 'also-missing'),
    });
    expect(inventory.items).toEqual([]);
  });

  it('works without a projectDir', async () => {
    const inventory = await scan({ homeDir: HOME });
    const ids = inventory.items.map((i) => i.id);
    expect(ids).toContain('skill:git-workflow');
    expect(ids).not.toContain('agent:proposal-agent');
    // grafana exists at user level too — without a project it comes from ~/.claude.json
    const grafana = inventory.items.find((i) => i.id === 'mcp:grafana');
    expect(grafana?.sourcePath).toBe(join(HOME, '.claude.json'));
  });

  it('project config wins the MCP name collision (grafana defined at both levels)', async () => {
    const inventory = await scan({ homeDir: HOME, projectDir: PROJECT });
    const grafana = inventory.items.filter((i) => i.name === 'grafana');
    expect(grafana).toHaveLength(1);
    expect(grafana[0]!.sourcePath).toBe(join(PROJECT, '.mcp.json'));
  });

  it('never inventories plugin-internal dot-directory skills', async () => {
    const inventory = await scan({ homeDir: HOME, projectDir: PROJECT });
    const junk = inventory.items.filter((i) => i.name.includes('junk-dev-skill'));
    expect(junk).toEqual([]);
  });
});
