import { defineManifest, toCsv, sha256, htmlPage, escapeHtml } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { findDuplicates, proposalsCsv, proposalsHtml, applyMerge, DEFAULT_THRESHOLD } from './dedupe.js';
import { mergePreview, RULES_SCHEMA, undoEntry, applyUndo } from './merge.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const ids = { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 };
const common = {
  path: { ...str, description: 'Vendor or item master export (CSV/JSON)' }, kind: { type: 'string', enum: ['vendor', 'item'] }, id_column: str, name_column: str,
  threshold: { type: 'number', minimum: 0.5, maximum: 1, description: `Name similarity 0..1 for a name-only link (default ${DEFAULT_THRESHOLD})` },
  rules: { ...str, description: 'Optional augeas-rules JSON (survivor order, per-field survivorship, protected fields)' },
};
const OUT = 'mythos-out/augeas';
const loadRules = (a, ctx) => (a.rules ? ctx.readJson(a.rules, 'augeas-rules') : {});
const find = (a, ctx) => { const rules = loadRules(a, ctx); return findDuplicates(ctx.records(a.path), { ...a, survivor_rules: { ...(rules.survivor || {}), date_column: rules.date_column } }); };
const copyPaths = (a) => { const dir = a.out_dir || OUT; const name = basename(a.output || basename(a.path, extname(a.path)) + '.merged.csv'); return { dir, name, rel: `${dir}/${name}`, undoName: `${name}.undo.jsonl` }; };

const PROMPT = `You are cleaning a {{kind}} master export with the augeas-of-masters tools. Work only on files under --root. Augeas never edits the ERP and never touches bank details or payments.

1. Call augeas_find_duplicates with path="{{path}}", kind="{{kind}}" (add rules="{{rules}}" if a rules file was given). For each proposal, read the reasons and the per-pair signals (name score, tax id, address, phone, email domain). Point out any "kept_apart" pairs and "weak_pairs": those need a person's judgement.
2. Call augeas_propose_merges with the same arguments. It writes merge-proposals.csv (blank reviewer columns), .json and .html. Ask the user to review the HTML page and mark reviewer_decision.
3. For each cluster the user approves, call augeas_merge_preview with survivor and merge. Show the field-level changes and every conflict (different non-blank values), and say which record each winning value came from. Bank and payment columns never change.
4. Call augeas_apply_merge with the same survivor and merge (fill_survivor=true only if the user accepted the preview). It needs a human yes unless the buyer opted it in to Auto. It writes to a copy (<name>.merged.csv) plus an undo log; the input file is never modified.
5. If a merge was wrong, call augeas_undo_merge with copy=<the merged copy path>. It restores the copy byte-for-byte to its state before the last merge, and refuses if the copy was edited since.
6. Tell the user to check open transactions, balances, bank details and 1099/tax status before loading the reviewed copy into the ERP themselves.`;

export const manifest = defineManifest({
  name: 'augeas-of-masters',
  version: pkg.version,
  description: 'Finds likely duplicate vendors or items in a master-data export (CSV/JSON) with explainable match signals, proposes a survivor, previews field-level winners, and applies one approved merge at a time to a copy of the file with an undo log. Never edits your ERP.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { 'augeas-rules': RULES_SCHEMA },
  prompts: [{
    name: 'augeas_dedupe_master', title: 'Deduplicate a vendor or item master',
    description: 'Find duplicates, write proposals, preview each merge field by field, apply approved merges to a copy and undo if needed.',
    arguments: [
      { name: 'path', description: 'Master export under --root (CSV/JSON)', required: true },
      { name: 'kind', description: 'vendor or item', required: true },
      { name: 'rules', description: 'augeas-rules JSON (optional)', required: false },
    ],
    text: PROMPT,
  }],
  tools: [
    {
      name: 'augeas_find_duplicates', kind: 'read', title: 'Find duplicates',
      description: 'Cluster likely duplicates: Jaro-Winkler soft-token name similarity weighted by word rarity (Inc/LLC/punctuation removed), normalized tax id or UPC, normalized address, phone and email domain. Never puts two different tax ids in one cluster. Each pair carries its signals.',
      inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: common },
      handler: async (a, ctx) => { const r = find(a, ctx); return { summary: `${r.clusters} duplicate cluster(s) covering ${r.records_in_clusters} of ${r.records} ${r.kind} record(s). Proposals only.`, ...r }; },
    },
    {
      name: 'augeas_propose_merges', kind: 'report', title: 'Write merge proposals',
      description: 'Write merge-proposals.csv (with blank reviewer columns), merge-proposals.json and a self-contained merge-proposals.html review page into out_dir (default mythos-out/augeas).',
      inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { ...common, out_dir: str } },
      handler: async (a, ctx) => {
        const r = find(a, ctx); const out = ctx.outDir(a.out_dir || OUT);
        const csv = proposalsCsv(r);
        const files = [ctx.writeFile(out, 'merge-proposals.csv', csv), ctx.writeFile(out, 'merge-proposals.json', JSON.stringify(r, null, 2)), ctx.writeFile(out, 'merge-proposals.html', proposalsHtml(r, { htmlPage, escapeHtml }))];
        return { summary: `${r.clusters} merge proposal(s) written for review.`, files, clusters: r.clusters, output_sha256: sha256(csv) };
      },
    },
    {
      name: 'augeas_merge_preview', kind: 'read', title: 'Preview a merge field by field',
      description: 'For one survivor and the ids to merge, show every column: each record\'s value, the winning value, which record it came from, the survivorship rule used, and conflicts. Bank and payment columns are never changed. Reads the current merged copy if one exists. Writes nothing.',
      inputSchema: { type: 'object', required: ['path', 'survivor', 'merge'], additionalProperties: false, properties: { path: common.path, survivor: str, merge: ids, kind: common.kind, id_column: str, rules: common.rules, out_dir: str, output: str } },
      handler: async (a, ctx) => {
        const c = copyPaths(a); const src = ctx.exists(c.rel) ? c.rel : a.path;
        const p = mergePreview(ctx.records(src), { ...a, rules: loadRules(a, ctx) });
        return { summary: `${p.changes.length} field(s) would change on ${a.survivor}; ${p.conflicts.length} conflict(s). Preview only.`, source: src, ...p };
      },
    },
    {
      name: 'augeas_apply_merge', kind: 'write', title: 'Apply one merge to a copy',
      description: 'Apply ONE merge to a copy of the export: rows in "merge" get merged_into=<survivor>; with fill_survivor=true the previewed field winners are written into the survivor row. Writes <name>.merged.csv and appends to <name>.merged.csv.undo.jsonl in out_dir; the input file is never modified. Needs a human yes (or an Auto opt-in).',
      inputSchema: { type: 'object', required: ['path', 'survivor', 'merge'], additionalProperties: false, properties: { path: str, survivor: str, merge: ids, kind: common.kind, id_column: str, out_dir: str, output: { ...str, description: 'Output file name (default <input>.merged.csv). Re-use it to chain merges.' }, fill_survivor: { type: 'boolean', description: 'Write the merge preview winners into the survivor row (default false)' }, rules: common.rules } },
      handler: async (a, ctx) => {
        const c = copyPaths(a); const out = ctx.outDir(c.dir);
        const exists = ctx.exists(c.rel);
        const src = exists ? c.rel : a.path;
        const before = exists ? ctx.readText(c.rel) : null;
        const rows = ctx.records(src);
        const golden = a.fill_survivor ? mergePreview(rows, { ...a, rules: loadRules(a, ctx) }).golden_record : null;
        const r = applyMerge(rows, { ...a, golden });
        const text = toCsv(r.rows);
        const file = ctx.writeFile(out, c.name, text);
        const undoFile = ctx.path(`${c.dir}/${c.undoName}`);
        appendFileSync(undoFile, JSON.stringify(undoEntry(before, text, { survivor: a.survivor, merge: a.merge, fill_survivor: !!a.fill_survivor })) + '\n');
        return { summary: `Merged ${r.changed} record(s) into ${a.survivor} in a copy (${c.name})${golden ? `, ${r.filled} survivor field(s) filled` : ''}. The input file and your ERP were not changed. Undo log: ${c.undoName}.`, file, undo_file: undoFile, changed: r.changed, filled: r.filled, output_sha256: sha256(text) };
      },
    },
    {
      name: 'augeas_undo_merge', kind: 'write', title: 'Undo the last merge on a copy',
      description: 'Reverse the last merge recorded in <copy>.undo.jsonl: restores the merged copy byte-for-byte to its state before that merge (removes the copy if that merge created it). Refuses if the copy was edited since. Needs a human yes (or an Auto opt-in).',
      inputSchema: { type: 'object', required: ['copy'], additionalProperties: false, properties: { copy: { ...str, description: 'The merged copy, e.g. mythos-out/augeas/vendors.merged.csv' } } },
      handler: async (a, ctx) => {
        const undoRel = `${a.copy}.undo.jsonl`;
        if (!ctx.exists(undoRel)) throw new Error(`no undo log at ${undoRel}`);
        const lines = ctx.readText(undoRel).split('\n').filter((l) => l.trim());
        if (!lines.length) throw new Error('undo log is empty; nothing to undo');
        const entry = JSON.parse(lines[lines.length - 1]);
        const copyFile = ctx.path(a.copy);
        const restored = applyUndo(ctx.exists(a.copy) ? ctx.readText(a.copy) : '', entry);
        if (restored === null) unlinkSync(copyFile); else writeFileSync(copyFile, restored);
        writeFileSync(ctx.path(undoRel), lines.slice(0, -1).map((l) => l + '\n').join(''));
        return { summary: `Undid the merge into ${entry.survivor} (${entry.merge.join(', ')}). ${restored === null ? 'That merge created the copy, so the copy was removed.' : 'The copy is back to its earlier state (hash checked).'} ${lines.length - 1} merge(s) left in the log.`, restored_sha256: entry.before_sha256, removed_copy: restored === null, remaining: lines.length - 1 };
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
    { tool: 'augeas_merge_preview', decision: 'allow' },
    { tool: 'augeas_apply_merge', decision: 'ask', reason: 'Each merge needs a human yes, unless the buyer opted this action in to Auto.' },
    { tool: 'augeas_undo_merge', decision: 'ask', reason: 'Undoing a merge rewrites the copy: a human yes, unless the buyer opted it in to Auto.' },
    { tool: 'augeas_pay_vendor', decision: 'block', reason: 'Augeas never moves money.' },
    { tool: '*', decision: 'block', reason: 'Not on the Augeas allowlist.' },
  ] },
});
