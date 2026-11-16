import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['eucleia_add_suppression', 'eucleia_import_suppression'] });
  process.stdout.write(`Eucleia of Outreach demo (fictional drafts) in ${rt.root} — Auto on for the suppression list only\n`);
  const base = { drafts: 'drafts.csv', suppression: 'suppression.csv', config: 'eucleia.json' };
  printStep('Auto: import opt-outs and bounces from a Mailchimp export (adds only)', await rt.call('eucleia_import_suppression', { suppression: 'suppression.csv', export: 'esp/mailchimp-unsubscribed.csv' }));
  printStep('Same people from a HubSpot export: nothing new', await rt.call('eucleia_import_suppression', { suppression: 'suppression.csv', export: 'esp/hubspot-contacts.csv' }));
  const b = await rt.call('eucleia_check_batch', base);
  printStep('Check the batch', b);
  for (const r of b.result.results) process.stdout.write(`    ${r.ok ? 'READY' : 'HELD '} row ${r.row} ${r.to}${r.ok ? '' : ' — ' + r.fails.join('; ')}\n`);
  const c = await rt.call('eucleia_check_batch', { ...base, drafts: 'drafts-checks.csv' });
  printStep('Check a second batch: placeholders, links, recipient time zones, spam phrases', c);
  for (const r of c.result.results) process.stdout.write(`    ${r.ok ? 'READY' : 'HELD '} row ${r.row} ${r.to}${r.ok ? '' : ' — ' + r.fails.join('; ')}${r.spam_hits.length ? ` (spam phrases: ${r.spam_hits.map((h) => `"${h.phrase}" in ${h.field}`).join(', ')})` : ''}\n`);
  const plan = await rt.call('eucleia_plan_schedule', { ...base, drafts: 'drafts-checks.csv', start_from: '2026-11-16T00:00:00Z' });
  printStep('Plan send slots (window per recipient zone, daily cap, gap)', plan);
  for (const s of plan.result.slots) process.stdout.write(`    ${s.send_at}  ${s.local.padEnd(36)} ${s.to}\n`);
  printStep('Prepare the outbox (nothing is sent)', await rt.call('eucleia_prepare_outbox', base));
  printStep('Auto: add an opt-out reply to the suppression list', await rt.call('eucleia_add_suppression', { suppression: 'suppression.csv', email: 'pat@coppermill.example', reason: 'replied STOP' }));
  const rel = await rt.call('eucleia_release_batch', base);
  printStep('Auto: release the batch — stays one-click', rel);
  rt.approvals.approve(rel.approval_id, 'Kurt (demo approver)');
  process.stdout.write(`    (demo: a person approves ${rel.approval_id})\n`);
  printStep('Release after the human click', await rt.call('eucleia_release_batch', base));
  printStep('Agent tries to send the email itself', await rt.call('eucleia_send_email', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
