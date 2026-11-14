// Sample read-only MCP tool with a root check. Used by nemesis-of-servers tests.
import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');

function inside(p) {
  const abs = resolve(ROOT, String(p));
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('outside root');
  return abs;
}

export const tools = {
  read_note: ({ name }) => readFileSync(inside(name), 'utf8').slice(0, 10000),
};
