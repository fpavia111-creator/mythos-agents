// Child process for bench.mjs: runs one tool once and prints timing as JSON.
import { pathToFileURL } from 'node:url';
const [pkgDir, root, tool, argsJson] = process.argv.slice(2);
const { AgentRuntime } = await import(pathToFileURL(`${pkgDir}/../mythos-agent-core/src/index.js`).href);
const { manifest } = await import(pathToFileURL(`${pkgDir}/src/index.js`).href);
const rt = new AgentRuntime(manifest, { root, audit: false, caps: { maxSteps: 10, maxSpendUsd: 0 } });
let peak = 0; const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
const t0 = performance.now();
const r = await rt.call(tool, JSON.parse(argsJson));
const ms = performance.now() - t0; clearInterval(tick); peak = Math.max(peak, process.memoryUsage().rss);
process.stdout.write(JSON.stringify({ status: r.status, reason: r.reason ? String(r.reason).slice(0, 200) : undefined, ms: Math.round(ms), rss_mb: Math.round(peak / 1048576) }) + '\n');
