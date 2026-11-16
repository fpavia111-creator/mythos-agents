import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['auxo_draft_requests'] });
  process.stdout.write(`Auxo of Vendors demo (fictional vendors and payments) in ${rt.root} — Auto on for auxo_draft_requests only\nNot tax advice. Auxo never files anything.\n`);
  const f = { vendors: 'vendors.csv', payments: 'payments.csv', year: 2026, as_of: '2026-11-14' };
  const r = await rt.call('auxo_check', f);
  printStep('Check W-9 readiness for 2026 payments', r);
  for (const i of r.result.items) process.stdout.write(`    ${i.priority.padEnd(7)} ${i.vendor_id.padEnd(3)} ${i.name.padEnd(20)} ${i.status.padEnd(13)} TIN ${(i.tin_masked || '—').padEnd(15)} ${i.flags.join(', ') || '—'}\n`);
  process.stdout.write('    (The sample TINs are invalid placeholders, so the pattern rules flag them: none is "ready".)\n');
  const m = { vendors: 'vendors-merged.csv', payments: 'payments-merged.csv', year: 2026, as_of: '2026-11-14' };
  const dup = await rt.call('auxo_find_duplicates', m);
  printStep('Find duplicate vendor records (larger sample with duplicates and a second non-US vendor)', dup);
  for (const p of dup.result.pairs) process.stdout.write(`    ${p.confidence.padEnd(6)} ${p.a}+${p.b}  ${p.reasons.join(', ')}  combined ${p.combined_reportable.toFixed(2)}${p.split_under_threshold ? '  ⚠ split under the threshold' : ''}\n`);
  const rd = await rt.call('auxo_1099_readiness', m);
  printStep('1099 readiness summary (not a filing)', rd);
  for (const x of rd.result.rows) process.stdout.write(`    ${x.vendor_id.padEnd(4)} ${String(x.name).padEnd(22)} ${x.paid_reportable_methods.toFixed(2).padStart(9)}  missing: ${x.missing.join(', ') || 'nothing'}\n`);
  for (const x of rd.result.foreign_over_threshold) process.stdout.write(`    ${x.vendor_id.padEnd(4)} ${String(x.name).padEnd(22)} ${x.paid_reportable_methods.toFixed(2).padStart(9)}  non-US: ${x.flags.join(', ') || 'W-8 on file'} (usually ${x.form_expected})\n`);
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
