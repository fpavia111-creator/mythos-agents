import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['arethusa_draft_changes'] });
  process.stdout.write(`Arethusa of Flows demo (fictional n8n, Zapier and Make exports) in ${rt.root} — Auto on for arethusa_draft_changes only\n`);
  const f = { exports: ['n8n-orders.json', 'n8n-cleanup.json', 'zapier-export.json', 'make-blueprint.json'], history: 'run-history.csv', as_of: '2026-11-14T12:00:00Z' };
  const r = await rt.call('arethusa_audit', f);
  printStep('Audit the exported flows and run history', r);
  for (const i of r.result.items) {
    process.stdout.write(`    ${i.name} (${i.platform}, ${i.active ? 'active' : 'off'}) risk ${i.risk_score}\n`);
    for (const x of i.findings.filter((y) => y.severity !== 'low')) process.stdout.write(`      ${x.severity.padEnd(6)} ${x.code.padEnd(26)} ${x.step}\n`);
  }
  printStep('Write the report and findings sheet', await rt.call('arethusa_write_report', f));
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
