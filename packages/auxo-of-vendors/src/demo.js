import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['auxo_draft_requests'] });
  process.stdout.write(`Auxo of Vendors demo (fictional vendors and payments) in ${rt.root} — Auto on for auxo_draft_requests only\nNot tax advice. Auxo never files anything.\n`);
  const f = { vendors: 'vendors.csv', payments: 'payments.csv', year: 2026, as_of: '2026-11-14' };
  const r = await rt.call('auxo_check', f);
  printStep('Check W-9 readiness for 2026 payments', r);
  for (const i of r.result.items) process.stdout.write(`    ${i.priority.padEnd(7)} ${i.vendor_id.padEnd(3)} ${i.name.padEnd(20)} ${i.status.padEnd(13)} TIN ${(i.tin_masked || '—').padEnd(15)} ${i.flags.join(', ') || '—'}\n`);
  printStep('Write the tracker (TINs masked)', await rt.call('auxo_write_tracker', f));
  const d = await rt.call('auxo_draft_requests', f);
  printStep('Auto: draft requests and reminders (opted in; nothing is sent)', d);
  const send = { vendor_id: 'V2', draft: 'mythos-out/auxo/requests/V2-pat-rivera.md' };
  const a = await rt.call('auxo_request_send', send);
  printStep('Auto: send the request to Pat Rivera — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Jo AP Lead (fictional)');
  process.stdout.write(`    (demo: "Jo AP Lead" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not sent)', await rt.call('auxo_request_send', send));
  printStep('Agent tries to e-file with the IRS', await rt.call('irs_efile', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
