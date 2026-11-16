// `echo-of-docs ci`: run the echo_ci gate through the policy runtime (so it is audited)
// and exit 1 when the gate fails. Used by the GitHub Action in action.yml.
import { parseFlags, runtimeFromFlags } from 'mythos-agent-core';

export const CI_FLAGS = ['pack', 'tools', 'openapi', 'config', 'fail-on', 'baseline', 'new-only', 'require-changelog', 'out-dir', 'ignore', 'root', 'state-dir', 'mode'];
const USAGE = `echo-of-docs ci --pack DIR [--tools tools.json] [--openapi spec.json] [--config .echo.json]
                 [--fail-on error|warning|any|none] [--baseline drift.json] [--new-only]
                 [--require-changelog] [--ignore check_a,check_b] [--out-dir DIR] [--root DIR] [--state-dir DIR]
Writes echo-of-docs.sarif and drift.json to --out-dir (default mythos-out/echo, under --root).
Exit code: 0 pass, 1 drift at or above --fail-on, 2 usage or input error.`;

export async function runCi(manifest, argv, { write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s) } = {}) {
  const { flags } = parseFlags(argv);
  if (flags.help) { write(USAGE + '\n'); return 0; }
  const unknown = Object.keys(flags).filter((k) => !CI_FLAGS.includes(k));
  if (unknown.length) { writeErr(`unknown option(s): ${unknown.map((k) => '--' + k).join(', ')}\n${USAGE}\n`); return 2; }
  if (!flags.pack && !flags.config) { writeErr(`--pack or --config is required\n${USAGE}\n`); return 2; }
  const args = {};
  for (const [flag, key] of [['pack', 'pack'], ['tools', 'tools'], ['openapi', 'openapi'], ['config', 'config'], ['fail-on', 'fail_on'], ['baseline', 'baseline'], ['out-dir', 'out_dir']]) if (typeof flags[flag] === 'string' && flags[flag] !== '') args[key] = flags[flag];
  if (flags['new-only']) args.new_only = true;
  if (flags['require-changelog']) args.require_changelog = true;
  if (typeof flags.ignore === 'string' && flags.ignore) args.ignore = flags.ignore.split(',').map((s) => s.trim()).filter(Boolean);
  const rt = runtimeFromFlags(manifest, { mode: 'review', ...flags });
  const r = await rt.call('echo_ci', args);
  if (r.status !== 'executed') { writeErr(`echo-of-docs ci: ${r.reason || r.status}\n`); return 2; }
  const res = r.result;
  write(`${res.summary}\n`);
  for (const f of res.failing) write(`  ${f.severity.padEnd(8)} ${f.check.padEnd(26)} ${f.file}${f.line ? ':' + f.line : ''}  ${f.detail}\n`);
  write(`SARIF: ${res.sarif}\n`);
  return res.pass ? 0 : 1;
}
