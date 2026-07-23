import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergeUsage, mineUsage } from '../src/miner.js';
import type { Inventory } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const NOW = new Date('2026-07-21T00:00:00.000Z');

describe('mineUsage', () => {
  it('counts skill, agent, and MCP invocations inside the window', async () => {
    const usage = await mineUsage({ homeDir: HOME, days: 30, now: NOW });

    expect(usage.totalSessions).toBe(2);
    expect(usage.items).toEqual({
      'skill:git-workflow': {
        count: 2,
        lastUsed: '2026-07-15T09:00:00.000Z',
        sessionsSeen: 2,
      },
      'skill:superpowers:brainstorming': {
        count: 1,
        lastUsed: '2026-07-15T09:05:00.000Z',
        sessionsSeen: 1,
      },
      'mcp:notion': {
        count: 2,
        lastUsed: '2026-07-15T09:10:00.000Z',
        sessionsSeen: 2,
      },
      'agent:code-reviewer': {
        count: 1,
        lastUsed: '2026-07-10T10:10:00.000Z',
        sessionsSeen: 1,
      },
    });
  });

  it('includes older sessions when the window is widened', async () => {
    const usage = await mineUsage({ homeDir: HOME, days: 365, now: NOW });

    expect(usage.totalSessions).toBe(3);
    expect(usage.items['skill:git-workflow']).toEqual({
      count: 3,
      lastUsed: '2026-07-15T09:00:00.000Z',
      sessionsSeen: 3,
    });
    expect(usage.items['mcp:linear']).toEqual({
      count: 1,
      lastUsed: '2026-01-05T12:05:00.000Z',
      sessionsSeen: 1,
    });
  });

  it('returns empty usage when the projects directory is missing', async () => {
    const usage = await mineUsage({
      homeDir: join(ROOT, 'fixtures', 'does-not-exist'),
      days: 30,
      now: NOW,
    });
    expect(usage).toEqual({ totalSessions: 0, items: {} });
  });
});

describe('mergeUsage', () => {
  it('zero-fills inventory items never seen in transcripts', () => {
    const inventory: Inventory = {
      items: [
        {
          id: 'skill:git-workflow',
          kind: 'skill',
          name: 'git-workflow',
          description: null,
          sourcePath: '/x',
          sizeBytes: 1,
        },
        {
          id: 'mcp:grafana',
          kind: 'mcp',
          name: 'grafana',
          description: null,
          sourcePath: '/y',
          sizeBytes: 1,
        },
      ],
    };
    const usage = {
      totalSessions: 2,
      items: {
        'skill:git-workflow': { count: 2, lastUsed: '2026-07-15T09:00:00.000Z', sessionsSeen: 2 },
        'agent:uninstalled-but-used': { count: 1, lastUsed: '2026-07-15T09:00:00.000Z', sessionsSeen: 1 },
      },
    };

    const merged = mergeUsage(inventory, usage);

    expect(merged.totalSessions).toBe(2);
    expect(merged.items['skill:git-workflow']).toEqual({
      count: 2,
      lastUsed: '2026-07-15T09:00:00.000Z',
      sessionsSeen: 2,
    });
    expect(merged.items['mcp:grafana']).toEqual({ count: 0, lastUsed: null, sessionsSeen: 0 });
    expect(merged.items['agent:uninstalled-but-used']).toEqual({
      count: 1,
      lastUsed: '2026-07-15T09:00:00.000Z',
      sessionsSeen: 1,
    });
  });

  it('credits prefixed plugin skills when transcripts use a different prefix', () => {
    const inventory: Inventory = {
      items: [
        {
          id: 'skill:vercel-plugin:deploy',
          kind: 'skill',
          name: 'vercel-plugin:deploy',
          description: null,
          sourcePath: '/x',
          sizeBytes: 1,
        },
      ],
    };
    const usage = {
      totalSessions: 2,
      items: {
        'skill:vercel:deploy': { count: 3, lastUsed: '2026-07-01T00:00:00.000Z', sessionsSeen: 2 },
      },
    };

    const merged = mergeUsage(inventory, usage);

    expect(merged.items['skill:vercel-plugin:deploy']).toEqual({
      count: 3,
      lastUsed: '2026-07-01T00:00:00.000Z',
      sessionsSeen: 2,
    });
    expect(merged.items['skill:vercel:deploy']).toBeUndefined();
  });

  it('never guesses when two inventory items share a bare skill name', () => {
    const inventory: Inventory = {
      items: [
        {
          id: 'skill:plugin-a:deploy',
          kind: 'skill',
          name: 'plugin-a:deploy',
          description: null,
          sourcePath: '/a',
          sizeBytes: 1,
        },
        {
          id: 'skill:plugin-b:deploy',
          kind: 'skill',
          name: 'plugin-b:deploy',
          description: null,
          sourcePath: '/b',
          sizeBytes: 1,
        },
      ],
    };
    const usage = {
      totalSessions: 1,
      items: {
        'skill:other:deploy': { count: 5, lastUsed: '2026-07-01T00:00:00.000Z', sessionsSeen: 1 },
      },
    };

    const merged = mergeUsage(inventory, usage);

    expect(merged.items['skill:plugin-a:deploy'].count).toBe(0);
    expect(merged.items['skill:plugin-b:deploy'].count).toBe(0);
    expect(merged.items['skill:other:deploy'].count).toBe(5);
  });
});
