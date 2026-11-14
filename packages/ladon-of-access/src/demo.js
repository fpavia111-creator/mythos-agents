import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto' });
  process.stdout.write(`Ladon of Access demo (fictional people and agents) in ${rt.root} — Auto mode on\n`);
  const args = { access: 'access-export.csv', roster: 'hr-roster.csv', as_of: '2026-11-14' };
  const rev = await rt.call('ladon_review_access', args);
  printStep('Review access against the HR roster', rev);
  for (const i of rev.result.items.filter((x) => x.risk !== 'none').slice(0, 6)) process.stdout.write(`    ${i.risk.padEnd(6)} ${i.system.padEnd(10)} ${(i.user || i.email).padEnd(22)} ${i.flags.join(', ')}\n`);
  const sheet = await rt.call('ladon_recert_sheet', args);
  printStep('Write the recertification sheet', sheet);
  for (const f of sheet.result.files) process.stdout.write(`    ${f}\n`);
  const req = { system: 'NetSuite', user: 'Riley Park (fictional)', reason: 'Terminated in HR roster on 2026-10-31' };
  const first = await rt.call('ladon_request_revocation', req);
  printStep('Agent (in Auto) asks to revoke a leaver — stays one-click', first);
  rt.approvals.approve(first.approval_id, 'Dana Reviewer (fictional)');
  process.stdout.write(`    (demo: "Dana Reviewer" approves ${first.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('ladon_request_revocation', req));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
