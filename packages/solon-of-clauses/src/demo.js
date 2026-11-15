import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['solon_draft_markup'] });
  process.stdout.write(`Solon of Clauses demo (fictional MSA and playbook) in ${rt.root} — Auto on for solon_draft_markup only\nNot legal advice. Text matching against your own playbook; no network calls.\n`);
  const f = { contract: 'contracts/msa.md', playbook: 'playbook.json' };
  const r = await rt.call('solon_check', f);
  printStep('Check the contract against the playbook', r);
  for (const c of r.result.clauses) process.stdout.write(`    ${c.status.padEnd(19)} ${c.title.padEnd(28)} ${c.citations[0] ? `§${c.citations[0].section}, line ${c.citations[0].line}` : ''}\n`);
  for (const d of r.result.document_findings) process.stdout.write(`    ${d.check.padEnd(19)} line ${d.line}\n`);
  printStep('Write the gap report', await rt.call('solon_write_report', f));
  const d = await rt.call('solon_draft_markup', f);
  printStep('Auto: draft the issues list for counsel (nothing sent)', d);
  const req = { draft: d.result.draft, draft_sha256: d.result.draft_sha256, to: 'Kettle Labs legal (fictional)', reviewed_by: 'Morgan Counsel (fictional)' };
  const a = await rt.call('solon_request_send', req);
  printStep('Auto: send it to the supplier — stays one-click (binding send)', a);
  rt.approvals.approve(a.approval_id, 'Jo Ops Lead (fictional)');
  process.stdout.write(`    (demo: "Jo Ops Lead" approves ${a.approval_id})\n`);
  printStep('Same request after the click: refused until counsel clears every [COUNSEL REVIEW]', await rt.call('solon_request_send', req));
  const file = join(rt.root, d.result.draft); const reviewed = readFileSync(file, 'utf8').replace(/ ?\[COUNSEL REVIEW\]/g, '');
  writeFileSync(file, reviewed);
  process.stdout.write('\n    (demo: "Morgan Counsel" reviews each section and removes its [COUNSEL REVIEW] marker)\n');
  const req2 = { ...req, draft_sha256: createHash('sha256').update(reviewed).digest('hex') };
  rt.approvals.approve((await rt.call('solon_request_send', req2)).approval_id, 'Jo Ops Lead (fictional)');
  printStep('Send request after review and the click (recorded, not sent)', await rt.call('solon_request_send', req2));
  printStep('Agent tries to e-sign the contract', await rt.call('e_sign', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
