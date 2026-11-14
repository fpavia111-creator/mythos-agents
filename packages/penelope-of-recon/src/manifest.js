import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normBank, normGL, reconcile, workpaperCsv, summaryMarkdown } from './recon.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }, num = { type: 'number' };
const files = { bank: { ...str, description: 'Bank statement CSV/JSON: date, description, reference, amount (or debit/credit)' }, gl: { ...str, description: 'GL cash-account detail CSV/JSON: date, memo, reference, amount (or debit/credit)' }, bank_balance: num, gl_balance: num, date_window: num, amount_tolerance: num, max_group: num };
const load = (a, ctx) => { const bank = normBank(ctx.records(a.bank)); const gl = normGL(ctx.records(a.gl)); return { bank, gl, r: reconcile(bank, gl, a) }; };
function append(ctx, a, file, row, cols) {
  const out = ctx.outDir(a.out_dir || 'mythos-out/penelope'); const f = join(out, file);
  const csv = toCsv([row], cols); appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}
const need = (a, ks) => { for (const k of ks) if (a[k] === undefined || String(a[k]).trim() === '') throw new Error(`${k} is required`); };

export const manifest = defineManifest({
  name: 'penelope-of-recon',
  version: pkg.version,
  description: 'Bank-to-GL reconciliation from CSV/JSON exports: proposes matches (reference, amount and date, batched deposits), lists items on one side only, ties adjusted balances and drafts adjusting entries. Posting an adjusting entry is always one human click and only records a request.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'penelope_reconcile', kind: 'read',
      description: 'Propose matches between bank and GL lines, list bank-only and GL-only items, and tie adjusted balances when both balances are given.',
      inputSchema: { type: 'object', required: ['bank', 'gl'], properties: files },
      handler: async (a, ctx) => { const { r } = load(a, ctx); return { summary: `${r.matched_groups} proposed match(es); ${r.bank_only.length} bank-only, ${r.gl_only.length} GL-only${r.balance ? `; difference ${r.balance.difference} (${r.balance.ties ? 'ties' : 'does not tie'})` : ''}.`, ...r }; },
    },
    {
      name: 'penelope_write_workpaper', kind: 'report',
      description: 'Write reconciliation.csv (blank reviewer columns), reconciliation.md and proposed-entries.csv into out_dir (default mythos-out/penelope).',
      inputSchema: { type: 'object', required: ['bank', 'gl'], properties: { ...files, out_dir: str } },
      handler: async (a, ctx) => {
        const { bank, gl, r } = load(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/penelope');
        const entries = toCsv(r.bank_only.filter((b) => b.adjusting_entry).map((b) => ({ bank_line: b.id, date: b.date, amount: b.amount, account: b.adjusting_entry.account, memo: b.adjusting_entry.memo, status: 'proposed - not posted' })), ['bank_line', 'date', 'amount', 'account', 'memo', 'status']);
        const filesOut = [ctx.writeFile(out, 'reconciliation.csv', workpaperCsv(r, bank, gl)), ctx.writeFile(out, 'reconciliation.md', summaryMarkdown(r, new Date().toISOString())), ctx.writeFile(out, 'proposed-entries.csv', entries)];
        return { summary: `Workpaper written: ${r.matched_groups} proposed match(es), ${r.bank_only.filter((b) => b.adjusting_entry).length} proposed entr(ies).`, files: filesOut };
      },
    },
    {
      name: 'penelope_accept_match', kind: 'write',
      description: 'Record that a person accepted a proposed match in accepted-matches.csv. Needs a human yes unless opted in to Auto. Changes nothing in the ledger.',
      inputSchema: { type: 'object', required: ['bank_ids', 'gl_ids'], properties: { bank_ids: str, gl_ids: str, note: str, out_dir: str } },
      handler: async (a, ctx) => { need(a, ['bank_ids', 'gl_ids']); return { summary: `Match ${a.bank_ids} ↔ ${a.gl_ids} recorded as accepted.`, file: append(ctx, a, 'accepted-matches.csv', { accepted_at: new Date().toISOString(), bank_ids: a.bank_ids, gl_ids: a.gl_ids, note: a.note || '' }, ['accepted_at', 'bank_ids', 'gl_ids', 'note']) }; },
    },
    {
      name: 'penelope_request_adjusting_entry', kind: 'action', category: 'move_money',
      description: 'After one named human click (even in Auto), record an approved adjusting entry in adjusting-entry-requests.csv for a person to post. Never posts to the ledger.',
      inputSchema: { type: 'object', required: ['date', 'amount', 'account', 'memo'], properties: { date: str, amount: num, account: str, memo: str, bank_line: str, out_dir: str } },
      handler: async (a, ctx) => { need(a, ['date', 'amount', 'account', 'memo']); return { summary: `Adjusting entry request recorded (${a.amount} to ${a.account}). Nothing was posted.`, file: append(ctx, a, 'adjusting-entry-requests.csv', { requested_at: new Date().toISOString(), date: a.date, amount: a.amount, account: a.account, memo: a.memo, bank_line: a.bank_line || '', status: 'approved request - a person posts it in the ledger' }, ['requested_at', 'date', 'amount', 'account', 'memo', 'bank_line', 'status']) }; },
    },
    { name: 'ledger_post_journal', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Penelope never writes to a ledger or ERP.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'penelope_reconcile', decision: 'allow' },
    { tool: 'penelope_write_workpaper', decision: 'allow' },
    { tool: 'penelope_accept_match', decision: 'ask', reason: 'Accepting a match needs a human yes (or an Auto opt-in).' },
    { tool: 'ledger_post_journal', decision: 'block', reason: 'Penelope never posts to a ledger or ERP.' },
    { tool: 'penelope_request_adjusting_entry', decision: 'ask', reason: 'Adjusting entries change the books: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Penelope allowlist.' },
  ] },
});
