import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['helios_request_downgrade'] });
  process.stdout.write(`Helios of Seats demo (fictional seats) in ${rt.root} — Auto on for helios_request_downgrade only\n`);
  const args = { seats: 'seats.csv', roster: 'hr-roster.csv', as_of: '2026-11-14' };
  const r = await rt.call('helios_find_waste', args);
  printStep('Find unused and over-tiered seats', r);
  for (const i of r.result.items.filter((x) => x.suggested_action !== 'keep')) process.stdout.write(`    ${i.suggested_action.padEnd(20)} ${i.app.padEnd(14)} ${i.user.padEnd(24)} $${i.est_monthly_saving}  ${i.flags.join(', ')}\n`);
  printStep('Write the seat review sheet', await rt.call('helios_write_review', args));
  printStep('Auto: request a downgrade (opted in)', await rt.call('helios_request_downgrade', { app: 'Figma', user: 'Sam Rivera (fictional)', to_tier: 'Starter', reason: 'No premium features used' }));
  const req = { app: 'Salesforce', user: 'Riley Park (fictional)', reason: 'Leaver in HR roster' };
  const a = await rt.call('helios_request_revoke', req);
  printStep('Auto: revoke a leaver\'s seat — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Dana Reviewer (fictional)');
  process.stdout.write(`    (demo: "Dana Reviewer" approves ${a.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('helios_request_revoke', req));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
