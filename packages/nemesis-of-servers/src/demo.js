import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  process.stdout.write(`Nemesis of Servers demo (deliberately risky sample code) in ${rt.root}\n`);
  const r = await rt.call('nemesis_scan_server', { dir: 'risky-server' });
  printStep('Scan a risky sample MCP server', r);
  for (const i of r.result.items.slice(0, 10)) process.stdout.write(`    ${i.severity.padEnd(6)} ${i.id.padEnd(24)} ${i.file}${i.line ? ':' + i.line : ''}\n`);
  printStep('Scan a tidy sample server', await rt.call('nemesis_scan_server', { dir: 'tidy-server' }));
  const c = await rt.call('nemesis_scan_config', { config: 'mcp.json' });
  printStep('Review an MCP client config', c);
  for (const i of c.result.items) process.stdout.write(`    ${i.severity.padEnd(6)} ${i.server.padEnd(10)} ${i.title}\n`);
  const w = await rt.call('nemesis_write_report', { dir: 'risky-server', config: 'mcp.json' });
  printStep('Write Markdown, JSON and SARIF', w);
  printStep('Agent asks Nemesis to start the server', await rt.call('nemesis_run_server', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
