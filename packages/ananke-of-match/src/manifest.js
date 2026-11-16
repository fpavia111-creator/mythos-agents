import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normPOs, normReceipts, normInvoices, match, explain, worklistCsv, poStatus, poStatusCsv, reportHtml } from './match.js';
import { TOLERANCE_SCHEMA, PROMPTS } from './config.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }, num = { type: 'number' };
const tolNum = (d) => ({ type: 'number', minimum: 0, description: d });
const files = { pos: { ...str, description: 'PO lines CSV/JSON: po, line, item, vendor, qty, unit_price' }, receipts: { ...str, description: 'Receipts CSV/JSON: receipt, po, line, qty, date' }, invoices: { ...str, description: 'Invoice lines CSV/JSON: invoice, vendor, po, line, qty, unit_price, date' },
  price_pct: tolNum('Price tolerance in percent (default 2)'), price_abs: tolNum('Price tolerance as an absolute amount per unit (default 0)'), qty_tolerance: tolNum('Quantity tolerance in units (default 0)'),
  tolerance_profile: { ...str, description: 'Optional JSON file with per-vendor tolerances (schema "tolerances"; see validate-config). A vendor entry wins over these arguments.' } };
const load = (a, ctx) => {
  const pos = normPOs(ctx.records(a.pos)), receipts = normReceipts(ctx.records(a.receipts)), invoices = normInvoices(ctx.records(a.invoices));
  const profile = a.tolerance_profile ? ctx.readJson(a.tolerance_profile, 'tolerances') : null;
  return { pos, receipts, r: match(pos, receipts, invoices, { price_pct: a.price_pct, price_abs: a.price_abs, qty: a.qty_tolerance }, profile) };
};
const run = (a, ctx) => load(a, ctx).r;

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'ananke-of-match',
  version: pkg.version,
  description: 'Investigates AP three-way-match exceptions (PO, receipt, invoice) from CSV/JSON exports: no PO, missing line, over-billing across partial receipts and several invoices, price variance with optional per-vendor tolerances, exact and near-duplicate invoices, vendor mismatch. Reports PO line status with a GRNI estimate and writes a worklist and an HTML report. Posting is always one human click and only records a request; Ananke never posts to an ERP or pays.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { tolerances: TOLERANCE_SCHEMA },
  prompts: PROMPTS,
  tools: [
    {
      name: 'ananke_match', kind: 'read', title: 'Three-way match',
      description: 'Three-way match every invoice line against POs and receipts with your tolerances; list exceptions with an estimated $ impact.',
      inputSchema: { type: 'object', required: ['pos', 'receipts', 'invoices'], properties: files },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.invoices} invoice line(s): ${r.matched} matched, ${r.matched_with_notes} with notes, ${r.exceptions} exception(s), est. $${r.est_impact_total} at issue.`, ...r }; },
    },
    {
      name: 'ananke_explain_exception', kind: 'read', title: 'Explain one invoice',
      description: 'Explain one invoice line: each exception, why it matters and a suggested next step.',
      inputSchema: { type: 'object', required: ['pos', 'receipts', 'invoices', 'invoice'], properties: { ...files, invoice: str, line: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const hits = r.items.filter((i) => i.invoice === String(a.invoice).toUpperCase() && (!a.line || i.line === String(a.line)));
        if (!hits.length) throw new Error(`invoice ${a.invoice} not found`);
        return { summary: hits.map((h) => `${h.invoice} line ${h.line}: ${h.status}${h.exceptions.length ? ' (' + h.exceptions.map((e) => e.code).join(', ') + ')' : ''}`).join('; '), lines: hits.map((h) => ({ invoice: h.invoice, line: h.line, row: h.row, status: h.status, est_impact: h.est_impact, explanations: explain(h) })) };
      },
    },
    {
      name: 'ananke_write_worklist', kind: 'report', title: 'Write the AP worklist',
      description: 'Write ap-exceptions.csv (blank owner and resolution columns) and ap-match.json into out_dir (default mythos-out/ananke).',
      inputSchema: { type: 'object', required: ['pos', 'receipts', 'invoices'], properties: { ...files, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/ananke');
        const csv = worklistCsv(r);
        return { summary: `Worklist written: ${r.exceptions} exception(s), est. $${r.est_impact_total}.`, files: [ctx.writeFile(out, 'ap-exceptions.csv', csv), ctx.writeFile(out, 'ap-match.json', JSON.stringify(r, null, 2))], exceptions: r.exceptions, output_sha256: sha256(csv) };
      },
    },
    {
      name: 'ananke_po_status', kind: 'read', title: 'PO line status and GRNI',
      description: 'Per PO line: ordered, received, billed (duplicates excluded), left to receive, received-not-billed (GRNI accrual estimate at PO price) and billed-not-received. Optional po filter.',
      inputSchema: { type: 'object', required: ['pos', 'receipts', 'invoices'], properties: { ...files, po: { ...str, description: 'Only this PO number' } } },
      handler: async (a, ctx) => {
        const { pos, receipts, r } = load(a, ctx); const s = poStatus(pos, receipts, r, { po: a.po });
        if (!s.lines.length) throw new Error(a.po ? `PO ${a.po} not found` : 'no PO lines in the file');
        return { summary: `${s.lines.length} PO line(s): GRNI estimate $${s.grni_value_total}, billed-not-received $${s.billed_not_received_total}, open PO value $${s.open_po_value_total}.`, ...s };
      },
    },
    {
      name: 'ananke_write_report', kind: 'report', title: 'Write the AP match report (HTML + PO status CSV)',
      description: 'Write ap-report.html (self-contained, no scripts: totals, exceptions by $ impact, vendor scorecard, PO line status) and ap-po-status.csv into out_dir (default mythos-out/ananke). The HTML hash is logged in the audit line.',
      inputSchema: { type: 'object', required: ['pos', 'receipts', 'invoices'], properties: { ...files, out_dir: str, title: str } },
      handler: async (a, ctx) => {
        const { pos, receipts, r } = load(a, ctx); const s = poStatus(pos, receipts, r); const out = ctx.outDir(a.out_dir || 'mythos-out/ananke');
        const html = reportHtml(r, s, { title: a.title || 'AP three-way match report', at: new Date().toISOString() });
        return { summary: `Report written: ${r.exceptions} exception(s), est. $${r.est_impact_total}; GRNI estimate $${s.grni_value_total}.`, files: [ctx.writeFile(out, 'ap-report.html', html), ctx.writeFile(out, 'ap-po-status.csv', poStatusCsv(s))], output_sha256: sha256(html) };
      },
    },
    {
      name: 'ananke_request_posting', kind: 'action', category: 'move_money', title: 'Record a posting request (one-click)',
      description: 'After one named human click (even in Auto), record that an invoice is cleared for posting in posting-requests.csv. It never posts to an ERP or pays.',
      inputSchema: { type: 'object', required: ['invoice', 'vendor', 'amount', 'reason'], properties: { invoice: { ...str, minLength: 1 }, vendor: { ...str, minLength: 1 }, amount: num, reason: { ...str, minLength: 1 }, out_dir: str } },
      handler: async (a, ctx) => {
        for (const k of ['invoice', 'vendor', 'reason']) if (!String(a[k] || '').trim()) throw new Error(`${k} is required`);
        const out = ctx.outDir(a.out_dir || 'mythos-out/ananke'); const f = join(out, 'posting-requests.csv');
        const row = toCsv([{ requested_at: new Date().toISOString(), invoice: a.invoice, vendor: a.vendor, amount: a.amount, reason: a.reason, status: 'approved request - AP to post in the ERP' }], ['requested_at', 'invoice', 'vendor', 'amount', 'reason', 'status']);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `Posting request recorded for ${a.invoice}. Nothing was posted or paid.`, file: f };
      },
    },
    { name: 'erp_post_invoice', kind: 'action', category: 'move_money', title: 'Post to ERP (always refused)', description: 'Listed so agents can see it is refused. Ananke never writes to an ERP.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'ananke_match', decision: 'allow' },
    { tool: 'ananke_explain_exception', decision: 'allow' },
    { tool: 'ananke_write_worklist', decision: 'allow' },
    { tool: 'ananke_po_status', decision: 'allow' },
    { tool: 'ananke_write_report', decision: 'allow' },
    { tool: 'erp_post_invoice', decision: 'block', reason: 'Ananke never posts to an ERP or pays.' },
    { tool: 'ananke_request_posting', decision: 'ask', reason: 'Clearing an invoice for payment is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Ananke allowlist.' },
  ] },
});
