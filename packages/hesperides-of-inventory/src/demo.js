import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['hesperides_draft_adjustments'] });
  process.stdout.write(`Hesperides of Inventory demo (fictional counts and stock) in ${rt.root} — Auto on for hesperides_draft_adjustments only\nHesperides never posts to an ERP.\n`);
  const f = { counts: 'counts.csv', on_hand: 'on-hand.csv', transactions: 'transactions.csv', snapshot_at: '2026-11-13' };
  const r = await rt.call('hesperides_compare', f);
  printStep('Compare cycle counts with the on-hand snapshot', r);
  for (const i of r.result.items) process.stdout.write(`    ${String(i.rank).padStart(2)} ${i.sku.padEnd(8)} ${i.location.padEnd(5)} sys ${String(i.system_qty ?? '—').padStart(4)} count ${String(i.recount_qty ?? i.counted_qty ?? '—').padStart(4)} var ${String(i.variance_value ?? '—').padStart(7)}  ${i.status}${i.flags.length ? ` (${i.flags.join(', ')})` : ''}\n`);
  printStep('Write the variance review and a blind recount sheet', await rt.call('hesperides_write_report', f));
  const l = await rt.call('hesperides_compare', { counts: 'counts-lots.csv', on_hand: 'on-hand-lots.csv', uom_table: 'uom-table.json' });
  printStep('Lots, serials and the unit-of-measure table', l);
  for (const i of l.result.items) process.stdout.write(`    ${i.sku.padEnd(8)} ${(i.lot || '').padEnd(7)} ${i.status.padEnd(12)} ${i.notes[0] || ''}\n`);
  const acc = await rt.call('hesperides_accuracy', { ...f, count_policy: 'count-policy.json', previous_counts: 'counts-prev.csv', previous_on_hand: 'on-hand.csv' });
  printStep('Record accuracy by class and counter, against last month', acc);
  for (const g of [...acc.result.by_class, ...acc.result.by_counter]) process.stdout.write(`    ${g.key.padEnd(4)} ${String(g.ira_pct).padStart(5)}%  ${g.hits}/${g.lines}  misses: ${g.misses.join(', ') || '—'}\n`);
  const plan = await rt.call('hesperides_count_plan', { on_hand: 'on-hand.csv', count_policy: 'count-policy.json' });
  printStep('ABC count plan for the next 26 weeks (blind sheets + calendar)', plan);
  for (const x of plan.result.lines.slice(0, 5)) process.stdout.write(`    ${x.date} ${x.class} ${x.sku.padEnd(8)} ${x.location} ${x.occurrence}\n`);
  process.stdout.write(`    … ${plan.result.count_lines - 5} more line(s)\n`);
  const reasons = { 'SAW-7@C-01': 'DAMAGED', 'WID-200@A-02': 'COUNT-CORR' };
  const d = await rt.call('hesperides_draft_adjustments', { ...f, reasons });
  printStep('Auto: draft adjustments with the reviewer\'s reason codes (opted in; nothing posted)', d);
  const req = { batch: d.result.batch, batch_sha256: d.result.batch_sha256 };
  const a = await rt.call('hesperides_request_post', req);
  printStep('Auto: post the adjustment — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Ria Ops Manager (fictional)');
  process.stdout.write(`    (demo: "Ria Ops Manager" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not posted)', await rt.call('hesperides_request_post', req));
  printStep('Agent tries to post to the ERP itself', await rt.call('erp_post_adjustment', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
