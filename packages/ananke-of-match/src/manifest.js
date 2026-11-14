import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normPOs, normReceipts, normInvoices, match, explain, worklistCsv } from './match.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }, num = { type: 'number' };
const files = { pos: { ...str, description: 'PO lines CSV/JSON: po, line, item, vendor, qty, unit_price' }, receipts: { ...str, description: 'Receipts CSV/JSON: receipt, po, line, qty, date' }, invoices: { ...str, description: 'Invoice lines CSV/JSON: invoice, vendor, po, line, qty, unit_price, date' }, price_pct: num, price_abs: num, qty_tolerance: num };
const run = (a, ctx) => match(normPOs(ctx.records(a.pos)), normReceipts(ctx.records(a.receipts)), normInvoices(ctx.records(a.invoices)), { price_pct: a.price_pct, price_abs: a.price_abs, qty: a.qty_tolerance });

export const manifest = defineManifest({
  name: 'ananke-of-match',
  version: pkg.version,
  description: 'Investigates AP three-way-match exceptions (PO, receipt, invoice) from CSV/JSON exports: no PO, missing line, over-billing, price variance, duplicates, vendor mismatch. Writes a worklist. Posting is always one human click and only records a request; Ananke never posts to an ERP or pays.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'ananke_match', kind: 'read',
      description: 'Three-way match every invoice line against POs and receipts with your tolerances; list exceptions with an estimated $ impact.',
      inputSchema: { type: 'object', required: ['pos', 'receipts', 'invoices'], properties: files },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.invoices} invoice line(s): ${r.matched} matched, ${r.matched_with_notes} with notes, ${r.exceptions} exception(s), est. $${r.est_impact_total} at issue.`, ...r }; },
    },
    {
      name: 'ananke_explain_exception', kind: 'read',
      description: 'Explain one invoice line: each exception, why it matters and a suggested next step.',
      inputSchema: { type: 'object', required: ['pos', 'receipts', 'invoices', 'invoice'], properties: { ...files, invoice: str, line: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const hits = r.items.filter((i) => i.invoice === String(a.invoice).toUpperCase() && (!a.line || i.line === String(a.line)));
        if (!hits.length) throw new Error(`invoice ${a.invoice} not found`);
        return { summary: hits.map((h) => `${h.invoice} line ${h.line}: ${h.status}${h.exceptions.length ? ' (' + h.exceptions.map((e) => e.code).join(', ') + ')' : ''}`).join('; '), lines: hits.map((h) => ({ invoice: h.invoice, line: h.line, row: h.row, status: h.status, est_impact: h.est_impact, explanations: explain(h) })) };
      },
    },
    {
      name: 'ananke_write_worklist', kind: 'report',
      description: 'Write ap-exceptions.csv (blank owner and resolution columns) and ap-match.json into out_dir (default mythos-out/ananke).',
      inputSchema: { type: 'object', required: ['pos', 'receipts', 'invoices'], properties: { ...files, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/ananke');
        return { summary: `Worklist written: ${r.exceptions} exception(s), est. $${r.est_impact_total}.`, files: [ctx.writeFile(out, 'ap-exceptions.csv', worklistCsv(r)), ctx.writeFile(out, 'ap-match.json', JSON.stringify(r, null, 2))], exceptions: r.exceptions };
      },
    },
    {
      name: 'ananke_request_posting', kind: 'action', category: 'move_money',
      description: 'After one named human click (even in Auto), record that an invoice is cleared for posting in posting-requests.csv. It never posts to an ERP or pays.',
      inputSchema: { type: 'object', required: ['invoice', 'vendor', 'amount', 'reason'], properties: { invoice: str, vendor: str, amount: num, reason: str, out_dir: str } },
      handler: async (a, ctx) => {
        for (const k of ['invoice', 'vendor', 'reason']) if (!String(a[k] || '').trim()) throw new Error(`${k} is required`);
        const out = ctx.outDir(a.out_dir || 'mythos-out/ananke'); const f = join(out, 'posting-requests.csv');
        const row = toCsv([{ requested_at: new Date().toISOString(), invoice: a.invoice, vendor: a.vendor, amount: a.amount, reason: a.reason, status: 'approved request - AP to post in the ERP' }], ['requested_at', 'invoice', 'vendor', 'amount', 'reason', 'status']);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `Posting request recorded for ${a.invoice}. Nothing was posted or paid.`, file: f };
      },
    },
    { name: 'erp_post_invoice', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Ananke never writes to an ERP.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'ananke_match', decision: 'allow' },
    { tool: 'ananke_explain_exception', decision: 'allow' },
    { tool: 'ananke_write_worklist', decision: 'allow' },
    { tool: 'erp_post_invoice', decision: 'block', reason: 'Ananke never posts to an ERP or pays.' },
    { tool: 'ananke_request_posting', decision: 'ask', reason: 'Clearing an invoice for payment is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Ananke allowlist.' },
  ] },
});
