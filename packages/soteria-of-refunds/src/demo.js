import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto' });
  process.stdout.write(`Soteria of Refunds demo (fictional orders and customers) in ${rt.root} — Auto mode on\n`);
  const f = { requests: 'requests.csv', orders: 'orders.csv', policy: 'policy.json' };
  const t = await rt.call('soteria_triage', f);
  printStep('Triage against the refund policy', t);
  for (const i of t.result.items) process.stdout.write(`    ${i.request_id.padEnd(6)} ${i.type.padEnd(10)} ${String(i.amount).padEnd(7)} ${i.suggestion.padEnd(26)} ${i.flags.join(', ')}\n`);
  printStep('Explain R-1004', await rt.call('soteria_explain', { ...f, request_id: 'R-1004' }));
  printStep('Write the queue and dispute drafts', await rt.call('soteria_write_queue', f));
  printStep('Look up a reason code (Mastercard 4853)', await rt.call('soteria_reason_code', { code: '4853' }));
  const d = { requests: 'disputes.csv', orders: 'orders.csv', policy: 'policy.json' };
  const e = await rt.call('soteria_evidence_pack', d);
  printStep('Evidence packs for six coded disputes (rows cited, hash in the audit line)', e);
  for (const x of e.result.disputes) process.stdout.write(`    ${x.request_id.padEnd(7)} ${String(x.code || '-').padEnd(5)} ${x.category.padEnd(20)} ready ${String(x.readiness.score ?? '-').padStart(3)}%  respond by ${x.respond_by}${x.missing.length ? `  missing: ${x.missing.join(', ')}` : ''}\n`);
  const req = { request_id: 'R-1001', order_id: 'O-501', amount: 45, reason: 'Eligible per policy: damaged item' };
  const a = await rt.call('soteria_request_refund', req);
  printStep('Auto: request an eligible refund — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Dana Support Lead (fictional)');
  process.stdout.write(`    (demo: "Dana Support Lead" approves ${a.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('soteria_request_refund', req));
  printStep('Agent tries to issue the refund itself', await rt.call('payments_issue_refund', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
