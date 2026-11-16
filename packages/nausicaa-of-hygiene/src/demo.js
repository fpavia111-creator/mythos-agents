import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['nausicaa_write_clean_copy', 'nausicaa_check_mx'] });
  process.stdout.write(`Nausicaa of Hygiene demo (fictional contacts) in ${rt.root} — Auto on for nausicaa_write_clean_copy and the offline MX check only\n`);
  const f = { contacts: 'contacts.csv', suppression: 'suppression.csv', as_of: '2026-11-14' };
  const r = await rt.call('nausicaa_audit', f);
  printStep('Audit the contact list', r);
  for (const i of r.result.items.filter((x) => x.suggested_action !== 'keep')) process.stdout.write(`    ${i.suggested_action.padEnd(16)} ${i.id.padEnd(6)} ${i.email.padEnd(30)} ${i.flags.join(', ')}\n`);
  for (const d of r.result.health.deductions) process.stdout.write(`    health −${String(d.points).padEnd(4)} ${d.explain}\n`);
  const p = await rt.call('nausicaa_consent_provenance', { contacts: 'contacts.csv', as_of: '2026-11-14', rules: 'hygiene-rules.json' });
  printStep('Consent provenance (source and date on file?)', p);
  for (const i of p.result.items) process.stdout.write(`    ${i.id.padEnd(4)} ${i.flags.join(', ')}\n`);
  const m = await rt.call('nausicaa_merge_plan', f);
  printStep('Merge plan for duplicates (field-level rules)', m);
  for (const g of m.result.plan) { process.stdout.write(`    keep ${g.survivor_id}, merge ${g.merge_ids.join(', ')} — ${g.survivor_rule}\n`); for (const x of g.fields) process.stdout.write(`      ${x.field.padEnd(15)} ${String(x.value).padEnd(24)} from ${x.from_id}: ${x.rule.split(' ').slice(0, 1)}\n`); }
  const c = await rt.call('nausicaa_compare', { ...f, previous: 'contacts-previous.csv', previous_as_of: '2026-10-14' });
  printStep('Compare with last month\'s export', c);
  for (const x of c.result.newly_flagged_contacts) process.stdout.write(`    ${x.id.padEnd(4)} new: ${x.new_flags.join(', ')}\n`);
  printStep('Auto: offline MX check from saved records (opted in; no network)', await rt.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv', records: 'mx-records.json' }));
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
