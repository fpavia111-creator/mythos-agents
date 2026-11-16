#!/usr/bin/env node
// Scale test: runs the real agent tools on large inputs and times them.
//
//   node scripts/bench.mjs                      every agent, 1,000 and 10,000 rows
//   node scripts/bench.mjs --sizes 1000,50000   other sizes
//   node scripts/bench.mjs ladon-of-access ...  only these agents
//
// For each read or report tool that an eval case calls with a table file, the
// case's fictional table files are grown to N rows (seeded and repeatable: rows
// are cycled; each copy gets its own ids, emails, references, party names and tax ids, amounts get
// a small seeded change, dates are spread over four weeks), then the tool runs once in its own process with the
// policy, validation and adapters on. Wall time includes reading and parsing the
// files. Results: mythos-out/bench/bench.md and bench.json. No network; the data
// stays fictional (the source rows are the agents' own fictional fixtures).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PK = join(ROOT, 'packages');
const { parseCsv, toCsv } = await import(pathToFileURL(join(PK, 'mythos-agent-core', 'src', 'index.js')).href);
const argv = process.argv.slice(2);
const si = argv.indexOf('--sizes'); const SIZES = si >= 0 ? argv[si + 1].split(',').map(Number) : [1000, 10000];
const TIMEOUT = 180000;
const only = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--sizes');
const agents = readdirSync(PK).filter((n) => /-of-/.test(n) && (!only.length || only.includes(n))).sort();

// Seeded PRNG (mulberry32) so a run is repeatable.
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const IDCOL = /internalid|externalid|(^|_)(id|ref|reference|number|no|sku|key|code)$|^(id|sku|ref|login|user|username|email|mail|serial)$|email|invoice|order|request|po$|^fitid/i;
const AMOUNT = /amount|total|price|cost|value|balance|qty|quantity|limit/i;

// Copies of a row get a copy number k (1, 2, ...). Ids, emails and references get "-k",
// so rows that shared an id still share it inside the same copy (payments stay grouped
// under their vendor). Party names get a made-up name per (name, k) and tax ids and phones get new
// digits, so the copies read as different payees rather than thousands of duplicates.
const PARTY = /^(name|vendor|vendor_name|payee|payee_name|customer|customer_name|company|company_name|companyname|entityid|merchant|supplier|counterparty|legal_name|full_name|display_name|employee|employee_name|submitter)$/i;
const TAXID = /^(tin|ein|ssn|tax_id|taxid|vat|vat_number|vat_id|phone|phone_number|telephone|fax|mobile)$/i;
const ADDRESS = /^(address|address1|address_1|address_line1|street|street_address|addr)$/i;
const ENTITY_TAIL = /\s+(inc|llc|ltd|limited|corp|co|gmbh|plc|lp|llp)\.?$/i;
const SYL = 'ka ver lo mi dra sun tel ox bri na qu zen har pol ris vo ty gal mor fen lu sa dek wy jo cle ast bel cor dun eff gim hob ix jux kel lim nor oph pra quo rud sef tor ulm vex wim xan yor zeb ack bre cho dwi em fro gru hy ic jen'.split(' ');
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
function madeUpName(v, k) {
  const tail = (v.match(ENTITY_TAIL) || [''])[0]; const core = v.slice(0, v.length - tail.length);
  const g = rng(hash(core + '#' + k)); const word = (n) => { let w = ''; for (let i = 0; i < n; i++) w += SYL[Math.floor(g() * SYL.length)]; return w[0].toUpperCase() + w.slice(1); };
  return `${word(2 + Math.floor(g() * 2))} ${word(2 + Math.floor(g() * 2))}${tail}`;
}
function grow(rows, n, seed) {
  if (!rows.length) return rows;
  const r = rng(seed); const cols = Object.keys(rows[0]); const out = [];
  for (let i = 0; i < n; i++) {
    const base = rows[i % rows.length]; if (i < rows.length) { out.push(base); continue; }
    const k = Math.floor(i / rows.length); const o = { ...base };
    for (const c of cols) {
      const v = String(o[c] ?? ''); if (!v) continue;
      if (/@/.test(v) && /mail|login|user|owner|manager|contact|^to$|from|approver|reviewer/i.test(c)) o[c] = v.replace('@', `+${k}@`);
      else if (PARTY.test(c) && !/@/.test(v)) o[c] = madeUpName(v, k);
      else if (TAXID.test(c) && /\d/.test(v)) { const g = rng(hash(v + '#' + k)); o[c] = v.replace(/\d/g, () => String(Math.floor(g() * 10))); }
      else if (ADDRESS.test(c) && /\d/.test(v)) { const g = rng(hash(v + '#' + k)); o[c] = v.replace(/\d+/, () => String(1 + Math.floor(g() * 9999))); }
      else if (IDCOL.test(c)) o[c] = `${v}-${k}`;
      else if (/date|_at$|^when$|^posted|^created|^due|expir|last_/i.test(c) && /^\d{4}-\d{2}-\d{2}/.test(v)) { const d = new Date(Date.parse(v.slice(0, 10) + 'T00:00:00Z') + (k % 28) * 86400000); if (!Number.isNaN(d.getTime())) o[c] = d.toISOString().slice(0, 10) + v.slice(10); }
      else if (AMOUNT.test(c) && /^-?\d+(\.\d+)?$/.test(v)) { const x = Number(v) * (0.9 + r() * 0.2); o[c] = /\./.test(v) ? x.toFixed(2) : String(Math.max(0, Math.round(x))); }
    }
    out.push(o);
  }
  return out;
}

const results = [];
for (const n of agents) {
  const pkgDir = join(PK, n); const casesFile = join(pkgDir, 'evals', 'cases.json'); if (!existsSync(casesFile)) continue;
  const suite = JSON.parse(readFileSync(casesFile, 'utf8'));
  const { manifest } = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
  const base = join(pkgDir, 'evals', suite.root || '.');
  const rules = manifest.policy.rules; const seen = new Set();
  for (const c of suite.cases) {
    const t = manifest.tools.find((x) => x.name === c.tool); if (!t || seen.has(t.name) || !['read', 'report'].includes(t.kind)) continue;
    const rule = rules.find((r) => r.tool === t.name); if (!rule || rule.decision !== 'allow') continue;
    if (c.expect && (c.expect.status === 'error' || c.expect.status === 'blocked')) continue;
    const tables = Object.entries(c.args || {}).filter(([, v]) => typeof v === 'string' && /\.(csv|tsv)$/i.test(v) && existsSync(join(base, v)));
    if (!tables.length) continue;
    seen.add(t.name);
    for (const size of SIZES) {
      const parent = mkdtempSync(join(tmpdir(), `bench-${n}-`)); const root = join(parent, 'root');
      cpSync(base, root, { recursive: true, filter: (s) => !/node_modules|\.mythos|mythos-out|\/\.git(\/|$)/.test(s) });
      let rowsIn = 0; let seed = 7;
      for (const [, rel] of tables) {
        const f = join(root, rel); const rows = parseCsv(readFileSync(f, 'utf8'));
        if (!rows.length) continue;
        const grown = grow(rows, size, seed++); rowsIn += grown.length;
        writeFileSync(f, toCsv(grown, Object.keys(rows[0]), { raw: true }));
      }
      const args = { ...c.args }; if ('out_dir' in (t.inputSchema?.properties || {})) args.out_dir = 'mythos-out/bench';
      const p = spawnSync(process.execPath, [join(ROOT, 'scripts', 'bench', 'one.mjs'), pkgDir, root, t.name, JSON.stringify(args)], { encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024 });
      let r; try { r = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { r = { status: p.error && p.error.code === 'ETIMEDOUT' ? 'timeout' : 'crash', reason: (p.stderr || '').split('\n').find(Boolean)?.slice(0, 200) }; }
      results.push({ agent: n, tool: t.name, size, files: tables.length, rows_in: rowsIn, ...r });
      process.stderr.write(`${n} ${t.name} ${size}: ${r.status} ${r.ms ?? ''}ms ${r.rss_mb ?? ''}MB\n`);
      if (process.env.BENCH_KEEP) cpSync(root, join(process.env.BENCH_KEEP, `${n}-${t.name}-${size}`), { recursive: true });
      rmSync(parent, { recursive: true, force: true });
      if (r.status === 'timeout') break;
    }
  }
}

// Growth: time at the largest size over time at the smallest, against the growth in rows.
const [lo, hi] = [Math.min(...SIZES), Math.max(...SIZES)];
const rowsOf = {}; for (const r of results) (rowsOf[`${r.agent}|${r.tool}`] ||= {})[r.size] = r;
const summary = Object.entries(rowsOf).map(([k, v]) => {
  const [agent, tool] = k.split('|'); const a = v[lo], b = v[hi];
  const ratio = a && b && a.ms > 0 && b.status === 'executed' ? b.ms / Math.max(a.ms, 1) : null;
  const flag = !b ? 'not run' : b.status === 'timeout' ? `timeout (> ${TIMEOUT / 1000}s)` : b.status === 'error' && /\bfirst\b/i.test(b.reason || '') ? 'skipped (needs an earlier step)' : b.status !== 'executed' ? b.status : ratio !== null && ratio > (hi / lo) * 3 && b.ms > 1000 ? 'grows much faster than the input' : b.ms > 10000 ? 'slow' : 'ok';
  return { agent, tool, [`ms_${lo}`]: a?.ms ?? null, [`ms_${hi}`]: b?.ms ?? null, [`rss_mb_${hi}`]: b?.rss_mb ?? null, ratio: ratio === null ? null : Math.round(ratio * 10) / 10, flag, ...(b && b.reason ? { reason: b.reason } : {}) };
});
const out = join(ROOT, 'mythos-out', 'bench'); mkdirSync(out, { recursive: true });
const env = { node: process.version, platform: process.platform, cpus: cpus().length, cpu: cpus()[0]?.model, mem_gb: Math.round(totalmem() / 1073741824) };
writeFileSync(join(out, 'bench.json'), JSON.stringify({ created: new Date().toISOString(), env, sizes: SIZES, summary, runs: results }, null, 2) + '\n');
const md = [`# Scale test`, '', `${new Date().toISOString()} · Node ${env.node} · ${env.platform} · ${env.cpus} CPU (${env.cpu}) · ${env.mem_gb} GB`, '',
  `Each line is one real tool call, in its own process, on fictional input grown to the stated number of rows per table file (time includes reading and parsing). Growth = time at ${hi.toLocaleString('en-US')} rows / time at ${lo.toLocaleString('en-US')} rows; ${hi / lo} would be linear.`, '',
  `| Agent | Tool | ${lo.toLocaleString('en-US')} rows (ms) | ${hi.toLocaleString('en-US')} rows (ms) | Peak memory (MB) | Growth | Result |`, '|---|---|---:|---:|---:|---:|---|',
  ...summary.map((s) => `| ${s.agent} | ${s.tool} | ${s[`ms_${lo}`] ?? ''} | ${s[`ms_${hi}`] ?? ''} | ${s[`rss_mb_${hi}`] ?? ''} | ${s.ratio ?? ''} | ${s.flag}${s.reason ? `: ${s.reason.replace(/\|/g, '/')}` : ''} |`), ''].join('\n');
writeFileSync(join(out, 'bench.md'), md);
const bad = summary.filter((s) => s.flag !== 'ok' && !s.flag.startsWith('skipped'));
console.log(`${summary.length} tool(s) across ${new Set(summary.map((s) => s.agent)).size} agent(s). ${bad.length} need attention.`);
for (const s of bad) console.log(`  ${s.agent} ${s.tool}: ${s.flag} (${s[`ms_${hi}`] ?? '?'} ms at ${hi})`);
console.log(`Report: ${relative(ROOT, join(out, 'bench.md'))}`);
