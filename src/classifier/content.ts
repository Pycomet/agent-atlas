import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

/** Bump to invalidate every cached classification when the rubric changes. */
export const RUBRIC_VERSION = 1;

export function contentHash(name: string, description: string | null, body: string): string {
  return createHash('sha256')
    .update(`${name}\0${description ?? ''}\0${body}\0rubric-v${RUBRIC_VERSION}`)
    .digest('hex');
}

/** First ~500 chars of a skill body (frontmatter stripped). Missing file → "". */
export async function readSkillBody(sourcePath: string): Promise<string> {
  let text: string;
  try {
    text = await fs.readFile(sourcePath, 'utf8');
  } catch {
    return '';
  }
  let body = text;
  if (text.startsWith('---')) {
    const closing = text.indexOf('\n---', 3);
    if (closing !== -1) {
      const lineEnd = text.indexOf('\n', closing + 1);
      body = lineEnd === -1 ? '' : text.slice(lineEnd + 1);
    }
  }
  return body.trim().slice(0, 500);
}
