import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['arethusa_draft_changes'] });
  process.stdout.write(`Arethusa of Flows demo (fictional n8n, Zapier, Make, Power Automate and Workato exports) in ${rt.root} — Auto on for arethusa_draft_changes only\n`);
  const f = { exports: ['n8n-orders.json', 'n8n-cleanup.json', 'zapier-export.json', 'make-blueprint.json', 'power-automate-flow.json', 'workato-recipes.json'], history: 'run-history.csv', as_of: '2026-11-14T12:00:00Z', policy: 'arethusa-policy.json' };
  const r = await rt.call('arethusa_audit', f);
  printStep('Audit the exported flows and run history', r);
  for (const i of r.result.items) {
    process.stdout.write(`    ${i.name} (${i.platform}, ${i.active ? 'active' : 'off'}) risk ${i.risk_score}\n`);
    for (const x of i.findings.filter((y) => y.severity !== 'low')) process.stdout.write(`      ${x.severity.padEnd(6)} ${x.code.padEnd(26)} ${x.step}\n`);
  }
  for (const x of r.result.suppressed) process.stdout.write(`    suppressed by policy: ${x.flow} ${x.code} — ${x.reason}\n`);
  const m = await rt.call('arethusa_dependency_map', { exports: f.exports, policy: f.policy });
  printStep('Dependency map: shared credentials and secrets, flow-to-flow calls', m);
  for (const x of m.result.resources.filter((y) => y.shared)) process.stdout.write(`    shared ${x.type.padEnd(10)} ${x.key}: ${x.flows.join(', ')}\n`);
  for (const x of m.result.calls) process.stdout.write(`    call   ${x.from} -> ${x.to} (${x.via})\n`);
  for (const x of m.result.rotation_plan.slice(0, 3)) process.stdout.write(`    rotate ${x.priority} ${x.secret}: ${x.reasons[0]}\n`);
  printStep('Write the report, findings sheet and SARIF', await rt.call('arethusa_write_report', f));
  copyFileSync(join(rt.root, 'mythos-out/arethusa/findings.csv'), join(rt.root, 'baseline-findings.csv'));
  process.stdout.write('    (demo: the owner moves the ERP token in "Order sync" into a stored credential and re-exports)\n');
  const orders = join(rt.root, 'n8n-orders.json');
  writeFileSync(orders, readFileSync(orders, 'utf8').replace(/"Bearer FAKE[^"]*"/, '"={{$credentials.erpToken}}"'));
  const again = await rt.call('arethusa_audit', { ...f, baseline: 'baseline-findings.csv' });
  printStep('Re-audit against last review (baseline)', again);
  for (const x of again.result.baseline.resolved_findings) process.stdout.write(`    resolved ${x.flow}: ${x.code} (${x.step})\n`);
  printStep('Auto: write proposals and redacted copies (opted in; nothing applied)', await rt.call('arethusa_draft_changes', f));
  const ch = { flow: 'Order sync', change: 'disable', detail: 'Pause until the ERP 502s are fixed and the webhook has auth' };
  const a = await rt.call('arethusa_request_flow_change', ch);
  printStep('Auto: disable the production "Order sync" flow — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Ari Automation Owner (fictional)');
  process.stdout.write(`    (demo: "Ari Automation Owner" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not applied)', await rt.call('arethusa_request_flow_change', ch));
  printStep('Agent tries to edit the flow on the platform itself', await rt.call('automation_update_flow', {}));
  printStep('Agent tries to run the refund flow', await rt.call('automation_run_flow', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
