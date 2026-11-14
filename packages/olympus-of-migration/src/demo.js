import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  process.stdout.write(`Olympus of Migration demo (fictional sample books) in ${rt.root}\n`);
  const cmp = await rt.call('olympus_compare_exports', { source: 'source-open-invoices.csv', target: 'netsuite-sandbox-open-invoices.csv', key: 'externalid', amount_column: 'amount' });
  printStep('Compare source vs NetSuite sandbox open invoices', cmp);
  for (const f of cmp.result.findings) process.stdout.write(`    - ${f.severity}: ${f.message}\n`);
  printStep('Tie out trial balances', await rt.call('olympus_tie_out_balances', { source: 'source-trial-balance.csv', target: 'netsuite-sandbox-trial-balance.csv' }));
  const rep = await rt.call('olympus_readiness_report', { source: 'source-open-invoices.csv', target: 'netsuite-sandbox-open-invoices.csv', key: 'externalid', amount_column: 'amount', source_tb: 'source-trial-balance.csv', target_tb: 'netsuite-sandbox-trial-balance.csv' });
  printStep('Write readiness report', rep);
  for (const f of rep.result.files) process.stdout.write(`    ${f}\n`);
  printStep('Agent asks Olympus to approve go-live', await rt.call('olympus_approve_go_live', {}));
  printStep('Agent tries a tool that is not on the allowlist (twitter_post)', await rt.call('twitter_post', { text: 'books are clean!' }));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
