import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto' });
  process.stdout.write(`Tiresias of Drift demo (fictional app config and schema) in ${rt.root} — Auto mode on\n`);
  const t = await rt.call('tiresias_timeline', { dir: 'snapshots', ignore: ['meta.generated_at'] });
  printStep('Walk three config snapshots', t);
  for (const c of t.result.net_drift.items) process.stdout.write(`    ${c.risk.padEnd(6)} ${c.key.padEnd(28)} ${c.change.padEnd(8)} ${c.why}\n`);
  const s = await rt.call('tiresias_diff', { before: 'schema-2026-10-01.csv', after: 'schema-2026-11-01.csv' });
  printStep('Compare two schema snapshots', s);
  for (const c of s.result.items) process.stdout.write(`    ${c.risk.padEnd(6)} ${c.key.padEnd(28)} ${c.why}\n`);
  const args = { before: 'snapshots/2026-10-01.json', after: 'snapshots/2026-11-01.json', ignore: ['meta.generated_at'] };
  printStep('Write the report and a revert plan', await rt.call('tiresias_write_report', args));
  const fix = { environment: 'production', keys: ['security.tls.verify', 'server.debug'], reason: 'Revert unapproved changes found in drift review', ...args };
  const a = await rt.call('tiresias_apply_fix', fix);
  printStep('Auto: apply a fix to production — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Dana Reviewer (fictional)');
  process.stdout.write(`    (demo: "Dana Reviewer" approves ${a.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('tiresias_apply_fix', fix));
  printStep('Agent tries to push config itself', await rt.call('production_push_config', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
