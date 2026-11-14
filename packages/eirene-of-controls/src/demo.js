import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  process.stdout.write(`Eirene of Controls demo (sample logs) in ${rt.root}\n`);
  const logs = ['talos-audit.jsonl', 'olympus-audit.jsonl'];
  printStep('Summarize a Talos log and an Olympus log', await rt.call('eirene_summarize_logs', { logs }));
  printStep('Verify the Talos hash chain', await rt.call('eirene_verify_chain', { log: 'talos-audit.jsonl' }));
  printStep('Verify a log someone edited by hand', await rt.call('eirene_verify_chain', { log: 'tampered-audit.jsonl' }));
  const ev = await rt.call('eirene_build_evidence', { logs, controls: 'controls.json', alethea_dir: '.decisions', title: 'Agent controls evidence — sample' });
  printStep('Build the evidence folder', ev);
  for (const f of ev.result.files) process.stdout.write(`    ${f}\n`);
  printStep('Agent tries to email the folder to the auditor', await rt.call('eirene_send_to_auditor', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
