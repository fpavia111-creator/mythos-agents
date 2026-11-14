import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['eos_draft_access_requests'] });
  process.stdout.write(`Eos of Onboarding demo (fictional people and checklist) in ${rt.root} — Auto on for eos_draft_access_requests only\nNot HR or legal advice. Eos never grants or removes access.\n`);
  const f = { people: 'people.csv', template: 'template.json', status: 'status.csv', as_of: '2026-11-14' };
  const r = await rt.call('eos_status', f);
  printStep('Check onboarding status as of 2026-11-14', r);
  for (const p of r.result.items) process.stdout.write(`    ${p.person_id.padEnd(3)} ${p.name.padEnd(14)} ${p.type.padEnd(11)} ${String(p.percent_done).padStart(3)}%  overdue ${p.overdue}  next ${p.next.join(', ') || '—'}${p.flags.length ? `  FLAGS ${p.flags.join(', ')}` : ''}\n`);
  printStep('Write the tracker', await rt.call('eos_write_tracker', f));
  printStep('Auto: draft access requests where prerequisites are done (opted in; nothing submitted)', await rt.call('eos_draft_access_requests', f));
  const g = { ...f, person_id: 'C1', task_id: 'email' };
  const a = await rt.call('eos_request_access_grant', g);
  printStep('Auto: grant Jordan Lee an email account — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Sam Ortiz (fictional)');
  process.stdout.write(`    (demo: "Sam Ortiz" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded; access not changed)', await rt.call('eos_request_access_grant', g));
  const w = { ...f, person_id: 'C1', task_id: 'repo' };
  const b = await rt.call('eos_request_access_grant', w); rt.approvals.approve(b.approval_id, 'Sam Ortiz (fictional)');
  printStep('Repository access before the SOW is signed (approved, still refused)', await rt.call('eos_request_access_grant', w));
  printStep('Auto: remove Quinn Hale\'s repository access after the engagement ended — stays one-click', await rt.call('eos_request_access_removal', { ...f, person_id: 'C3', task_id: 'repo', reason: 'Engagement ended 2026-10-31' }));
  printStep('Agent tries to grant access in the identity provider itself', await rt.call('idp_grant_access', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
