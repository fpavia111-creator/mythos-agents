import { defineManifest, toCsv, sha256, parseCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compare, varianceCsv, reportMarkdown, adjustmentRows, ADJ_COLUMNS } from './inventory.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  counts: { ...str, description: 'Cycle count CSV/JSON: sku, location, counted_qty, recount_qty, uom, counter, counted_at' },
  on_hand: { ...str, description: 'On-hand snapshot CSV/JSON from the system of record: sku, location, description, system_qty, unit_cost, uom' },
  transactions: { ...str, description: 'Optional movements CSV/JSON: sku, location, posted_at, qty (signed), type, ref. Movements after a count explain timing differences.' },
  snapshot_at: { ...str, description: 'When the on-hand snapshot was taken (YYYY-MM-DD or YYYY-MM-DDTHH:MM); movements after it are ignored' },
  tolerance_pct: { ...num, description: 'Variance share treated as within tolerance (default 0.02)' },
  tolerance_units: { ...num, description: 'Units treated as within tolerance (default 0)' },
  value_threshold: { ...num, description: 'Absolute variance value that always needs a recount (default 250)' },
  locations: { type: 'array', items: str, description: 'Locations in this count; only these are checked for not_counted' },
};
const run = (a, ctx) => {
  for (const k of ['counts', 'on_hand']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`);
  return compare(ctx.records(a.counts), ctx.records(a.on_hand), a.transactions ? ctx.records(a.transactions) : [], a);
};
function appendRows(dir, file, rows, cols) {
  const f = join(dir, file); const csv = toCsv(rows, cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  name: 'hesperides-of-inventory',
  version: pkg.version,
  description: 'Compares cycle counts with an on-hand export: ranks variances by value, separates timing differences (movements after the count), flags likely unit-of-measure errors, negative stock, items not in the system and items not counted, and says which lines need a recount. Drafts adjustment entries only for lines within tolerance or confirmed by a recount. Posting is one human click; it never writes to your ERP.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'hesperides_compare', kind: 'read',
      description: 'Status per sku and location (match, within_tolerance, explained_by_timing, recount_needed, confirmed_by_recount, investigate, not_counted), ranked by absolute variance value, with flags and investigation notes.',
      inputSchema: { type: 'object', required: ['counts', 'on_hand'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.lines} line(s): ${r.match} match, ${r.within_tolerance} within tolerance, ${r.explained_by_timing} timing, ${r.recount_needed} recount needed, ${r.confirmed_by_recount} confirmed by recount, ${r.investigate} investigate, ${r.not_counted} not counted. Net ${r.net_variance_value.toFixed(2)}, absolute ${r.abs_variance_value.toFixed(2)}.`, ...r }; },
    },
    {
      name: 'hesperides_write_report', kind: 'report',
      description: 'Write variance-review.md and variances.csv (blank reviewer and decision columns) into out_dir (default mythos-out/hesperides).',
      inputSchema: { type: 'object', required: ['counts', 'on_hand'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => { const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/hesperides'); return { summary: `Variance review written for ${r.lines} line(s).`, files: [ctx.writeFile(out, 'variance-review.md', reportMarkdown(r)), ctx.writeFile(out, 'variances.csv', varianceCsv(r))] }; },
    },
    {
      name: 'hesperides_draft_adjustments', kind: 'write',
      description: 'Write adjustments-draft.csv (marked draft, not posted) for lines within tolerance or confirmed by recount, plus adjustment.json with its hash. Lines that need a recount or investigation are left out. Pass reasons ({"SKU@LOCATION": "code"}) from the person who reviewed them; Hesperides does not choose reason codes. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['counts', 'on_hand'], properties: { ...props, reasons: { type: 'object', description: 'Reason codes by "SKU@LOCATION", supplied by a person' }, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/hesperides'); const reasons = a.reasons || {};
        const rows = adjustmentRows(r).map((x) => ({ ...x, reason_code: String(reasons[`${x.sku}@${x.location}`] || '').trim() }));
        const csv = toCsv(rows, ADJ_COLUMNS); const cf = ctx.writeFile(out, 'adjustments-draft.csv', csv);
        const value = Math.round(rows.reduce((t, x) => t + (Number(x.value) || 0), 0) * 100) / 100;
        const batch = { created_at: new Date().toISOString(), lines: rows.length, net_value: value, csv: 'adjustments-draft.csv', csv_sha256: sha256(csv), missing_reason: rows.filter((x) => !x.reason_code).map((x) => `${x.sku}@${x.location}`), held: r.items.filter((i) => !['match', 'explained_by_timing', 'within_tolerance', 'confirmed_by_recount'].includes(i.status)).map((i) => `${i.sku}@${i.location} (${i.status})`), status: 'draft - not posted' };
        const bText = JSON.stringify(batch, null, 2) + '\n'; const bf = ctx.writeFile(out, 'adjustment.json', bText);
        return { summary: `${rows.length} adjustment line(s) drafted (net ${value.toFixed(2)}); ${batch.held.length} held for recount or investigation; ${batch.missing_reason.length} without a reason code. Nothing was posted.`, batch: relative(ctx.root, bf).split('\\').join('/'), batch_sha256: sha256(bText), files: [cf, bf] };
      },
    },
    {
      name: 'hesperides_request_post', kind: 'action', category: 'move_money',
      description: 'After one named human click (even in Auto), record that the drafted adjustment is approved to post in post-requests.csv. Tied to batch_sha256; the draft CSV is re-hashed and every line needs a reason code. A person posts it in your ERP; Hesperides never posts.',
      inputSchema: { type: 'object', required: ['batch', 'batch_sha256'], properties: { batch: str, batch_sha256: str, out_dir: str } },
      handler: async (a, ctx) => {
        const bf = ctx.path(a.batch); if (!existsSync(bf)) throw new Error(`batch not found: ${a.batch}`);
        const text = readFileSync(bf, 'utf8'); if (sha256(text) !== a.batch_sha256) throw new Error('batch_sha256 does not match the batch file; review the current draft and ask again');
        const b = JSON.parse(text); const cf = join(bf, '..', b.csv);
        if (!existsSync(cf) || sha256(readFileSync(cf, 'utf8')) !== b.csv_sha256) throw new Error('adjustments-draft.csv changed after it was drafted');
        if (!b.lines) throw new Error('the draft has no adjustment lines');
        if (b.missing_reason.length) throw new Error(`reason code missing for ${b.missing_reason.join(', ')}; redraft with reasons from the reviewer`);
        const at = new Date().toISOString(); const rows = parseCsv(readFileSync(cf, 'utf8'));
        const file = appendRows(ctx.outDir(a.out_dir || 'mythos-out/hesperides'), 'post-requests.csv', rows.map((x) => ({ approved_at: at, batch_sha256: a.batch_sha256, sku: x.sku, location: x.location, adjust_qty: x.adjust_qty, value: x.value, reason_code: x.reason_code, status: 'approved - a person posts it' })), ['approved_at', 'batch_sha256', 'sku', 'location', 'adjust_qty', 'value', 'reason_code', 'status']);
        return { summary: `Adjustment of ${b.lines} line(s) (net ${Number(b.net_value).toFixed(2)}) approved and recorded. Nothing was posted.`, file };
      },
    },
    { name: 'erp_post_adjustment', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Hesperides never writes to an ERP, WMS or ledger.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'hesperides_compare', decision: 'allow' },
    { tool: 'hesperides_write_report', decision: 'allow' },
    { tool: 'hesperides_draft_adjustments', decision: 'ask', reason: 'Drafting adjustment entries needs a human yes (or an Auto opt-in).' },
    { tool: 'erp_post_adjustment', decision: 'block', reason: 'Hesperides never posts to an ERP. A person posts.' },
    { tool: 'hesperides_request_post', decision: 'ask', reason: 'Posting an inventory adjustment changes the books: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Hesperides allowlist.' },
  ] },
});
