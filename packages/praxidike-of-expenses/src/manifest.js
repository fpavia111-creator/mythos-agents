import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { review, findingsCsv, reviewMarkdown, batchCsv } from './expenses.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  expenses: { ...str, description: 'Expense lines CSV/JSON: report_id, line_id, employee, date, submitted_on, category, merchant, amount, currency, receipt, purpose, attendees, nights, miles, preapproved_by' },
  policy: { ...str, description: 'Your written policy as JSON rules (source, currency, receipt_required_over, submit_within_days, preapproval_over, categories, disallowed, sections). Every finding cites a section.' },
  receipts: { ...str, description: 'Optional folder of receipt files named in the receipt column. Text receipts are read for totals and dates only.' },
};
function run(a, ctx) {
  for (const k of ['expenses', 'policy']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`);
  const pf = ctx.path(a.policy); if (!existsSync(pf)) throw new Error(`policy not found: ${a.policy}`);
  let policy; try { policy = JSON.parse(readFileSync(pf, 'utf8')); } catch (e) { throw new Error(`policy is not valid JSON: ${e.message}`); }
  let receiptsDir = null;
  if (a.receipts) { receiptsDir = ctx.path(a.receipts); if (!existsSync(receiptsDir) || !statSync(receiptsDir).isDirectory()) throw new Error(`receipts folder not found: ${a.receipts}`); }
  return review(ctx.records(a.expenses), policy, { receiptsDir });
}
function appendRows(dir, file, rows, cols) {
  const f = join(dir, file); const csv = toCsv(rows, cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  name: 'praxidike-of-expenses',
  version: pkg.version,
  description: 'Compares expense lines and receipt text with your written expense policy: receipts, limits per item, person or night, mileage, disallowed categories, business purpose, attendees, pre-approval, late submission, currency and possible duplicates. Cites the policy section for every finding and recommends approve, approve with changes, needs info or reject. Pre-stages a reimbursement batch; reimbursing is one human click and paying is blocked. Not fraud detection.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'praxidike_review', kind: 'read',
      description: 'Review every line against the policy and recommend per report. Findings cite policy sections. Receipt text is never returned; card-like numbers in purposes are masked.',
      inputSchema: { type: 'object', required: ['expenses', 'policy'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.reports} report(s): approve ${r.approve}, approve with changes ${r.approve_with_changes}, needs info ${r.needs_info}, reject ${r.reject}. Claimed ${r.claimed.toFixed(2)}, recommended ${r.recommended.toFixed(2)} ${r.currency}. Recommendations only.`, ...r }; },
    },
    {
      name: 'praxidike_write_report', kind: 'report',
      description: 'Write expense-review.md and line-findings.csv (blank reviewer columns) into out_dir (default mythos-out/praxidike).',
      inputSchema: { type: 'object', required: ['expenses', 'policy'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => { const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/praxidike'); return { summary: `Review written for ${r.reports} report(s).`, files: [ctx.writeFile(out, 'expense-review.md', reviewMarkdown(r)), ctx.writeFile(out, 'line-findings.csv', findingsCsv(r))] }; },
    },
    {
      name: 'praxidike_stage_reimbursement', kind: 'write',
      description: 'Pre-stage a reimbursement batch: staged-reimbursements.csv and batch.json (with hashes) for reports recommended approve or approve with changes, at the recommended amounts. Nothing is paid. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['expenses', 'policy'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/praxidike');
        const csv = batchCsv(r); const cf = ctx.writeFile(out, 'staged-reimbursements.csv', csv);
        const staged = r.report_summaries.filter((s) => s.recommended > 0);
        const batch = { created_at: new Date().toISOString(), policy_source: r.policy_source, currency: r.currency, reports: staged.map((s) => ({ report_id: s.report_id, employee: s.employee, amount: s.recommended, recommendation: s.recommendation })), total: Math.round(staged.reduce((t, s) => t + s.recommended, 0) * 100) / 100, csv: 'staged-reimbursements.csv', csv_sha256: sha256(csv), held: r.report_summaries.filter((s) => s.recommended === 0).map((s) => `${s.report_id} (${s.recommendation})`), status: 'staged - not paid' };
        const bText = JSON.stringify(batch, null, 2) + '\n'; const bf = ctx.writeFile(out, 'batch.json', bText);
        return { summary: `Staged ${staged.length} report(s), ${batch.total.toFixed(2)} ${r.currency}; held ${batch.held.length}. Nothing was paid.`, batch: relative(ctx.root, bf).split('\\').join('/'), batch_sha256: sha256(bText), total: batch.total, files: [cf, bf] };
      },
    },
    {
      name: 'praxidike_request_reimbursement', kind: 'action', category: 'move_money',
      description: 'After one named human click (even in Auto), record that the staged batch is approved for payment in reimbursement-approvals.csv. The approval is tied to batch_sha256 and the staged CSV is re-hashed first. A person pays it in your payroll or AP system; Praxidike never pays.',
      inputSchema: { type: 'object', required: ['batch', 'batch_sha256'], properties: { batch: str, batch_sha256: str, out_dir: str } },
      handler: async (a, ctx) => {
        const bf = ctx.path(a.batch); if (!existsSync(bf)) throw new Error(`batch not found: ${a.batch}`);
        const text = readFileSync(bf, 'utf8'); if (sha256(text) !== a.batch_sha256) throw new Error('batch_sha256 does not match the batch file; review the current batch and ask again');
        const b = JSON.parse(text); const cf = join(dirname(bf), b.csv);
        if (!existsSync(cf) || sha256(readFileSync(cf, 'utf8')) !== b.csv_sha256) throw new Error('staged-reimbursements.csv changed after the batch was staged');
        if (!b.reports.length) throw new Error('the batch has no reports to reimburse');
        const at = new Date().toISOString();
        const file = appendRows(ctx.outDir(a.out_dir || 'mythos-out/praxidike'), 'reimbursement-approvals.csv', b.reports.map((r) => ({ approved_at: at, batch_sha256: a.batch_sha256, report_id: r.report_id, employee: r.employee, amount: r.amount.toFixed(2), currency: b.currency, status: 'approved - a person pays it' })), ['approved_at', 'batch_sha256', 'report_id', 'employee', 'amount', 'currency', 'status']);
        return { summary: `Reimbursement of ${b.total.toFixed(2)} ${b.currency} for ${b.reports.length} report(s) approved and recorded. Nothing was paid.`, file };
      },
    },
    { name: 'pay_reimbursement', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Praxidike never pays anyone or starts a bank or payroll transfer.', inputSchema: { type: 'object', properties: {} } },
    { name: 'ledger_post_expense', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Praxidike never posts to a ledger or expense system.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'praxidike_review', decision: 'allow' },
    { tool: 'praxidike_write_report', decision: 'allow' },
    { tool: 'praxidike_stage_reimbursement', decision: 'ask', reason: 'Staging a reimbursement batch needs a human yes (or an Auto opt-in).' },
    { tool: 'pay_reimbursement', decision: 'block', reason: 'Praxidike never pays. A person pays in your payroll or AP system.' },
    { tool: 'ledger_post_expense', decision: 'block', reason: 'Praxidike never posts to a ledger.' },
    { tool: 'praxidike_request_reimbursement', decision: 'ask', reason: 'Reimbursing moves money: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Praxidike allowlist.' },
  ] },
});
