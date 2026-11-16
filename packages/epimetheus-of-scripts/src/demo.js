import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  const out = (s) => process.stdout.write(s);
  out(`Epimetheus of Scripts demo (sample scripts) in ${rt.root}\n`);
  const inv = await rt.call('epimetheus_inventory', { dir: 'FileCabinet' });
  printStep('Inventory, risk-rank and estimate the FileCabinet folder', inv);
  for (const i of inv.result.items) out(`    ${i.risk.padEnd(6)} ${String(i.score).padStart(3)}  ${i.version.padEnd(7)} ${String(i.effort.hours).padStart(5)} h  ${i.file}\n`);
  const ex = await rt.call('epimetheus_explain_file', { file: 'FileCabinet/' + inv.result.items[0].file });
  printStep('Explain the riskiest file', ex);
  for (const s of ex.result.effort.signals) out(`    ${s.label}: ${s.hours} h\n`);
  printStep('Calls in comments and strings are ignored (ue_order.js mentions nlapi and N/record only in text)', await rt.call('epimetheus_explain_file', { file: 'deps/SuiteScripts/ue_order.js' }));
  const g = await rt.call('epimetheus_dependency_graph', { dir: 'deps' });
  printStep('Dependency graph and conversion order', g);
  for (const o of g.result.order) out(`    ${o.n}. ${o.file} (${o.version})${o.in_cycle ? '  ← cycle' : ''}\n`);
  for (const u of g.result.unresolved) out(`    unresolved: ${u.module} in ${u.file}\n`);
  printStep('Progress since a baseline inventory.csv', await rt.call('epimetheus_progress', { baseline: 'baseline/inventory.csv', dir: 'FileCabinet' }));
  const plan = await rt.call('epimetheus_write_plan', { dir: 'FileCabinet' });
  printStep('Write inventory.csv and a draft test plan', plan);
  for (const f of plan.result.files) out(`    ${f}\n`);
  const sarif = await rt.call('epimetheus_write_sarif', { dir: 'FileCabinet' });
  printStep('Write SARIF for code scanning', sarif);
  for (const f of sarif.result.files) out(`    ${f}\n`);
  printStep('Agent tries to deploy a converted script', await rt.call('epimetheus_deploy_conversion', {}));
  out(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
