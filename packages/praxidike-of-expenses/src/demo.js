import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['praxidike_stage_reimbursement'] });
  process.stdout.write(`Praxidike of Expenses demo (fictional reports, receipts and policy) in ${rt.root} — Auto on for praxidike_stage_reimbursement only\nRecommendations only. Not fraud detection. Praxidike never pays.\n`);
  const f = { expenses: 'expenses.csv', policy: 'policy.json', receipts: 'receipts' };
  const r = await rt.call('praxidike_review', f);
  printStep('Review expense reports against the written policy', r);
  for (const s of r.result.report_summaries) process.stdout.write(`    ${s.report_id} ${s.employee.padEnd(10)} claimed ${s.claimed.toFixed(2).padStart(7)}  recommend ${s.recommended.toFixed(2).padStart(7)}  ${s.recommendation.padEnd(20)} ${s.findings.join(', ') || '—'}\n`);
  printStep('Write the review and line findings', await rt.call('praxidike_write_report', f));
  const rc = await rt.call('praxidike_read_receipts', { receipts: 'receipt-styles' });
  printStep('Normalise five receipt text styles (text never returned)', rc);
  for (const x of rc.result.receipts) process.stdout.write(`    ${x.file.padEnd(20)} ${x.merchant.padEnd(20)} ${String(x.total).padStart(8)} ${x.currency}  ${x.date}\n`);
  const t = await rt.call('praxidike_review', { expenses: 'expenses-travel.csv', policy: 'policy.json' });
  printStep('Per diem by location and date, mileage rate by date', t);
  for (const l of t.result.items) for (const x of l.findings) process.stdout.write(`    ${l.report_id}/${l.line_id} ${x.check}: ${x.detail}\n`);
  const h = { ...f, history: 'history.csv' };
  const d = await rt.call('praxidike_find_duplicates', { expenses: f.expenses, receipts: f.receipts, history: h.history });
  printStep('Possible duplicates, including against last period (history.csv)', d);
  for (const p of d.result.items) process.stdout.write(`    ${p.a} ~ ${p.b}${p.b_source === 'history' ? ' (earlier)' : ''}  ${p.kind} ${p.score}: ${p.reasons[0].reason}\n`);
  const q = await rt.call('praxidike_audit_queue', h);
  printStep('Rank reports for review (explainable score)', q);
  for (const x of q.result.queue) process.stdout.write(`    ${x.rank}. ${x.report_id} ${String(x.score).padStart(3)} ${x.tier.padEnd(6)} ${x.reasons.slice(0, 2).map((r) => `+${r.points} ${r.reason}`).join('; ') || '—'}\n`);
  const ev = await rt.call('praxidike_write_evidence_pack', h);
  printStep('Write the evidence pack (hash recorded in the audit log)', ev);
  process.stdout.write(`    output_sha256 ${ev.result.output_sha256}\n`);
  const s = await rt.call('praxidike_stage_reimbursement', f);
  printStep('Auto: pre-stage the reimbursement batch (opted in; nothing paid)', s);
  const req = { batch: s.result.batch, batch_sha256: s.result.batch_sha256 };
  const a = await rt.call('praxidike_request_reimbursement', req);
  printStep('Auto: reimburse the batch — stays one-click (moves money)', a);
  rt.approvals.approve(a.approval_id, 'Kim Controller (fictional)');
  process.stdout.write(`    (demo: "Kim Controller" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not paid)', await rt.call('praxidike_request_reimbursement', req));
  printStep('Agent tries to pay the reimbursement itself', await rt.call('pay_reimbursement', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
