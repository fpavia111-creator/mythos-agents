import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['eos_draft_access_requests', 'eos_draft_offboarding'] });
  process.stdout.write(`Eos of Onboarding demo (fictional people and checklist) in ${rt.root} — Auto on for eos_draft_access_requests and eos_draft_offboarding only\nNot HR or legal advice. Eos never grants or removes access.\n`);
  const f = { people: 'people.csv', template: 'template.json', status: 'status.csv', as_of: '2026-11-14' };
  const r = await rt.call('eos_status', f);
  printStep('Check onboarding status as of 2026-11-14', r);
  for (const p of r.result.items) process.stdout.write(`    ${p.person_id.padEnd(3)} ${p.name.padEnd(14)} ${p.type.padEnd(11)} ${String(p.percent_done).padStart(3)}%  overdue ${p.overdue}  next ${p.next.join(', ') || '—'}${p.flags.length ? `  FLAGS ${p.flags.join(', ')}` : ''}\n`);
  printStep('Write the tracker, owner actions and calendar', await rt.call('eos_write_tracker', f));
  const rr = await rt.call('eos_status', { ...f, template: 'template-roles.json' });
  printStep('Per-role templates (template-roles.json)', rr);
  for (const p of rr.result.items) process.stdout.write(`    ${p.person_id.padEnd(3)} ${p.role.padEnd(20)} template ${String(p.role_template || '— (base checklist)').padEnd(20)} ${p.flags.filter((x) => /role/.test(x)).join(', ')}\n`);
  const rd = await rt.call('eos_readiness_report', f);
  printStep('Day-one readiness (hash recorded in the audit log)', rd);
  const oa = await rt.call('eos_owner_actions', f);
  printStep('Prioritised actions per owner', oa);
  for (const x of oa.result.items.slice(0, 6)) process.stdout.write(`    ${String(x.priority).padStart(3)} ${x.owner.padEnd(8)} ${x.person_id}/${x.task_id.padEnd(14)} ${x.reason}\n`);
  const off = await rt.call('eos_offboarding', f);
  printStep('Offboarding mirror checklist from the end date', off);
  for (const p of off.result.items) for (const t of p.tasks) process.stdout.write(`    ${p.person_id} ${t.task_id.padEnd(14)} ${t.state.padEnd(8)} due ${t.due}\n`);
  printStep('Auto: draft offboarding removals (opted in; nothing submitted)', await rt.call('eos_draft_offboarding', f));
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
