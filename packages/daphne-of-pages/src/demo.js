import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['daphne_draft_fixes'] });
  process.stdout.write(`Daphne of Pages demo (fictional pages) in ${rt.root} — Auto on for daphne_draft_fixes only\nA technical checklist, not a legal opinion. No network calls.\n`);
  const f = { site: 'site', base_url: 'https://www.example.com' };
  const r = await rt.call('daphne_audit', f);
  printStep('Audit the site folder (links, SEO, accessibility)', r);
  for (const p of r.result.by_page) process.stdout.write(`    ${p.page.padEnd(16)} ${String(p.errors).padStart(2)} error(s) ${String(p.issues).padStart(3)} issue(s)  ${p.title || '(no title)'}\n`);
  for (const i of r.result.items.filter((x) => x.severity === 'error')) process.stdout.write(`    error  ${(i.page + ':' + i.line).padEnd(19)} ${i.check}${i.wcag ? ` (WCAG ${i.wcag})` : ''}\n`);
  printStep('Write the report and fix list', await rt.call('daphne_write_report', f));
  const d = await rt.call('daphne_draft_fixes', { ...f, lang: 'en' });
  printStep('Auto: draft mechanical fixes as copies (opted in; site files untouched)', d);
  const pub = { proposal: d.result.proposal, proposal_sha256: d.result.proposal_sha256 };
  const a = await rt.call('daphne_request_publish', pub);
  printStep('Auto: publish the proposal — stays one-click (production deploy)', a);
  rt.approvals.approve(a.approval_id, 'Sam Web Lead (fictional)');
  process.stdout.write(`    (demo: "Sam Web Lead" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not deployed)', await rt.call('daphne_request_publish', pub));
  printStep('Agent tries to deploy the site itself', await rt.call('deploy_site', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
