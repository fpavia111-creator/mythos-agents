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
