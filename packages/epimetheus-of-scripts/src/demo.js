import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  process.stdout.write(`Epimetheus of Scripts demo (sample scripts) in ${rt.root}\n`);
  const inv = await rt.call('epimetheus_inventory', { dir: 'FileCabinet' });
  printStep('Inventory and risk-rank the FileCabinet folder', inv);
  for (const i of inv.result.items) process.stdout.write(`    ${i.risk.padEnd(6)} ${String(i.score).padStart(3)}  ${i.version.padEnd(7)} ${i.file}\n`);
  printStep('Explain the riskiest file', await rt.call('epimetheus_explain_file', { file: 'FileCabinet/' + inv.result.items[0].file }));
  const plan = await rt.call('epimetheus_write_plan', { dir: 'FileCabinet' });
  printStep('Write inventory.csv and a draft test plan', plan);
  for (const f of plan.result.files) process.stdout.write(`    ${f}\n`);
  printStep('Agent tries to deploy a converted script', await rt.call('epimetheus_deploy_conversion', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
