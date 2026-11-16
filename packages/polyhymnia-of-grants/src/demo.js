import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['polyhymnia_build_packet', 'polyhymnia_evidence_pack'] });
  process.stdout.write(`Polyhymnia of Grants demo (fictional programs and funders) in ${rt.root} — Auto on for polyhymnia_build_packet and polyhymnia_evidence_pack only\n`);
  const f = { grants: 'grants.csv', budget: 'budget.csv', outcomes: 'outcomes.csv', as_of: '2026-11-14' };
  const d = await rt.call('polyhymnia_deadlines', f);
  printStep('Report deadlines', d);
  for (const g of d.result.items) process.stdout.write(`    ${g.status.padEnd(10)} ${g.grant_id}  due ${g.report_due}  ${g.funder} — ${g.program}\n`);
  const r = await rt.call('polyhymnia_review', f);
  printStep('Review budgets, outcomes and evidence', r);
  for (const g of r.result.items.filter((x) => x.open_items)) { process.stdout.write(`    ${g.grant_id}:\n`); for (const x of g.gaps) process.stdout.write(`      - ${x}\n`); }
  printStep('Write the deadline calendar (.ics with reminders)', await rt.call('polyhymnia_calendar', { grants: 'grants.csv', as_of: f.as_of }));
  const v = await rt.call('polyhymnia_variance', { grants: 'grants.csv', budget: 'budget.csv', as_of: f.as_of });
  printStep('Budget vs actual variance and spend-down', v);
  for (const g of v.result.grants) {
    for (const l of g.lines.filter((x) => x.explanation_required)) process.stdout.write(`    ${g.grant_id} ${l.line.padEnd(20)} ${l.marker}\n`);
    if (g.flags.length) process.stdout.write(`    ${g.grant_id} projected ${g.projected_at_end.toFixed(2)} by period end: ${g.flags.join(', ')}\n`);
  }
  const tc = await rt.call('polyhymnia_template_check', { ...f, template: 'templates/lakeside-interim.json', grant_id: 'G1' });
  printStep('Map the Lakeside interim template onto G1', tc);
  for (const x of tc.result.grants[0].sections) process.stdout.write(`    ${x.state.padEnd(17)} ${x.title}\n`);
  for (const x of tc.result.grants[0].gaps) process.stdout.write(`    gap: ${x.detail}\n`);
  printStep('Auto: build draft packets (opted in; nothing is submitted)', await rt.call('polyhymnia_build_packet', f));
  printStep('Auto: rebuild G1 following the funder template', await rt.call('polyhymnia_build_packet', { ...f, grant_id: 'G1', template: 'templates/lakeside-interim.json' }));
  printStep('Auto: evidence pack for G1 (zip with hash manifest; nothing is sent)', await rt.call('polyhymnia_evidence_pack', { ...f, grant_id: 'G1' }));
  const sub = { grant_id: 'G1', packet: 'mythos-out/polyhymnia/packets/G1/report-draft.md' };
  const a = await rt.call('polyhymnia_request_submission', sub);
  printStep('Auto: submit the G1 report — a binding send, stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Morgan Program Director (fictional)');
  process.stdout.write(`    (demo: "Morgan Program Director" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not submitted)', await rt.call('polyhymnia_request_submission', sub));
  printStep('Agent tries to submit in the funder portal itself', await rt.call('funder_portal_submit', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
