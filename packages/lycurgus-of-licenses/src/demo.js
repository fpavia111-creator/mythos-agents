import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['lycurgus_draft_exceptions'] });
  process.stdout.write(`Lycurgus of Licenses demo (fictional project "kettle-app") in ${rt.root} — Auto on for lycurgus_draft_exceptions only\nApplies your written policy; not legal advice. No network calls.\n`);
  const f = { project: 'project', policy: 'license-policy.json', as_of: '2026-11-14' };
  const r = await rt.call('lycurgus_check', f);
  printStep('Check every dependency against the policy', r);
  for (const p of r.result.packages.filter((x) => x.decision !== 'allow' || x.exception)) process.stdout.write(`    ${p.decision.padEnd(8)} ${(p.name + '@' + p.version).padEnd(24)} ${String(p.license || '(none)').padEnd(28)} ${p.exception ? 'exception' : p.policy_section || ''}\n`);
  printStep('Write the report, SBOM and SARIF', await rt.call('lycurgus_write_report', f));
  printStep('Auto: draft exception stubs and a review list (policy untouched)', await rt.call('lycurgus_draft_exceptions', f));
  const failed = await rt.call('lycurgus_write_report', { ...f, out_dir: 'mythos-out/failed' });
  const req = { check_summary: failed.result.check_summary, check_summary_sha256: failed.result.check_summary_sha256 };
  const a = await rt.call('lycurgus_request_release', req);
  printStep('Auto: publish the release — stays one-click (production deploy)', a);
  rt.approvals.approve(a.approval_id, 'Robin Release Manager (fictional)');
  process.stdout.write(`    (demo: "Robin Release Manager" approves ${a.approval_id})\n`);
  printStep('Same request after the click: refused, because the check failed', await rt.call('lycurgus_request_release', req));
  // The team replaces gpl-widget and expired-ex, reviews the rest, and checks again.
  const lockFile = join(rt.root, 'project/package-lock.json'); const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  delete lock.packages['node_modules/gpl-widget']; delete lock.packages['node_modules/expired-ex'];
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  process.stdout.write('\n    (demo: the team removes gpl-widget and expired-ex from the project and runs the check again)\n');
  const ok = await rt.call('lycurgus_write_report', { ...f, out_dir: 'mythos-out/fixed' });
  printStep('Check again', ok);
  const req2 = { check_summary: ok.result.check_summary, check_summary_sha256: ok.result.check_summary_sha256, review_note: 'Dana Counsel (fictional) reviewed the LGPL, MPL, CC-BY and custom-license items on 2026-11-14' };
  rt.approvals.approve((await rt.call('lycurgus_request_release', req2)).approval_id, 'Robin Release Manager (fictional)');
  printStep('Release request after the click (recorded, not published)', await rt.call('lycurgus_request_release', req2));
  printStep('Agent tries to publish itself', await rt.call('npm_publish', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
