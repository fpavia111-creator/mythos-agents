import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['macaria_log_request'] });
  process.stdout.write(`Macaria of Erasure demo (fictional people and exports) in ${rt.root} — Auto on for macaria_log_request only\n`);
  const m = await rt.call('macaria_map_data', { dir: 'exports' });
  printStep('Map where personal data lives', m);
  for (const f of m.result.files) process.stdout.write(`    ${f.file.padEnd(28)} ${f.personal_data_columns.map((p) => p.category).join(', ') || '-'}${f.retention_flag ? '  [retention check]' : ''}\n`);
  const subject = { dir: 'exports', email: 'Jamie.Doe@example.com', phone: '(512) 555-0142', ids: ['C-101'], received: '2026-11-10', regime: 'gdpr' };
  const f = await rt.call('macaria_find_subject', subject);
  printStep('Find the data subject', f);
  for (const x of f.result.files.filter((y) => y.rows_found)) process.stdout.write(`    ${x.file.padEnd(28)} ${x.rows_found} row(s): ${x.matches.map((mm) => mm.matched_on.join('+')).join('; ')}\n`);
  printStep('Auto: log the request (opted in)', await rt.call('macaria_log_request', subject));
  printStep('Build the checklist', await rt.call('macaria_build_checklist', subject));
  const del = { system: 'exports/crm-contacts.csv', rows: '3', reason: 'Verified erasure request', email: subject.email };
  const a = await rt.call('macaria_request_deletion', del);
  printStep('Auto: request deletion in the CRM — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Dana Privacy Lead (fictional)');
  process.stdout.write(`    (demo: "Dana Privacy Lead" approves ${a.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('macaria_request_deletion', del));
  printStep('Agent tries to delete the rows itself', await rt.call('macaria_delete_records', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
