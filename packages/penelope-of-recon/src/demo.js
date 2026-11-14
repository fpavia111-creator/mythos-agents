import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['penelope_accept_match'] });
  process.stdout.write(`Penelope of Recon demo (fictional bank and GL) in ${rt.root} — Auto on for penelope_accept_match only\n`);
  const f = { bank: 'bank-statement.csv', gl: 'gl-cash.csv', bank_balance: 12422.88, gl_balance: 12844.76 };
  const r = await rt.call('penelope_reconcile', f);
  printStep('Propose matches and tie balances', r);
  for (const m of r.result.matches) process.stdout.write(`    ${m.confidence.padEnd(6)} ${m.type.padEnd(12)} ${m.bank.join('+')} ↔ ${m.gl.join('+').padEnd(10)} ${m.amount}  ${m.note}\n`);
  for (const b of r.result.bank_only) process.stdout.write(`    bank only  ${b.id} ${b.description} ${b.amount}: ${b.kind}\n`);
  for (const g of r.result.gl_only) process.stdout.write(`    GL only    ${g.id} ${g.description} ${g.amount}: ${g.kind}\n`);
  printStep('Write the workpaper', await rt.call('penelope_write_workpaper', f));
  printStep('Auto: accept a high-confidence match (opted in)', await rt.call('penelope_accept_match', { bank_ids: r.result.matches[0].bank.join(' '), gl_ids: r.result.matches[0].gl.join(' ') }));
  const req = { date: '2026-10-31', amount: -25, account: 'Bank fees expense', memo: 'Monthly service fee Oct 2026', bank_line: 'B7' };
  const a = await rt.call('penelope_request_adjusting_entry', req);
  printStep('Auto: request an adjusting entry — stays one-click', a);
  rt.approvals.approve(a.approval_id, 'Dana Reviewer (fictional)');
  process.stdout.write(`    (demo: "Dana Reviewer" approves ${a.approval_id})\n`);
  printStep('Same request after the human click', await rt.call('penelope_request_adjusting_entry', req));
  printStep('Agent tries to post to the ledger', await rt.call('ledger_post_journal', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
