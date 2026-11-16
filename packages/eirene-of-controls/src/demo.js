import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  const out = (s) => process.stdout.write(s);
  out(`Eirene of Controls demo (sample logs) in ${rt.root}\n`);
  const logs = ['talos-audit.jsonl', 'olympus-audit.jsonl'];
  printStep('Summarize a Talos log and an Olympus log', await rt.call('eirene_summarize_logs', { logs }));
  printStep('Verify the Talos hash chain', await rt.call('eirene_verify_chain', { log: 'talos-audit.jsonl' }));
  printStep('Verify a log someone edited by hand', await rt.call('eirene_verify_chain', { log: 'tampered-audit.jsonl' }));
  printStep('Verify a signed log with its public key (includes a signed key rotation)', await rt.call('eirene_verify_chain', { log: 'signed-audit.jsonl', public_keys: ['keys/audit-public.pem'] }));
  printStep('A signed log that was edited and re-chained: the chain alone looks fine…', await rt.call('eirene_verify_chain', { log: 'signed-rechained-audit.jsonl' }));
  printStep('…but the signatures do not verify', await rt.call('eirene_verify_chain', { log: 'signed-rechained-audit.jsonl', public_keys: ['keys/audit-public.pem'] }));
  printStep('List starter control templates', await rt.call('eirene_list_templates', {}));
  const map = await rt.call('eirene_map_controls', { logs, template: 'itgc-starter', evidence_dir: 'evidence/2026-Q4', as_of: '2026-11-15' });
  printStep('Map logs and evidence files to controls (gaps and stale evidence)', map);
  for (const c of map.result.controls) out(`    ${c.id.padEnd(11)} ${c.state.padEnd(22)} ${c.reason}\n`);
  const diff = await rt.call('eirene_diff_evidence', { previous: 'evidence/2026-Q3', current: 'evidence/2026-Q4' });
  printStep('Diff evidence folders: Q3 vs Q4', diff);
  for (const k of ['added', 'removed', 'changed']) for (const f of diff.result[k]) out(`    ${k.padEnd(8)} ${f.path}  ${f.sha256.slice(0, 12)}\n`);
  const ev = await rt.call('eirene_build_evidence', { logs: ['talos-audit.jsonl', 'signed-audit.jsonl'], public_keys: ['keys/audit-public.pem'], template: 'itgc-starter', evidence_dir: 'evidence/2026-Q4', previous_evidence_dir: 'evidence/2026-Q3', alethea_dir: '.decisions', as_of: '2026-11-15', title: 'Agent controls evidence — sample' });
  printStep('Build the evidence folder', ev);
  for (const f of ev.result.files) out(`    ${f}\n`);
  out(`    output_sha256 ${ev.result.output_sha256} (manifest hash, recorded in the audit log)\n`);
  printStep('Agent tries to email the folder to the auditor', await rt.call('eirene_send_to_auditor', {}));
  out(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
