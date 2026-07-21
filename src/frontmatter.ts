export interface Frontmatter {
  fields: Record<string, string>;
  malformed: boolean;
}

const KEY_LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const BLOCK_MARKERS = new Set(['|', '|-', '|+', '>', '>-', '>+']);

/**
 * Minimal YAML frontmatter parser: top-level `key: value` pairs, quoted
 * values, and `|`/`>` block scalars. Nested structures and unknown syntax
 * are skipped; only missing delimiters mark the result malformed.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const lines = source.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return { fields: {}, malformed: true };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { fields: {}, malformed: true };

  const fields: Record<string, string> = {};
  let i = 1;
  while (i < end) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s/.test(line)) {
      i++; // blank, or an indented (nested) line we don't model
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (match === null) {
      i++; // tolerate syntax we don't understand
      continue;
    }
    const key = match[1] as string;
    let value = (match[2] ?? '').trim();

    if (BLOCK_MARKERS.has(value)) {
      const fold = value.startsWith('>');
      const parts: string[] = [];
      i++;
      while (i < end) {
        const next = lines[i] ?? '';
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        if (next.trim() !== '') parts.push(next.trim());
        i++;
      }
      fields[key] = parts.join(fold ? ' ' : '\n');
      continue;
    }

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
    i++;
  }
  return { fields, malformed: false };
}
