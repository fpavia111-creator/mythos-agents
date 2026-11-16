import { defineManifest, toCsv, sha256, safeMarkdown, safeFileName } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { check, trackerCsv, readinessMarkdown, requestDraft, slug, readiness1099, readiness1099Markdown, readinessCsv, findDuplicates } from './vendors.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  vendors: { ...str, description: 'Vendor export CSV/JSON: vendor_id, name, legal_name, entity_type, country, tin, w9_received, w9_signed, address, email, requested_date; for non-US vendors w8_received, w8_type, w8_signed' },
  payments: { ...str, description: 'Optional payments CSV/JSON: vendor_id, date, amount, method (ach, check, wire, card, paypal…)' },
  year: { type: 'integer', minimum: 2000, maximum: 2100, description: 'Payment year (default: the as_of year)' },
  threshold: { ...num, minimum: 0, description: 'Payment total to flag. Default 600 before 2026, 2000 for 2026; later years must be confirmed with your preparer.' },
  as_of: { ...str, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, refresh_years: { ...num, minimum: 1 }, remind_days: { ...num, minimum: 0 },
};
const run = (a, ctx) => check(ctx.records(a.vendors), a.payments ? ctx.records(a.payments) : [], a);
function appendRow(dir, file, row, cols) {
  const f = join(dir, file); const csv = toCsv([row], cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'auxo-of-vendors',
  version: pkg.version,
  description: 'Vendor W-9 and W-8 readiness from CSV exports: missing, unsigned or expired forms, TIN format and pattern per entity type (always masked; no IRS matching), duplicate vendor records, a 1099 readiness summary, missing name, address or LLC classification, old forms, non-US vendors, and payment totals against a threshold you set. Writes a tracker and drafts request and reminder emails. Sending is one human click. It never files with the IRS and gives no tax advice.',
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
      handler: async (a, ctx) => { const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/auxo'); const t = trackerCsv(r), m = safeMarkdown(readinessMarkdown(r)); return { summary: `Tracker written for ${r.vendors} vendor(s).`, files: [ctx.writeFile(out, 'w9-tracker.csv', t), ctx.writeFile(out, 'readiness.md', m)], output_sha256: sha256(`w9-tracker.csv:${sha256(t)}\nreadiness.md:${sha256(m)}`) }; },
    },
    {
      name: 'auxo_1099_readiness', kind: 'report', title: '1099 readiness summary',
      description: 'List US vendors at or over the payment threshold (non-card methods) for the year and what each is still missing (W-9, signature, plausible TIN, LLC classification, name, address); non-US vendors over the threshold with their W-8 state; card/app-only payees; payments with no vendor record. Writes 1099-readiness.md and 1099-readiness.csv (TINs masked); the output hash goes into the audit line. Not a filing and not tax advice: Auxo never e-files.',
      inputSchema: { type: 'object', required: ['vendors', 'payments'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const vendors = ctx.records(a.vendors); const payments = ctx.records(a.payments);
        const x = readiness1099(check(vendors, payments, a), null, payments);
        const md = safeMarkdown(readiness1099Markdown(x)); const csv = readinessCsv(x); const out = ctx.outDir(a.out_dir || 'mythos-out/auxo');
        const files = [ctx.writeFile(out, '1099-readiness.md', md), ctx.writeFile(out, '1099-readiness.csv', csv)];
        return { summary: `${x.year}: ${x.over_threshold} US vendor(s) at or over ${x.threshold}: ${x.ready} ready, ${x.missing_data} missing data; ${x.foreign_over_threshold.length} non-US; ${x.payments_without_vendor_record.length} payee(s) with no vendor record. Not a filing; nothing was sent to the IRS.`, ...x, files, output_sha256: sha256(`1099-readiness.md:${sha256(md)}\n1099-readiness.csv:${sha256(csv)}`) };
      },
    },
    {
      name: 'auxo_find_duplicates', kind: 'read', title: 'Find duplicate vendor records',
      description: 'Find vendor records that may be the same payee: same TIN (compared in memory, never shown), very similar legal names, or the same address or email. Flags pairs whose combined non-card payments reach the threshold while each record alone does not (split_under_threshold). A person decides whether to merge.',
      inputSchema: { type: 'object', required: ['vendors'], properties: { ...props, name_threshold: { type: 'number', minimum: 0.5, maximum: 1, description: 'Name similarity needed on its own (default 0.92)' } } },
      handler: async (a, ctx) => {
        const d = findDuplicates(ctx.records(a.vendors), a.payments ? ctx.records(a.payments) : [], a);
        return { summary: `${d.pairs.length} possible duplicate pair(s) among ${d.vendors} vendor record(s); ${d.split_under_threshold} split under the threshold.`, ...d };
      },
    },
    {
      name: 'auxo_draft_requests', kind: 'write',
      description: 'Write a request or reminder email draft (marked DRAFT, not sent) for each vendor that needs one into out_dir/requests. Vendors asked within remind_days are skipped. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['vendors'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const dir = join(ctx.outDir(a.out_dir || 'mythos-out/auxo'), 'requests'); mkdirSync(dir, { recursive: true });
        const todo = r.items.filter((i) => ['first_request', 'reminder'].includes(i.request));
        const files = todo.map((i) => ctx.writeFile(dir, `${safeFileName(i.vendor_id)}-${slug(i.name)}.md`, requestDraft(i)));
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
  prompts: [
    {
      name: 'auxo_year_end_readiness', title: 'W-9 / W-8 and 1099 readiness review',
      description: 'Walk through vendor tax-form readiness for a payment year: check, duplicates, 1099 readiness summary, tracker, request drafts, and the human send step. Never files, never gives tax advice.',
      arguments: [
        { name: 'vendors', description: 'Vendor export CSV/JSON under --root', required: true },
        { name: 'payments', description: 'Payments CSV/JSON under --root', required: true },
        { name: 'year', description: 'Payment year (optional)', required: false },
        { name: 'threshold', description: 'Threshold your preparer confirmed (optional)', required: false },
      ],
      text: [
        'You are preparing a vendor tax-form readiness review with the auxo-of-vendors tools. Vendors: {{vendors}}. Payments: {{payments}}. Year: {{year}}. Threshold: {{threshold}}. Leave out any argument shown in [brackets].',
        'Rules: never print a full TIN (the tools only return masked TINs; do not ask the user to paste one). Do not say who is reportable, which form applies or how card payments are treated: that is the preparer\'s call. Auxo never files with the IRS.',
        '1. Call auxo_check with vendors, payments, year and threshold. If threshold_confirmed is false, tell the person to get the figure from their preparer and pass threshold.',
        '2. Call auxo_find_duplicates. Raise split_under_threshold pairs first, then same_tin pairs. A person decides whether records are the same payee; do not merge anything.',
        '3. Call auxo_1099_readiness. Read the rows with missing data, highest payments first; list non-US vendors with their W-8 state (w8_missing, w8_unsigned, w8_expired) and payments with no vendor record.',
        '4. Call auxo_write_tracker and give the person the paths of w9-tracker.csv, readiness.md and 1099-readiness.md.',
        '5. Call auxo_draft_requests (it asks for a human yes unless opted in to Auto). Drafts ask vendors to use a secure upload link; nothing is sent.',
        '6. Human click: after a person reviews a draft, auxo_request_send records it as approved to send. It is one named human click even in Auto. irs_efile and send_email are blocked; never try them.',
        'TIN checks are format and pattern checks only, not IRS TIN matching. Say this is a readiness check on the person\'s own records, not tax advice.',
      ].join('\n'),
    },
  ],
  policy: { rules: [
    { tool: 'auxo_check', decision: 'allow' },
    { tool: 'auxo_write_tracker', decision: 'allow' },
    { tool: 'auxo_1099_readiness', decision: 'allow' },
    { tool: 'auxo_find_duplicates', decision: 'allow' },
    { tool: 'auxo_draft_requests', decision: 'ask', reason: 'Writing request drafts needs a human yes (or an Auto opt-in).' },
    { tool: 'irs_efile', decision: 'block', reason: 'Auxo never files with the IRS. Your preparer files.' },
    { tool: 'send_email', decision: 'block', reason: 'Auxo never sends email.' },
    { tool: 'auxo_request_send', decision: 'ask', reason: 'A vendor-facing send is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Auxo allowlist.' },
  ] },
});
