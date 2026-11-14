import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['nausicaa_write_clean_copy'] });
  process.stdout.write(`Nausicaa of Hygiene demo (fictional contacts) in ${rt.root} — Auto on for nausicaa_write_clean_copy only\n`);
  const f = { contacts: 'contacts.csv', suppression: 'suppression.csv', as_of: '2026-11-14' };
  const r = await rt.call('nausicaa_audit', f);
  printStep('Audit the contact list', r);
  for (const i of r.result.items.filter((x) => x.suggested_action !== 'keep')) process.stdout.write(`    ${i.suggested_action.padEnd(16)} ${i.id.padEnd(6)} ${i.email.padEnd(30)} ${i.flags.join(', ')}\n`);
  printStep('Write the review sheet', await rt.call('nausicaa_write_cleanup', f));
  printStep('Auto: write a do-not-email copy (opted in)', await rt.call('nausicaa_write_clean_copy', f));
  const ids = r.result.items.filter((i) => i.suggested_action === 'delete_candidate').map((i) => i.id);
  const del = { ids, reason: 'Hard-bounced and inactive for over a year' };
  const a = await rt.call('nausicaa_request_bulk_delete', del);
  printStep(`Auto: bulk delete ${ids.length} contact(s) — stays one-click`, a);
  rt.approvals.approve(a.approval_id, 'Dana Marketing Ops (fictional)');
  process.stdout.write(`    (demo: "Dana Marketing Ops" approves ${a.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('nausicaa_request_bulk_delete', del));
  printStep('Agent tries to delete in the CRM itself', await rt.call('crm_delete_contacts', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
