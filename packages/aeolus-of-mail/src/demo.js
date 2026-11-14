import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['aeolus_draft_records'] });
  process.stdout.write(`Aeolus of Mail demo (fictional DNS for example.com and friends) in ${rt.root} — Auto on for aeolus_draft_records only\nOffline: the demo reads fixtures/records.json. Live audits use DNS-over-HTTPS and only read.\n`);
  const f = { domain: 'example.com', records: 'records.json', selectors: ['s1', 'k1', 'old', 'mh'] };
  const r = await rt.call('aeolus_audit', f);
  printStep('Audit example.com (SPF, DMARC, DKIM, MX, MTA-STS, TLS-RPT)', r);
  for (const x of r.result.findings) process.stdout.write(`    ${x.severity.padEnd(8)} ${x.check.padEnd(32)} ${x.record}\n`);
  printStep('Write the report', await rt.call('aeolus_write_report', f));
  const g = { domain: 'nomail.example.net', records: 'records.json', senders: ['include:spf.crm.example.org'], rua: 'dmarc@example.net' };
  const d = await rt.call('aeolus_draft_records', g);
  printStep('Auto: pre-stage SPF and DMARC for nomail.example.net (DNS untouched)', d);
  for (const c of d.result.changes) process.stdout.write(`    ${c.action} ${c.type} ${c.name}: ${c.proposed}\n`);
  const req = { change: d.result.change, change_sha256: d.result.change_sha256 };
  const a = await rt.call('aeolus_request_dns_change', req);
  printStep('Auto: apply the DNS change — stays one-click (production deploy)', a);
  rt.approvals.approve(a.approval_id, 'Lee Mail Admin (fictional)');
  process.stdout.write(`    (demo: "Lee Mail Admin" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded; DNS not changed)', await rt.call('aeolus_request_dns_change', req));
  printStep('Agent tries to edit DNS itself', await rt.call('dns_update', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
