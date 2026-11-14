#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { main, runtimeFromFlags, parseFlags } from 'mythos-agent-core';
import { manifest } from '../src/manifest.js';
import { demo } from '../src/demo.js';

// `lycurgus-of-licenses check --project . --policy license-policy.json` for CI:
// prints the summary and exits 1 when the policy check fails. It changes no files.
if (process.argv[2] === 'check') {
  const { flags } = parseFlags(process.argv.slice(3));
  const rt = runtimeFromFlags(manifest, { ...flags, root: flags.root || process.cwd() });
  const r = await rt.call('lycurgus_check', { project: flags.project || '.', policy: flags.policy || 'license-policy.json', ...(flags['include-dev'] ? { include_dev: true } : {}) });
  if (r.status !== 'executed') { process.stderr.write(`${r.status}: ${r.reason}\n`); process.exit(2); }
  process.stdout.write(r.result.summary + '\n');
  for (const f of r.result.findings.filter((x) => x.severity !== 'advisory')) process.stdout.write(`  ${f.severity.padEnd(8)} ${f.check.padEnd(22)} ${f.package}${f.version ? '@' + f.version : ''}${f.policy_section ? '  ' + f.policy_section : ''}\n`);
  process.exit(r.result.check === 'fail' ? 1 : 0);
} else {
  main(manifest, { bin: 'lycurgus-of-licenses', demo, evalFile: fileURLToPath(new URL('../evals/cases.json', import.meta.url)) });
}
