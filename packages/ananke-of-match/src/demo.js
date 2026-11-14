import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto' });
  process.stdout.write(`Ananke of Match demo (fictional POs, receipts and invoices) in ${rt.root} — Auto mode on\n`);
  const f = { pos: 'pos.csv', receipts: 'receipts.csv', invoices: 'invoices.csv' };
  const m = await rt.call('ananke_match', f);
  printStep('Three-way match', m);
  for (const i of m.result.items.filter((x) => x.status !== 'matched')) process.stdout.write(`    ${i.status.padEnd(18)} ${i.invoice.padEnd(9)} L${i.line} $${String(i.est_impact).padEnd(8)} ${i.exceptions.map((e) => e.code).join(', ')}\n`);
  const e = await rt.call('ananke_explain_exception', { ...f, invoice: 'INV-2003' });
  printStep('Explain INV-2003', e);
  for (const x of e.result.lines[0].explanations) process.stdout.write(`    ${x.title}: ${x.suggested_next_step}\n`);
  printStep('Write the AP worklist', await rt.call('ananke_write_worklist', f));
  const req = { invoice: 'INV-2001', vendor: 'Acme Supply (fictional)', amount: 1200, reason: 'Matched within tolerance' };
  const a = await rt.call('ananke_request_posting', req);
  printStep('Auto: clear a matched invoice for posting — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Dana Reviewer (fictional)');
  process.stdout.write(`    (demo: "Dana Reviewer" approves ${a.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('ananke_request_posting', req));
  printStep('Agent tries to post straight to the ERP', await rt.call('erp_post_invoice', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
