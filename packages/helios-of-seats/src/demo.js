import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

const w = (s) => process.stdout.write(s + '\n');

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['helios_request_downgrade'] });
  w(`Helios of Seats demo (fictional seats) in ${rt.root} — Auto on for helios_request_downgrade only`);
  const args = { seats: 'seats.csv', roster: 'hr-roster.csv', as_of: '2026-11-14' };
  const r = await rt.call('helios_find_waste', args);
  printStep('Find unused and over-tiered seats', r);
  for (const i of r.result.items.filter((x) => x.suggested_action !== 'keep')) w(`    ${i.suggested_action.padEnd(20)} ${i.app.padEnd(14)} ${i.user.padEnd(24)} $${i.est_monthly_saving}  ${i.flags.join(', ')}`);

  const withTerms = { ...args, policy: 'helios-policy.json' };
  const t = await rt.call('helios_find_waste', withTerms);
  printStep('Same review with contract terms (renewal dates, notice, minimums)', t);
  for (const a of t.result.actions) w(`    act by ${a.act_by.padEnd(36)} ${a.app.padEnd(11)} ${a.seats} -> ${a.recommended_seats} seats  ~$${a.est_saving_next_12m} next 12 months`);
  const cmp = await rt.call('helios_compare_reviews', { ...args, previous: 'seats-previous.csv', previous_as_of: '2026-10-14' });
  printStep('Compare with last month\'s export', cmp);
  printStep('Write the seat review sheet', await rt.call('helios_write_review', withTerms));
  printStep('Write the renewal calendar (.ics)', await rt.call('helios_renewal_calendar', withTerms));
  const d = await rt.call('helios_draft_confirmations', withTerms);
  printStep('Draft owner confirmations (not sent)', d);
  for (const x of d.result.drafts) w(`    draft to ${x.to.padEnd(26)} ${x.seats} seat(s)${x.cc.length ? `  cc ${x.cc.join(', ')}` : ''}`);
  printStep('Auto: request a downgrade (opted in)', await rt.call('helios_request_downgrade', { app: 'Figma', user: 'Sam Rivera (fictional)', to_tier: 'Starter', reason: 'No premium features used' }));
  const req = { app: 'Salesforce', user: 'Riley Park (fictional)', reason: 'Leaver in HR roster' };
  const a = await rt.call('helios_request_revoke', req);
  printStep('Auto: revoke a leaver\'s seat — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Dana Reviewer (fictional)');
  w(`    (demo: "Dana Reviewer" approves ${a.approval_id})`);
  printStep('Same request after the human click', await rt.call('helios_request_revoke', req));
  w(`\nAudit log: ${rt.stateDir}/audit.jsonl`);
}
