// Echo of Docs: find where a package's docs no longer match its tools and package.json.
// Reads files only. Never overwrites docs.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { checkOpenapi, checkChangelog } from './checks.js';

export const LIMITS = 'Echo compares the docs with the tool list, input schemas and package.json you give it. It checks names, labels, versions, examples and links, not whether the prose is accurate or complete, and it does not run the code. Passing means "no drift found by these checks", not "the docs are complete".';
const SEV = { error: 0, warning: 1, advisory: 2 };
const NOT_TOOLS = new Set(['go_live', 'revoke_access', 'delete_personal_data', 'move_money', 'binding_send', 'production_deploy', 'accept_learning']);

export function loadTools(json) {
  let list = Array.isArray(json) ? json : json?.tools || json?.result?.tools || json?.result?.structuredContent?.tools;
  if (!Array.isArray(list)) throw new Error('tools file must be a list of tools, an MCP tools/list result ({"tools":[...]}) or mythos_info output');
  return list.map((t) => {
    if (!t || !t.name) throw new Error('every tool needs a name');
    let decision = t.decision || null; let category = t.category || null;
    const m = /^\[(ALLOW|ASK|BLOCK)(?: · ([a-z_]+))?\]/.exec(t.description || '');
    if (!decision && m) { decision = m[1].toLowerCase(); category = category || m[2] || null; }
    const schema = t.inputSchema || t.input_schema || null;
    return { name: t.name, decision, category, properties: schema?.properties ? Object.keys(schema.properties) : null, required: schema?.required || [] };
  }).filter((t) => t.name !== 'mythos_info');
}

export function listDocs(packDir) {
  const out = [];
  const add = (f) => { if (existsSync(f) && statSync(f).isFile()) out.push(f); };
  for (const n of readdirSync(packDir)) if (/^(README|SKILL|CHANGELOG|USAGE|CONTRIBUTING)(\.[a-z]+)?\.md$/i.test(n) || /^readme\.md$/i.test(n)) add(join(packDir, n));
  const walk = (d, depth) => { if (!existsSync(d) || depth > 4) return; for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) { if (!n.startsWith('.') && n !== 'node_modules' && n !== 'mythos-out') walk(f, depth + 1); } else if (/\.mdx?$/i.test(n)) add(f); } };
  walk(join(packDir, 'docs'), 0); walk(join(packDir, 'skills'), 0); walk(join(packDir, '.claude', 'skills'), 0);
  return [...new Set(out)].sort();
}

export function slug(h) { return h.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-'); }
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

function parseDoc(text) {
  const lines = text.split('\n'); const headings = []; const tables = []; const code = []; const links = [];
  let inCode = false; let fence = ''; let block = null; let table = null;
  lines.forEach((l, i) => {
    const ln = i + 1;
    const f = /^\s*(```+|~~~+)/.exec(l);
    if (f) { if (!inCode) { inCode = true; fence = f[1]; block = { start: ln, lines: [] }; } else if (l.trim().startsWith(fence)) { inCode = false; code.push(block); block = null; } return; }
    if (inCode) { block.lines.push({ ln, text: l }); return; }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l); if (h) headings.push({ ln, text: h[2] });
    if (/^\s*\|.*\|\s*$/.test(l)) { const cells = l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()); if (!table) { table = { header: cells, rows: [], ln }; } else if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) table.rows.push({ ln, cells }); } else if (table) { tables.push(table); table = null; }
    for (const m of l.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) links.push({ ln, text: m[1], href: m[2] });
  });
  if (table) tables.push(table);
  const anchors = new Map(); const ids = [];
  for (const h of headings) { const s = slug(h.text); const n = anchors.get(s) || 0; ids.push(n ? `${s}-${n}` : s); anchors.set(s, n + 1); }
  for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) ids.push(m[1]);
  return { lines, headings, tables, code, links, ids: new Set(ids) };
}
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (!m) return null;
  const o = {}; for (const l of m[1].split('\n')) { const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l); if (kv) o[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim(); }
  return o;
}

export function check(packDir, toolsJson, { ignore = [], openapi = null, openapiLabel = 'the OpenAPI spec', require_changelog = false } = {}) {
  const pjf = join(packDir, 'package.json'); if (!existsSync(pjf)) throw new Error('package.json not found in the pack folder');
  const pj = JSON.parse(readFileSync(pjf, 'utf8'));
  const tools = toolsJson ? loadTools(toolsJson) : [];
  const names = new Set(tools.map((t) => t.name));
  // MCP prompt names share the tool prefix but are not tools: take them from the file when it has
  // them ({"tools":[...],"prompts":[...]}), and skip names under a heading about prompts.
  const promptNames = new Set((toolsJson && !Array.isArray(toolsJson) ? toolsJson.prompts || toolsJson.result?.prompts || [] : []).map((p) => p && p.name).filter(Boolean));
  // Config schema names can share a tool prefix too ({"tools":[...],"config_schemas":["funder_template"]}).
  for (const n of (toolsJson && !Array.isArray(toolsJson) ? toolsJson.config_schemas || toolsJson.result?.config_schemas || [] : [])) if (typeof n === 'string') promptNames.add(n); else if (n && n.name) promptNames.add(n.name);
  const prefixes = new Set(tools.map((t) => t.name.split('_')[0] + '_'));
  for (const t of tools) if (t.category) NOT_TOOLS.add(t.category);
  const looksLikeTool = (n) => !NOT_TOOLS.has(n) && n.includes('_') && [...prefixes].some((p) => n.startsWith(p));
  const docs = listDocs(packDir); if (!docs.length) throw new Error('no README.md or other .md docs found in the pack folder');
  const findings = []; const mentioned = new Set(); const fixes = []; const parsed = [];
  const add = (check, severity, file, line, detail, fix = null) => { findings.push({ check, severity, file, line, detail }); if (fix) fixes.push({ check, file, line, ...fix }); };
  const binNames = new Set(typeof pj.bin === 'string' ? [pj.name.split('/').pop()] : Object.keys(pj.bin || {}));
  const scripts = new Set(Object.keys(pj.scripts || {}));
  const engine = /(\d+)/.exec(pj.engines?.node || '')?.[1] || null;
  const nearest = (n) => { let best = null; let bd = 3; for (const t of names) { const d = lev(n, t); if (d < bd) { bd = d; best = t; } else if (d === bd) best = null; } return bd <= 2 ? best : null; };
  for (const file of docs) {
    const rel = relative(packDir, file).split(sep).join('/'); const text = readFileSync(file, 'utf8'); const d = parseDoc(text);
    parsed.push({ rel, lines: d.lines });
    // tool mentions anywhere in backticks
    const promptLine = (ln) => { const h = [...d.headings].reverse().find((x) => x.ln <= ln); return (h && /\bprompts?\b/i.test(h.text)) || /\bprompt\b/i.test(d.lines[ln - 1]); };
    for (const [i, l] of d.lines.entries()) for (const m of l.matchAll(/`([a-z][a-z0-9_]{2,63})`/g)) { if (names.has(m[1])) mentioned.add(m[1]); else if (promptNames.has(m[1]) || promptLine(i + 1)) continue; else if (tools.length && looksLikeTool(m[1])) { const near = nearest(m[1]); add('tool_not_in_code', 'error', rel, i + 1, `\`${m[1]}\` is not a tool in the tool list${near ? `. Did you mean \`${near}\`?` : '.'}`, near ? { find: m[1], replace: near } : null); } }
    // tool tables
    for (const t of d.tables) {
      const hi = t.header.findIndex((h) => /^tool/i.test(h)); const pi = t.header.findIndex((h) => /policy|decision/i.test(h)); if (hi < 0) continue;
      for (const r of t.rows) {
        const nm = /`([a-z][a-z0-9_]{2,63})`/.exec(r.cells[hi] || '')?.[1]; if (!nm) continue;
        if (!names.has(nm) && tools.length && !looksLikeTool(nm) && !NOT_TOOLS.has(nm)) { const near = nearest(nm); add('tool_not_in_code', 'error', rel, r.ln, `Tools table lists \`${nm}\`, which is not in the tool list${near ? `. Did you mean \`${near}\`?` : '.'}`, near ? { find: nm, replace: near } : null); }
        const tool = tools.find((x) => x.name === nm);
        if (tool && pi >= 0 && tool.decision) { const said = /\b(allow|ask|block)\b/i.exec(r.cells[pi] || '')?.[1]?.toLowerCase(); if (said && said !== tool.decision) add('policy_mismatch', 'error', rel, r.ln, `Docs say \`${nm}\` is ${said}; the tool list says ${tool.decision}.`); if (tool.category && said === 'ask' && !/one[- ]click/i.test(r.cells[pi])) add('one_click_not_stated', 'warning', rel, r.ln, `\`${nm}\` is ${tool.category}, which stays one-click even in Auto; the docs do not say so.`); }
      }
    }
    // code examples
    for (const b of d.code) for (const { ln, text: l } of b.lines) {
      const call = /\bcall\s+([a-z][a-z0-9_]+)\s+'(\{.*\})'/.exec(l);
      if (call) { const tool = tools.find((x) => x.name === call[1]); if (tools.length && !tool) add('tool_not_in_code', 'error', rel, ln, `Example calls \`${call[1]}\`, which is not in the tool list.`); else if (tool) { mentioned.add(tool.name); let args = null; try { args = JSON.parse(call[2]); } catch { add('example_invalid_json', 'warning', rel, ln, `The arguments in the \`${call[1]}\` example are not valid JSON.`); } if (args && tool.properties) { const extra = Object.keys(args).filter((k) => !tool.properties.includes(k)); if (extra.length) add('param_not_in_schema', 'error', rel, ln, `Example passes ${extra.map((k) => `\`${k}\``).join(', ')} to \`${tool.name}\`, but its input schema has ${tool.properties.map((k) => `\`${k}\``).join(', ') || 'no parameters'}.`); const miss = tool.required.filter((k) => !(k in args)); if (miss.length) add('example_missing_required', 'warning', rel, ln, `Example for \`${tool.name}\` leaves out required ${miss.map((k) => `\`${k}\``).join(', ')}.`); } } }
      for (const m of l.matchAll(/\bnpm run ([\w:-]+)/g)) if (!scripts.has(m[1])) add('script_missing', 'error', rel, ln, `\`npm run ${m[1]}\` is in the docs, but package.json has no "${m[1]}" script.`);
      const npx = /\bnpx\s+(?:-y\s+)?(?:-p\s+\S+\s+)?([@a-z0-9][\w./@-]*)/.exec(l);
      if (npx) { const spec = npx[1]; const base = spec.replace(/@[^@/]*$/, '') || spec; if ((base === pj.name) && !binNames.size) add('bin_missing', 'error', rel, ln, `Docs run \`npx ${pj.name}\`, but package.json has no bin.`); }
    }
    // versions, Node, licence
    const verRe = new RegExp(`${pj.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@(\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)`, 'g');
    d.lines.forEach((l, i) => {
      for (const m of l.matchAll(verRe)) if (m[1] !== pj.version) add('version_mismatch', 'warning', rel, i + 1, `Docs pin ${pj.name}@${m[1]}; package.json is ${pj.version}.`, { find: `${pj.name}@${m[1]}`, replace: `${pj.name}@${pj.version}` });
      const node = /Node(?:\.js)?\s*(?:≥|>=|version\s+)\s*(\d+)|Node(?:\.js)?\s+(\d+)\+/i.exec(l);
      if (node && engine && (node[1] || node[2]) !== engine) add('engines_mismatch', 'warning', rel, i + 1, `Docs say Node ${node[1] || node[2]}+; package.json engines say ${pj.engines.node}.`);
      const cnt = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+tools\b/i.exec(l);
      if (cnt && tools.length) { const n = WORDS[cnt[1].toLowerCase()] ?? Number(cnt[1]); if (n !== tools.length) add('count_mismatch', 'warning', rel, i + 1, `Docs say ${cnt[1]} tools; the tool list has ${tools.length}.`); }
    });
    const licIdx = d.headings.find((h) => /^licen[cs]e$/i.test(h.text));
    if (licIdx && pj.license) { const body = d.lines.slice(licIdx.ln, licIdx.ln + 4).join(' '); const id = /\b(MIT|ISC|Apache-2\.0|BSD-[23]-Clause|GPL-[23]\.0[\w-]*|MPL-2\.0|LGPL-[\w.-]+|AGPL-[\w.-]+|Unlicense)\b/.exec(body)?.[1]; if (id && id !== pj.license) add('license_mismatch', 'warning', rel, licIdx.ln, `License section says ${id}; package.json says ${pj.license}.`); }
    // links
    for (const k of d.links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(k.href) || k.href.startsWith('//')) continue;
      const [p, anchor] = k.href.split('#');
      if (!p) { if (anchor && !d.ids.has(decodeURIComponent(anchor).toLowerCase())) add('broken_anchor', 'warning', rel, k.ln, `#${anchor} does not match any heading in ${rel}.`); continue; }
      const target = resolve(dirname(file), decodeURIComponent(p));
      if (!target.startsWith(resolve(packDir) + sep) && target !== resolve(packDir)) continue;
      if (!existsSync(target)) { add('broken_link', 'error', rel, k.ln, `Link to ${p} points at a file that does not exist.`); continue; }
      if (anchor && /\.md$/i.test(target) && statSync(target).isFile()) { const t2 = parseDoc(readFileSync(target, 'utf8')); if (!t2.ids.has(decodeURIComponent(anchor).toLowerCase())) add('broken_anchor', 'warning', rel, k.ln, `#${anchor} does not match any heading in ${p}.`); }
    }
    // skills
    if (/(^|\/)SKILL\.md$/.test(rel)) {
      const fm = frontmatter(text);
      if (!fm) add('skill_frontmatter', 'error', rel, 1, 'SKILL.md has no YAML frontmatter (--- name: ..., description: ... ---).');
      else {
        if (!fm.name) add('skill_frontmatter', 'error', rel, 1, 'Frontmatter has no name.');
        else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name) || fm.name.length > 64) add('skill_frontmatter', 'error', rel, 1, `Skill name "${fm.name}" should be lowercase words joined by hyphens, at most 64 characters.`);
        if (!fm.description) add('skill_frontmatter', 'error', rel, 1, 'Frontmatter has no description, so agents cannot tell when to use the skill.');
        else if (fm.description.length > 1024) add('skill_frontmatter', 'warning', rel, 1, `Description is ${fm.description.length} characters; keep it at or under 1024.`);
      }
    }
  }
  let api = null;
  if (openapi) { const o = checkOpenapi(parsed, openapi, openapiLabel); api = { operations: o.operations, documented: o.documented }; for (const f of o.findings) add(f.check, f.severity, f.file, f.line, f.detail); }
  const clName = readdirSync(packDir).find((n) => /^changelog\.md$/i.test(n));
  for (const f of checkChangelog(clName ? readFileSync(join(packDir, clName), 'utf8') : null, pj.version, { require: require_changelog, rel: clName || 'CHANGELOG.md' })) add(f.check, f.severity, f.file, f.line, f.detail);
  for (const t of tools) if (!mentioned.has(t.name)) add('tool_undocumented', t.decision === 'block' ? 'advisory' : 'warning', '(tool list)', null, `\`${t.name}\`${t.decision ? ` (${t.decision}${t.category ? ', ' + t.category : ''})` : ''} is in the tool list but not in any doc.`);
  const skip = new Set(ignore);
  const out = findings.filter((f) => !skip.has(f.check)).sort((a, b) => SEV[a.severity] - SEV[b.severity] || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
  const by_severity = {}; for (const f of out) by_severity[f.severity] = (by_severity[f.severity] || 0) + 1;
  return { package: pj.name, version: pj.version, docs: docs.map((f) => relative(packDir, f).split(sep).join('/')), tools: tools.length, tools_documented: [...mentioned].length, ...(api ? { openapi: api } : {}), issues: out.length, by_severity, findings: out, fixes: fixes.filter((f) => !skip.has(f.check)), limits: LIMITS };
}

/** Apply mechanical fixes (version pins, unambiguous tool-name typos) to copies, within caps. */
export function applyFixes(packDir, fixes, { maxFixes = 20, maxPerFile = 10 } = {}) {
  const byFile = new Map(); let used = 0; const skipped = [];
  for (const f of fixes) { if (used >= maxFixes) { skipped.push({ ...f, why: `over the ${maxFixes}-fix cap` }); continue; } const list = byFile.get(f.file) || []; if (list.length >= maxPerFile) { skipped.push({ ...f, why: `over the ${maxPerFile}-per-file cap` }); continue; } list.push(f); byFile.set(f.file, list); used++; }
  const files = [];
  for (const [file, list] of byFile) {
    const before = readFileSync(join(packDir, file), 'utf8'); const lines = before.split('\n'); const applied = [];
    for (const f of list) { const i = f.line - 1; if (lines[i] === undefined || !lines[i].includes(f.find)) { skipped.push({ ...f, why: 'text not found on that line' }); continue; } lines[i] = lines[i].split(f.find).join(f.replace); applied.push({ line: f.line, check: f.check, from: f.find, to: f.replace }); }
    if (applied.length) files.push({ file, before, after: lines.join('\n'), applied });
  }
  return { files, skipped };
}
