import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)), { mode: 'auto', autoActions: ['echo_draft_fixes'] });
  process.stdout.write(`Echo of Docs demo (fictional pack "kettle-of-notes") in ${rt.root} — Auto on for echo_draft_fixes only\nReads files only. Never overwrites docs.\n`);
  const f = { pack: 'kettle-of-notes', tools: 'kettle-of-notes/tools.json' };
  const r = await rt.call('echo_check', f);
  printStep('Compare README, docs and SKILL.md with the tool list and package.json', r);
  for (const x of r.result.findings) process.stdout.write(`    ${x.severity.padEnd(8)} ${x.check.padEnd(24)} ${x.file}${x.line ? ':' + x.line : ''}\n`);
  printStep('Write the report', await rt.call('echo_write_report', f));
  const d = await rt.call('echo_draft_fixes', f);
  printStep('Auto: draft mechanical fixes as copies (docs untouched)', d);
  const req = { proposal: d.result.proposal, proposal_sha256: d.result.proposal_sha256 };
  const a = await rt.call('echo_request_publish', req);
  printStep('Auto: publish the docs — stays one-click (production deploy)', a);
  rt.approvals.approve(a.approval_id, 'Kai Docs Owner (fictional)');
  process.stdout.write(`    (demo: "Kai Docs Owner" approves ${a.approval_id})\n`);
  printStep('Same request after the human click (recorded, not published)', await rt.call('echo_request_publish', req));
  printStep('Agent tries to overwrite the README itself', await rt.call('write_docs', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
