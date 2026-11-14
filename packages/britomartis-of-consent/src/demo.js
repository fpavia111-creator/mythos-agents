import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['britomartis_draft_policy_table'] });
  process.stdout.write(`Britomartis of Consent demo (fictional bakery site and captures) in ${rt.root} — Auto on for britomartis_draft_policy_table only\nA technical inventory, not legal advice. No network calls.\n`);
  const f = { site: 'site', base_url: 'https://www.example.com', har_first_visit: 'har/first-visit.har', har_after_reject: 'har/after-reject.har', declared: 'declared.json' };
  const r = await rt.call('britomartis_inventory', f);
  printStep('Inventory cookies and third parties; compare with the stated policy', r);
  for (const c of r.result.cookies) process.stdout.write(`    cookie ${c.name.padEnd(20)} ${c.party.padEnd(6)} ${String(c.purpose || '?').padEnd(10)} ${c.declared ? 'declared' : 'NOT declared'}  seen: ${c.seen_in.join(', ')}\n`);
  for (const x of r.result.findings.filter((y) => y.severity === 'error')) process.stdout.write(`    error  ${x.check.padEnd(28)} ${x.subject}\n`);
  printStep('Write the report', await rt.call('britomartis_write_report', f));
  const d = await rt.call('britomartis_draft_policy_table', f);
  printStep('Auto: draft a cookie table (site and policy untouched)', d);
  const req = { proposal: d.result.proposal, proposal_sha256: d.result.proposal_sha256 };
  const a = await rt.call('britomartis_request_publish', req);
  printStep('Auto: publish the table — stays one-click (production deploy)', a);
  rt.approvals.approve(a.approval_id, 'Ana Site Owner (fictional)');
  process.stdout.write(`    (demo: "Ana Site Owner" approves ${a.approval_id})\n`);
  printStep('Same request after the click: refused while [TO CONFIRM] rows remain', await rt.call('britomartis_request_publish', req));
  // Ana reviews declared.proposed.json, fills in every [TO CONFIRM], drops csrftoken (no longer used) and saves it as her policy.
  const prop = JSON.parse(readFileSync(join(rt.root, 'mythos-out/britomartis/declared.proposed.json'), 'utf8'));
  const fill = { promo_seen: ['This site', 'preferences', '30 days'], YSC: ['YouTube', 'marketing', 'session'], VISITOR_INFO1_LIVE: ['YouTube', 'marketing', '6 months'] };
  const reviewed = { source: 'Fernhill Bakery cookie policy, updated 2026-11-14 (fictional)', cookies: prop.cookies.filter((c) => c.name !== 'csrftoken').map((c) => (fill[c.name] ? { name: c.name, provider: fill[c.name][0], purpose: fill[c.name][1], duration: fill[c.name][2] } : c)), third_parties: prop.third_parties.map((t) => (/\[TO CONFIRM/.test(t.purpose) ? { ...t, purpose: t.host.includes('youtube') || t.host.includes('facebook') ? 'marketing' : 'other' } : t)) };
  writeFileSync(join(rt.root, 'declared.reviewed.json'), JSON.stringify(reviewed, null, 2) + '\n');
  process.stdout.write('\n    (demo: Ana fills in every [TO CONFIRM] in declared.proposed.json, removes csrftoken and saves it as declared.reviewed.json)\n');
  const d2 = await rt.call('britomartis_draft_policy_table', { ...f, declared: 'declared.reviewed.json', out_dir: 'mythos-out/reviewed' });
  printStep('Auto: draft the table again from the reviewed policy', d2);
  const req2 = { proposal: d2.result.proposal, proposal_sha256: d2.result.proposal_sha256 };
  rt.approvals.approve((await rt.call('britomartis_request_publish', req2)).approval_id, 'Ana Site Owner (fictional)');
  printStep('Publish request after her click (recorded, not deployed)', await rt.call('britomartis_request_publish', req2));
  process.stdout.write('    The script fixes (gating Google Analytics and YouTube behind consent, a real banner) are still on the list for a person.\n');
  printStep('Agent tries to change the live site itself', await rt.call('deploy_site', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
