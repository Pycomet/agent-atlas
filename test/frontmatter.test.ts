import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses simple key: value pairs', () => {
    const fm = parseFrontmatter('---\nname: git-workflow\ndescription: Git conventions.\n---\n\nbody');
    expect(fm.malformed).toBe(false);
    expect(fm.fields).toEqual({ name: 'git-workflow', description: 'Git conventions.' });
  });

  it('strips surrounding quotes from values', () => {
    const fm = parseFrontmatter('---\nname: "quoted"\ndescription: \'also quoted\'\n---\n');
    expect(fm.fields).toEqual({ name: 'quoted', description: 'also quoted' });
  });

  it('joins folded block scalars (>-) with spaces', () => {
    const fm = parseFrontmatter('---\ndescription: >-\n  line one,\n  line two.\n---\n');
    expect(fm.malformed).toBe(false);
    expect(fm.fields['description']).toBe('line one, line two.');
  });

  it('joins literal block scalars (|) with newlines', () => {
    const fm = parseFrontmatter('---\nnotes: |\n  first\n  second\n---\n');
    expect(fm.fields['notes']).toBe('first\nsecond');
  });

  it('skips nested structures without failing', () => {
    const fm = parseFrontmatter('---\nname: x\nmetadata:\n  type: user\n---\n');
    expect(fm.malformed).toBe(false);
    expect(fm.fields['name']).toBe('x');
    expect(fm.fields['type']).toBeUndefined();
  });

  it('flags a missing closing delimiter as malformed', () => {
    const fm = parseFrontmatter('---\nname: broken\n\nbody with no closing fence');
    expect(fm.malformed).toBe(true);
  });

  it('flags content without frontmatter as malformed', () => {
    const fm = parseFrontmatter('# Just a markdown file\n');
    expect(fm.malformed).toBe(true);
    expect(fm.fields).toEqual({});
  });
});
