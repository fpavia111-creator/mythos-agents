#!/usr/bin/env node
// Writes the "Exports it reads" section of each agent README from its manifest,
// between <!-- sources:start --> and <!-- sources:end --> (inserted before
// "## Install" the first time). --check exits 1 when a README is out of date.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeSources, EXPORTS_BASIS_NOTE } from '../packages/mythos-agent-core/src/index.js';

const PK = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');
const check = process.argv.includes('--check');
const START = '<!-- sources:start -->', END = '<!-- sources:end -->';
let stale = 0;
for (const n of readdirSync(PK).filter((x) => /-of-/.test(x)).sort()) {
  const { manifest } = await import(pathToFileURL(join(PK, n, 'src', 'index.js')).href);
  const list = describeSources(manifest); const f = join(PK, n, 'README.md');
  if (!list.length || !existsSync(f)) continue;
  const bin = n;
  const L = [START, '## Exports it reads', '', 'Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent\'s own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.', ''];
  for (const k of list) {
    L.push(`**${k.label}** (argument${k.args.length > 1 ? 's' : ''} ${k.args.map((a) => `\`${a}\``).join(', ')})`, '');
    if (k.exports.length) { L.push('| System | Export | Layout checked against vendor docs |', '|---|---|---|'); for (const e of k.exports) L.push(`| ${e.system} | ${e.label || e.id} | ${e.layout_checked === 'no' ? 'no' : e.layout_checked.replace(/^against /, '')} |`); L.push(''); }
    else L.push('No named exports: other column names are matched by a list of common alternatives.', '');
  }
  L.push(`Columns named differently? Run \`npx ${bin} inspect <file>\` to see how a file is read (column names and shapes only, never values), then name your columns in \`mythos-sources.json\` in the root:`, '', '```json', '{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }', '```', '', `${EXPORTS_BASIS_NOTE} If a real export does not match, the result says which columns were missing; please report it.`, END);
  const block = L.join('\n');
  const txt = readFileSync(f, 'utf8');
  const next = txt.includes(START) ? txt.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block) : txt.replace(/\n## Install\b/, `\n${block}\n\n## Install`);
  if (next === txt) continue;
  if (!txt.includes(START) && next === txt) { console.error(`${n}: no "## Install" heading to insert before`); stale++; continue; }
  stale++;
  if (!check) { writeFileSync(f, next); console.log(`${n}: README updated`); }
  else console.log(`${n}: README "Exports it reads" is out of date`);
}
process.exit(check && stale ? 1 : 0);
