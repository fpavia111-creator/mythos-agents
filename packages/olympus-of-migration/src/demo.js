import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  const out = (s) => process.stdout.write(s);
  out(`Olympus of Migration demo (fictional sample books) in ${rt.root}\n`);
  const cmp = await rt.call('olympus_compare_exports', { source: 'source-open-invoices.csv', target: 'netsuite-sandbox-open-invoices.csv', key: 'externalid', amount_column: 'amount' });
  printStep('Compare source vs NetSuite sandbox open invoices', cmp);
  for (const f of cmp.result.findings) out(`    - ${f.severity}: ${f.message}\n`);
  printStep('Tie out trial balances', await rt.call('olympus_tie_out_balances', { source: 'source-trial-balance.csv', target: 'netsuite-sandbox-trial-balance.csv' }));
  printStep('Tie out two subsidiaries (USD + EUR at a rate you supply), tolerance 0.01', await rt.call('olympus_tie_out_balances', { source: 'source-tb-multi.csv', target: 'netsuite-sandbox-tb-multi.csv', config: 'migration-rules.json' }));
  printStep('Same, with tolerance 1.00', await rt.call('olympus_tie_out_balances', { source: 'source-tb-multi.csv', target: 'netsuite-sandbox-tb-multi.csv', config: 'migration-rules.json', tolerance: 1 }));
  const fields = await rt.call('olympus_check_fields', { file: 'bad-invoices.csv', config: 'migration-rules.json' });
  printStep('Check field rules on a messy export', fields);
  for (const v of fields.result.violations.slice(0, 4)) out(`    - row ${v.row}: ${v.rule} ${v.problem}\n`);
  printStep('Compare trial load 1 with trial load 2', await rt.call('olympus_compare_runs', { previous: 'runs/trial-load-1-findings.json', current: 'runs/trial-load-2-findings.json' }));
  const rep = await rt.call('olympus_readiness_report', { source: 'source-open-invoices.csv', target: 'netsuite-sandbox-open-invoices.csv', key: 'externalid', amount_column: 'amount', source_tb: 'source-trial-balance.csv', target_tb: 'netsuite-sandbox-trial-balance.csv', previous_findings: 'runs/trial-load-1-findings.json' });
  printStep('Write readiness report (md, html, findings.json, exceptions.csv)', rep);
  for (const a of rep.result.actions) out(`    P${a.priority} ${a.action}\n`);
  for (const f of rep.result.files) out(`    ${f}\n`);
  out(`    output_sha256 ${rep.result.output_sha256} (recorded in the audit log; signed when you start with --signing-key)\n`);
  printStep('Agent asks Olympus to approve go-live', await rt.call('olympus_approve_go_live', {}));
  printStep('Agent tries a tool that is not on the allowlist (twitter_post)', await rt.call('twitter_post', { text: 'books are clean!' }));
  out(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
