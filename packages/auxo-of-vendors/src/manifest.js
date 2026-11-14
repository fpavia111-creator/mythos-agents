import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { check, trackerCsv, readinessMarkdown, requestDraft, slug } from './vendors.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  vendors: { ...str, description: 'Vendor export CSV/JSON: vendor_id, name, legal_name, entity_type, country, tin, w9_received, w9_signed, address, email, requested_date' },
  payments: { ...str, description: 'Optional payments CSV/JSON: vendor_id, date, amount, method (ach, check, wire, card, paypal…)' },
  year: { ...num, description: 'Payment year (default: the as_of year)' },
  threshold: { ...num, description: 'Payment total to flag. Default 600 before 2026, 2000 for 2026; later years must be confirmed with your preparer.' },
  as_of: str, refresh_years: num, remind_days: num,
};
const run = (a, ctx) => check(ctx.records(a.vendors), a.payments ? ctx.records(a.payments) : [], a);
function appendRow(dir, file, row, cols) {
  const f = join(dir, file); const csv = toCsv([row], cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  name: 'auxo-of-vendors',
  version: pkg.version,
  description: 'Vendor W-9 readiness from CSV exports: missing or unsigned forms, TIN format (always masked), missing name, address or LLC classification, old forms, non-US vendors, and payment totals against a threshold you set. Writes a tracker and drafts request and reminder emails. Sending is one human click. It never files with the IRS and gives no tax advice.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'auxo_check', kind: 'read',
      description: 'Give each vendor a readiness status (ready, request_w9, fix_details, review, ask_preparer), flags, masked TIN, payment totals and a priority. Not tax advice.',
      inputSchema: { type: 'object', required: ['vendors'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.vendors} vendor(s) for ${r.year}: ready ${r.ready}, request W-9 ${r.request_w9}, fix details ${r.fix_details}, review ${r.review}, ask preparer ${r.ask_preparer}; ${r.over_threshold_not_ready} over ${r.threshold} and not ready.`, ...r }; },
    },
    {
      name: 'auxo_write_tracker', kind: 'report',
      description: 'Write w9-tracker.csv (blank owner and follow-up columns) and readiness.md into out_dir (default mythos-out/auxo). TINs stay masked.',
      inputSchema: { type: 'object', required: ['vendors'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => { const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/auxo'); return { summary: `Tracker written for ${r.vendors} vendor(s).`, files: [ctx.writeFile(out, 'w9-tracker.csv', trackerCsv(r)), ctx.writeFile(out, 'readiness.md', readinessMarkdown(r))] }; },
    },
    {
      name: 'auxo_draft_requests', kind: 'write',
      description: 'Write a request or reminder email draft (marked DRAFT, not sent) for each vendor that needs one into out_dir/requests. Vendors asked within remind_days are skipped. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['vendors'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const dir = join(ctx.outDir(a.out_dir || 'mythos-out/auxo'), 'requests'); mkdirSync(dir, { recursive: true });
        const todo = r.items.filter((i) => ['first_request', 'reminder'].includes(i.request));
        const files = todo.map((i) => ctx.writeFile(dir, `${i.vendor_id}-${slug(i.name)}.md`, requestDraft(i)));
        return { summary: `${files.length} draft(s) written (${todo.filter((i) => i.request === 'reminder').length} reminder(s)); ${r.items.filter((i) => i.request === 'requested_recently').length} skipped as requested recently. Nothing was sent.`, files };
      },
    },
    {
      name: 'auxo_request_send', kind: 'action', category: 'binding_send',
      description: 'After one named human click (even in Auto), record that a reviewed draft is approved to send in send-requests.csv. A person sends it; Auxo never sends.',
      inputSchema: { type: 'object', required: ['vendor_id', 'draft'], properties: { vendor_id: str, draft: str, out_dir: str } },
      handler: async (a, ctx) => {
        for (const k of ['vendor_id', 'draft']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`);
        if (!existsSync(ctx.path(a.draft))) throw new Error(`draft not found: ${a.draft}`);
        const f = appendRow(ctx.outDir(a.out_dir || 'mythos-out/auxo'), 'send-requests.csv', { requested_at: new Date().toISOString(), vendor_id: a.vendor_id, draft: a.draft, status: 'approved - a person sends it' }, ['requested_at', 'vendor_id', 'draft', 'status']);
        return { summary: `Send approved and recorded for ${a.vendor_id}. Nothing was sent.`, file: f };
      },
    },
    { name: 'irs_efile', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Auxo never files information returns with the IRS or any agency.', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_email', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Auxo never sends email.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'auxo_check', decision: 'allow' },
    { tool: 'auxo_write_tracker', decision: 'allow' },
    { tool: 'auxo_draft_requests', decision: 'ask', reason: 'Writing request drafts needs a human yes (or an Auto opt-in).' },
    { tool: 'irs_efile', decision: 'block', reason: 'Auxo never files with the IRS. Your preparer files.' },
    { tool: 'send_email', decision: 'block', reason: 'Auxo never sends email.' },
    { tool: 'auxo_request_send', decision: 'ask', reason: 'A vendor-facing send is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Auxo allowlist.' },
  ] },
});
