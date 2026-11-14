import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep, AgentRuntime } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  process.stdout.write(`Augeas of Masters demo (fictional vendors and items) in ${rt.root}\n`);
  const v = await rt.call('augeas_find_duplicates', { path: 'vendors.csv', kind: 'vendor' });
  printStep('Find duplicate vendors', v);
  for (const c of v.result.proposals) process.stdout.write(`    ${c.cluster} (${c.confidence}) keep ${c.survivor}, merge ${c.merge.join(', ')} — ${c.reasons.join('; ')}\n`);
  printStep('Find duplicate items', await rt.call('augeas_find_duplicates', { path: 'items.csv', kind: 'item' }));
  printStep('Write merge proposals for review', await rt.call('augeas_propose_merges', { path: 'vendors.csv', kind: 'vendor' }));
  const c = v.result.proposals[0];
  const args = { path: 'vendors.csv', kind: 'vendor', survivor: c.survivor, merge: c.merge };
  const ask = await rt.call('augeas_apply_merge', args);
  printStep('Assist mode: apply one merge', ask);
  rt.approvals.approve(ask.approval_id, 'Dana Reviewer (fictional)');
  process.stdout.write(`    (demo: "Dana Reviewer" approves ${ask.approval_id})\n`);
  printStep('Same merge after approval', await rt.call('augeas_apply_merge', args));
  const auto = new AgentRuntime(manifest, { root: rt.root, mode: 'auto', autoActions: ['augeas_apply_merge'], caps: { maxSteps: 5 } });
  const c2 = v.result.proposals[1];
  printStep('Auto mode (buyer opted in augeas_apply_merge): next merge runs without asking, still logged', await auto.call('augeas_apply_merge', { path: 'vendors.csv', kind: 'vendor', survivor: c2.survivor, merge: c2.merge }));
  printStep('Auto mode: agent tries to pay a vendor', await auto.call('augeas_pay_vendor', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
