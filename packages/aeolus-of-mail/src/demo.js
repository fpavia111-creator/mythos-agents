import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['aeolus_draft_records', 'aeolus_plan_dmarc_rollout'] });
  process.stdout.write(`Aeolus of Mail demo (fictional DNS for example.com and friends) in ${rt.root} — Auto on for aeolus_draft_records and aeolus_plan_dmarc_rollout only\nOffline: the demo reads fixtures/records.json. Live audits use DNS-over-HTTPS and only read.\n`);
  const h = await rt.call('aeolus_check_headers', { message: 'messages/forwarded.eml' });
  printStep('Read a saved message: receiver results, alignment, DKIM selector in use, ARC chain', h);
  const f = { domain: 'example.com', records: 'records.json', selectors: ['s1', 'k1', 'old', 'mh'] };
  const r = await rt.call('aeolus_audit', f);
  printStep('Audit example.com (SPF, DMARC, DKIM, MX, MTA-STS, TLS-RPT)', r);
  for (const x of r.result.findings) process.stdout.write(`    ${x.severity.padEnd(8)} ${x.check.padEnd(32)} ${x.record}\n`);
  const rep = await rt.call('aeolus_dmarc_reports', { reports: ['dmarc'], domain: 'example.com' });
  printStep('Read saved DMARC aggregate reports (xml, gz, zip; a resent duplicate is counted once)', rep);
  for (const x of rep.result.sources) process.stdout.write(`    ${x.status.padEnd(15)} ${x.source_ip.padEnd(14)} ${String(x.messages).padStart(4)} msg  ${x.why[0] || ''}\n`);
  printStep('Write the report (Markdown, HTML, CSV; hash in the audit log)', await rt.call('aeolus_write_report', { ...f, reports: ['dmarc'] }));
  const plan = await rt.call('aeolus_plan_dmarc_rollout', { domain: 'brand.example.net', records: 'records.json', start_date: '2026-11-16', reports: ['dmarc-brand'] });
  printStep('Auto: plan a staged DMARC rollout for brand.example.net (.ics with review dates)', plan);
  for (const st of plan.result.plan.stages) process.stdout.write(`    step ${st.step} ${st.earliest_date}  ${st.record}\n`);
  const step = { change: plan.result.change, change_sha256: plan.result.change_sha256 };
  printStep('Auto: apply the next stage — stays one-click (production deploy)', await rt.call('aeolus_request_dns_change', step));
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
