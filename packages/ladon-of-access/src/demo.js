import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto' });
  process.stdout.write(`Ladon of Access demo (fictional people and agents) in ${rt.root} — Auto mode on\n`);
  const args = { access: 'access-export.csv', roster: 'hr-roster.csv', policy: 'ladon-policy.json', as_of: '2026-11-14' };
  const rev = await rt.call('ladon_review_access', args);
  printStep('Review access against the HR roster and the review policy', rev);
  for (const i of rev.result.items.filter((x) => x.risk !== 'none').slice(0, 7)) process.stdout.write(`    ${i.risk.padEnd(6)} ${i.system.padEnd(16)} ${(i.user || i.email).padEnd(24)} ${i.flags.join(', ')}\n`);
  const diff = await rt.call('ladon_access_diff', { previous: 'access-export-2026q3.csv', current: 'access-export.csv' });
  printStep('What changed since last quarter', diff);
  for (const line of diff.result.review_first) process.stdout.write(`    ${line}\n`);
  const sheet = await rt.call('ladon_recert_sheet', args);
  printStep('Write the recertification sheet (reviewers, delegations, due dates)', sheet);
  for (const f of sheet.result.files) process.stdout.write(`    ${f}\n`);
  const st = await rt.call('ladon_campaign_status', { sheet: 'recertification-filled.csv', as_of: '2026-12-01' });
  printStep('Two weeks later: status of the filled sheet', st);
  for (const c of st.result.chase_list) process.stdout.write(`    chase ${c.reviewer}: ${c.overdue} overdue, ${c.open} open, ${c.needs_fix} to fix\n`);
  printStep('Write the evidence pack (hash goes into the audit line)', await rt.call('ladon_evidence_pack', { sheet: 'recertification-filled.csv', as_of: '2026-12-01', campaign: 'Q4 2026 access review (fictional)' }));
  const r = st.result.revocations_to_request[0];
  const req = { system: r.system, user: r.user, reason: `Reviewer decision: revoke (sheet line ${r.line})` };
  const first = await rt.call('ladon_request_revocation', req);
  printStep('Agent (in Auto) asks to revoke a leaver — stays one-click', first);
  rt.approvals.approve(first.approval_id, 'Dana Reviewer (fictional)');
  process.stdout.write(`    (demo: "Dana Reviewer" approves ${first.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('ladon_request_revocation', req));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
