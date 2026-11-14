import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { findDuplicates, proposalsCsv, applyMerge } from './dedupe.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const common = { path: { ...str, description: 'Vendor or item master export (CSV/JSON)' }, kind: { type: 'string', enum: ['vendor', 'item'] }, id_column: str, name_column: str, threshold: { type: 'number', description: 'Name similarity 0..1 (default 0.88)' } };

export const manifest = defineManifest({
  name: 'augeas-of-masters',
  version: pkg.version,
  description: 'Finds likely duplicate vendors or items in a master-data export (CSV/JSON), explains why, proposes a survivor, and applies one approved merge at a time to a copy of the file. Never edits your ERP.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'augeas_find_duplicates', kind: 'read',
      description: 'Cluster likely duplicates using normalized names (Inc/LLC/punctuation removed), name similarity, tax id or UPC, email domain, phone and address. Flags different tax ids as possibly separate entities.',
      inputSchema: { type: 'object', required: ['path'], properties: common },
      handler: async (a, ctx) => { const r = findDuplicates(ctx.records(a.path), a); return { summary: `${r.clusters} duplicate cluster(s) covering ${r.records_in_clusters} of ${r.records} ${r.kind} record(s). Proposals only.`, ...r }; },
    },
    {
      name: 'augeas_propose_merges', kind: 'report',
      description: 'Write merge-proposals.csv (with blank reviewer columns) and merge-proposals.json into out_dir (default mythos-out/augeas).',
      inputSchema: { type: 'object', required: ['path'], properties: { ...common, out_dir: str } },
      handler: async (a, ctx) => {
        const r = findDuplicates(ctx.records(a.path), a); const out = ctx.outDir(a.out_dir || 'mythos-out/augeas');
        const files = [ctx.writeFile(out, 'merge-proposals.csv', proposalsCsv(r)), ctx.writeFile(out, 'merge-proposals.json', JSON.stringify(r, null, 2))];
        return { summary: `${r.clusters} merge proposal(s) written for review.`, files, clusters: r.clusters };
      },
    },
    {
      name: 'augeas_apply_merge', kind: 'write',
      description: 'Apply ONE merge to a copy of the export: rows in "merge" get merged_into=<survivor>. Writes <name>.merged.csv in out_dir; the input file is never modified. Needs a human yes (or an Auto opt-in).',
      inputSchema: { type: 'object', required: ['path', 'survivor', 'merge'], properties: { path: str, survivor: str, merge: { type: 'array', items: str }, kind: common.kind, id_column: str, out_dir: str, output: { ...str, description: 'Output file name (default <input>.merged.csv). Re-use it to chain merges.' } } },
      handler: async (a, ctx) => {
        const out = ctx.outDir(a.out_dir || 'mythos-out/augeas');
        const name = a.output || basename(a.path, extname(a.path)) + '.merged.csv';
        const outFile = ctx.path(`${(a.out_dir || 'mythos-out/augeas')}/${basename(name)}`);
        let src = a.path;
        try { ctx.records(`${(a.out_dir || 'mythos-out/augeas')}/${basename(name)}`); src = `${(a.out_dir || 'mythos-out/augeas')}/${basename(name)}`; } catch { /* first merge starts from the input */ }
        const r = applyMerge(ctx.records(src), a);
        ctx.writeFile(out, basename(name), toCsv(r.rows));
        return { summary: `Merged ${r.changed} record(s) into ${a.survivor} in a copy (${basename(name)}). The input file and your ERP were not changed.`, file: outFile, changed: r.changed };
      },
    },
    {
      name: 'augeas_pay_vendor', kind: 'action', category: 'move_money',
      description: 'Listed so agents can see it is refused. Augeas never moves money or edits bank details.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  policy: { rules: [
    { tool: 'augeas_find_duplicates', decision: 'allow' },
    { tool: 'augeas_propose_merges', decision: 'allow' },
    { tool: 'augeas_apply_merge', decision: 'ask', reason: 'Each merge needs a human yes, unless the buyer opted this action in to Auto.' },
    { tool: 'augeas_pay_vendor', decision: 'block', reason: 'Augeas never moves money.' },
    { tool: '*', decision: 'block', reason: 'Not on the Augeas allowlist.' },
  ] },
});
