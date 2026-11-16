import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

const w = (s) => process.stdout.write(s + '\n');

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  w(`Nemesis of Servers demo (deliberately risky sample code, fictional names) in ${rt.root}`);
  const r = await rt.call('nemesis_scan_server', { dir: 'risky-server' });
  printStep('Scan a risky sample MCP server', r);
  for (const i of r.result.items.slice(0, 10)) w(`    ${i.severity.padEnd(6)} ${i.id.padEnd(24)} ${i.file}${i.line ? ':' + i.line : ''}`);
  printStep('Scan a tidy sample server', await rt.call('nemesis_scan_server', { dir: 'tidy-server' }));

  const f = await rt.call('nemesis_scan_server', { dir: 'flow-server', policy: 'nemesis-policy.json' });
  printStep('Data flows, lockfile and advisories (with a reviewer policy)', f);
  for (const i of f.result.items.filter((x) => x.flow)) w(`    ${i.id.padEnd(24)} ${i.file}: ${i.flow.map((s) => `${s.line} ${s.label}`).join(' -> ')}`);
  for (const i of f.result.suppressed) w(`    suppressed ${i.id}: ${i.suppressed}`);

  const c = await rt.call('nemesis_scan_config', { config: 'mcp.json' });
  printStep('Review an MCP client config', c);
  for (const i of c.result.items) w(`    ${i.severity.padEnd(6)} ${i.server.padEnd(10)} ${i.title}`);
  printStep('Review a config with auto-approved tools', await rt.call('nemesis_scan_config', { config: 'mcp-extra.json', advisories: 'advisories.json' }));

  const t = await rt.call('nemesis_scan_tools', { tools: 'tools/multi.json' });
  printStep('Check saved tool definitions for poisoning', t);
  for (const i of t.result.items.filter((x) => x.severity === 'high')) w(`    ${i.id.padEnd(30)} ${i.server}/${i.tool}: ${i.snippet || i.title}`);

  printStep('Pin the reviewed tool definitions', await rt.call('nemesis_pin_tools', { tools: 'tools/notes-v1.json', server: 'notes' }));
  const p = await rt.call('nemesis_check_pins', { tools: 'tools/notes-v2.json', pins: 'mythos-out/nemesis/tool-pins.json' });
  printStep('A later tools/list: rug-pull check against the pins', p);
  for (const ch of p.result.changes) w(`    ${ch.change.padEnd(8)} ${ch.server}/${ch.tool}${ch.new_risky_text?.length ? '  new text: ' + ch.new_risky_text.join(', ') : ''}`);

  const wr = await rt.call('nemesis_write_report', { dir: 'flow-server', config: 'mcp.json', tools: 'tools/notes-v2.json', pins: 'tools/notes-pins.json', policy: 'nemesis-policy.json', fail_on: 'high' });
  printStep('Write Markdown, JSON and SARIF (CI gate: fail on high)', wr);
  w(`    SARIF sha256 ${wr.result.sarif_sha256} (output hash recorded in the audit log)`);
  printStep('Agent asks Nemesis to start the server', await rt.call('nemesis_run_server', {}));
  w(`\nAudit log: ${rt.stateDir}/audit.jsonl`);
}
