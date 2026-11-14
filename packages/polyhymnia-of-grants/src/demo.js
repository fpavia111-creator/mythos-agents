import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['polyhymnia_build_packet'] });
  process.stdout.write(`Polyhymnia of Grants demo (fictional programs and funders) in ${rt.root} — Auto on for polyhymnia_build_packet only\n`);
  const f = { grants: 'grants.csv', budget: 'budget.csv', outcomes: 'outcomes.csv', as_of: '2026-11-14' };
  const d = await rt.call('polyhymnia_deadlines', f);
  printStep('Report deadlines', d);
  for (const g of d.result.items) process.stdout.write(`    ${g.status.padEnd(10)} ${g.grant_id}  due ${g.report_due}  ${g.funder} — ${g.program}\n`);
  const r = await rt.call('polyhymnia_review', f);
  printStep('Review budgets, outcomes and evidence', r);
  for (const g of r.result.items.filter((x) => x.open_items)) { process.stdout.write(`    ${g.grant_id}:\n`); for (const x of g.gaps) process.stdout.write(`      - ${x}\n`); }
  printStep('Auto: build draft packets (opted in; nothing is submitted)', await rt.call('polyhymnia_build_packet', f));
  const sub = { grant_id: 'G1', packet: 'mythos-out/polyhymnia/packets/G1/report-draft.md' };
  const a = await rt.call('polyhymnia_request_submission', sub);
  printStep('Auto: submit the G1 report — a binding send, stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Morgan Program Director (fictional)');
  process.stdout.write(`    (demo: "Morgan Program Director" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not submitted)', await rt.call('polyhymnia_request_submission', sub));
  printStep('Agent tries to submit in the funder portal itself', await rt.call('funder_portal_submit', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
