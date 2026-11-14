import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['aegle_draft_chase'] });
  process.stdout.write(`Aegle of Certificates demo (fictional inventory and vendors) in ${rt.root} — Auto on for aegle_draft_chase only\n`);
  const f = { certificates: 'certificates.csv', cois: 'cois.csv', requirements: 'requirements.csv', as_of: '2026-11-14' };
  const r = await rt.call('aegle_scan', f);
  printStep('Scan certificates, domains, licences and vendor COIs', r);
  for (const i of r.result.items) process.stdout.write(`    ${i.status.padEnd(9)} ${i.id.padEnd(6)} ${String(i.days_left).padStart(4)}d  ${i.name.padEnd(26)} ${i.next_step}\n`);
  for (const v of r.result.vendors) process.stdout.write(`    COI ${v.vendor}: ${v.gaps.length ? v.gaps.map((g) => g.issue).join(', ') : 'ok'}\n`);
  printStep('Write the report, CSV and calendar file', await rt.call('aegle_write_report', f));
  const d = await rt.call('aegle_draft_chase', f);
  printStep('Auto: draft chase emails (opted in; nothing is sent)', d);
  const ren = { id: 'DOM-1', cost: 24.99, reason: 'example.com expires 2026-12-05 and auto-renew is off' };
  const a = await rt.call('aegle_request_renewal', ren);
  printStep('Auto: paid domain renewal — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Sam Ops Lead (fictional)');
  process.stdout.write(`    (demo: "Sam Ops Lead" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not paid)', await rt.call('aegle_request_renewal', ren));
  printStep('Auto: install a new certificate on api.example.com — stays one-click', await rt.call('aegle_request_production_change', { id: 'TLS-2', change: 'Install a 2048-bit SHA-256 certificate on api.example.com' }));
  printStep('Agent tries to pay the registrar itself', await rt.call('purchase_renewal', {}));
  printStep('Agent tries to send the chase email itself', await rt.call('send_email', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
