import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep, AgentRuntime } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  process.stdout.write(`Augeas of Masters demo (fictional vendors and items) in ${rt.root}\n`);
  const v = await rt.call('augeas_find_duplicates', { path: 'vendors.csv', kind: 'vendor', rules: 'augeas-rules.json' });
  printStep('Find duplicate vendors', v);
  for (const c of v.result.proposals) process.stdout.write(`    ${c.cluster} (${c.confidence}) keep ${c.survivor}, merge ${c.merge.join(', ')} — ${c.reasons.join('; ')}\n`);
  for (const p of v.result.weak_pairs) process.stdout.write(`    not merged: ${p.a} / ${p.b} (${p.score}) — ${p.reasons.join('; ')}\n`);
  printStep('Find duplicate items', await rt.call('augeas_find_duplicates', { path: 'items.csv', kind: 'item' }));
  const prop = await rt.call('augeas_propose_merges', { path: 'vendors.csv', kind: 'vendor' });
  printStep('Write merge proposals for review (CSV, JSON, HTML page)', prop);
  for (const f of prop.result.files) process.stdout.write(`    ${f}\n`);
  const c = v.result.proposals[1];
  const pv = await rt.call('augeas_merge_preview', { path: 'vendors.csv', survivor: c.survivor, merge: c.merge, rules: 'augeas-rules.json' });
  printStep(`Preview merge ${c.cluster} field by field`, pv);
  for (const f of pv.result.fields) process.stdout.write(`    ${f.field.padEnd(12)} ${f.changed ? 'CHANGE' : 'keep  '} ${JSON.stringify(f.winner)} from ${f.winner_from} (${f.rule}${f.conflict ? ', conflict' : ''})\n`);
  const args = { path: 'vendors.csv', kind: 'vendor', survivor: c.survivor, merge: c.merge, fill_survivor: true, rules: 'augeas-rules.json' };
  const ask = await rt.call('augeas_apply_merge', args);
  printStep('Assist mode: apply the previewed merge', ask);
  rt.approvals.approve(ask.approval_id, 'Dana Reviewer (fictional)');
  process.stdout.write(`    (demo: "Dana Reviewer" approves ${ask.approval_id})\n`);
  printStep('Same merge after approval (copy + undo log)', await rt.call('augeas_apply_merge', args));
  const auto = new AgentRuntime(manifest, { root: rt.root, mode: 'auto', autoActions: ['augeas_apply_merge', 'augeas_undo_merge'], caps: { maxSteps: 5 } });
  const c1 = v.result.proposals[0];
  printStep('Auto mode (buyer opted in augeas_apply_merge): next merge runs without asking, still logged', await auto.call('augeas_apply_merge', { path: 'vendors.csv', kind: 'vendor', survivor: c1.survivor, merge: c1.merge }));
  printStep('Auto mode: undo that merge (copy restored byte-for-byte, hash checked)', await auto.call('augeas_undo_merge', { copy: 'mythos-out/augeas/vendors.merged.csv' }));
  printStep('Auto mode: agent tries to pay a vendor', await auto.call('augeas_pay_vendor', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
