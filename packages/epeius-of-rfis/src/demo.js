import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['epeius_draft_rfi'] });
  process.stdout.write(`Epeius of RFIs demo (fictional project and documents) in ${rt.root} — Auto on for epeius_draft_rfi only\nNot design or engineering advice. Epeius never sends.\n`);
  const f = { documents: 'documents.csv', rfis: 'rfis.csv', submittals: 'submittals.csv', as_of: '2026-11-14' };
  const r = await rt.call('epeius_review_log', f);
  printStep('Review the RFI and submittal log against the document index', r);
  for (const i of r.result.items) process.stdout.write(`    RFI ${i.rfi_no} ${i.status.padEnd(8)} ${i.subject.padEnd(30)} ${i.flags.join(', ') || '—'}\n`);
  for (const s of r.result.submittal_items) process.stdout.write(`    ${s.submittal_no.padEnd(12)} ${s.status.padEnd(15)} ${s.flags.join(', ') || '—'}\n`);
  printStep('Write the log review', await rt.call('epeius_write_log_report', f));
  const q = { documents: 'documents.csv', rfis: 'rfis.csv', subject: 'Closer at exam room doors with vision lite', question: 'A-501 detail 6 shows door type D3 with a vision lite, and hardware set HW-4 includes a closer. Confirm the closer mounting side and whether the lite height clears the closer arm.', references: ['A-501', '08 71 00 2.3.B', 'A-201 rev 2'], search: ['D3', 'HW-4'], project: 'Maple Street Clinic fit-out (fictional)', to: 'Project architect (fictional)', from: 'Pat, Example Builders (fictional)' };
  const d = await rt.call('epeius_draft_rfi', q);
  printStep('Auto: draft an RFI citing only the documents provided (opted in; nothing sent)', d);
  const send = { draft: d.result.draft, draft_sha256: d.result.draft_sha256, to: 'Project architect (fictional)' };
  const a = await rt.call('epeius_request_send', send);
  printStep('Auto: send the RFI — stays one-click (binding send)', a);
  rt.approvals.approve(a.approval_id, 'Pat Project Engineer (fictional)');
  printStep('After the click: still refused while [CHECK REVISION] and [TO CONFIRM] are open', await rt.call('epeius_request_send', send));
  const d2 = await rt.call('epeius_draft_rfi', { ...q, references: ['A-501', '08 71 00 2.3.B', 'A-201'], needed_by: '2026-11-21', cost_impact: 'None expected', schedule_impact: 'Door install starts 2026-11-30' });
  printStep('Redraft on the current A-201 revision with impacts stated', d2);
  const send2 = { draft: d2.result.draft, draft_sha256: d2.result.draft_sha256, to: 'Project architect (fictional)' };
  const b = await rt.call('epeius_request_send', send2); rt.approvals.approve(b.approval_id, 'Pat Project Engineer (fictional)');
  process.stdout.write(`    (demo: "Pat Project Engineer" approves ${b.approval_id})\n`);
  printStep('Send request after the human click (recorded, not sent)', await rt.call('epeius_request_send', send2));
  printStep('Agent tries to submit to the project portal itself', await rt.call('project_portal_submit', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
