import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['eucleia_add_suppression'] });
  process.stdout.write(`Eucleia of Outreach demo (fictional drafts) in ${rt.root} — Auto on for eucleia_add_suppression only\n`);
  const base = { drafts: 'drafts.csv', suppression: 'suppression.csv', config: 'eucleia.json' };
  const b = await rt.call('eucleia_check_batch', base);
  printStep('Check the batch', b);
  for (const r of b.result.results) process.stdout.write(`    ${r.ok ? 'READY' : 'HELD '} row ${r.row} ${r.to}${r.ok ? '' : ' — ' + r.fails.join('; ')}\n`);
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
