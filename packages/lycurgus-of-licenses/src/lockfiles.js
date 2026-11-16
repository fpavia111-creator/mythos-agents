// Readers for pnpm, yarn, Python and Go lockfiles. They return the package set (name,
// version, dev, link) and where each package's installed metadata lives. Lockfiles other
// than npm's do not record licenses, so licenses come from installed metadata or license
// texts. No network, no dependencies.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const unq = (s) => String(s ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');

/** A small YAML subset (nested maps, scalars, quoted keys; list items and flow maps kept as text). Enough for pnpm-lock.yaml. */
export function parseYamlLite(text) {
  const root = {}; const stack = [{ indent: -1, obj: root }];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length; const line = raw.trim();
    if (line.startsWith('- ')) continue;
    const m = /^((?:'[^']*'|"[^"]*"|[^:'"])+?):(?:\s+(.*))?$/.exec(line); if (!m) continue;
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).obj; const key = unq(m[1]);
    if (m[2] === undefined || m[2] === '') { const o = {}; parent[key] = o; stack.push({ indent, obj: o }); } else parent[key] = unq(m[2]);
  }
  return root;
}
/** "name@1.0.0", "/name@1.0.0(peer@2)", "/@scope/name/1.0.0" -> { name, version } */
export function splitPnpmKey(key) {
  const k = String(key).replace(/^\//, '').replace(/\(.*$/, '');
  const i = k.lastIndexOf('@');
  if (i > 0) return { name: k.slice(0, i), version: k.slice(i + 1) };
  const j = k.lastIndexOf('/'); return j > 0 ? { name: k.slice(0, j), version: k.slice(j + 1) } : { name: k, version: null };
}
const reach = (roots, edges) => { const seen = new Set(); const q = [...roots]; while (q.length) { const k = q.pop(); if (seen.has(k)) continue; seen.add(k); for (const n of edges(k)) q.push(n); } return seen; };

export function npmInstalledDir(projectDir, modulesDir, name, version) {
  const base = join(projectDir, modulesDir || 'node_modules');
  const direct = join(base, name);
  if (existsSync(join(direct, 'package.json'))) return direct;
  const pn = join(base, '.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name);
  return existsSync(join(pn, 'package.json')) ? pn : null;
}
const installedLicense = (dir) => { if (!dir) return undefined; try { const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); return p.license ?? p.licenses ?? null; } catch { return undefined; } };
const LINKISH = /^(link|workspace|file|portal):/;

export function readPnpm(projectDir, pj, opts = {}) {
  const text = readFileSync(join(projectDir, 'pnpm-lock.yaml'), 'utf8'); const y = parseYamlLite(text);
  const imp = (y.importers && (y.importers['.'] || Object.values(y.importers)[0])) || y;
  const ver = (v) => (v && typeof v === 'object' ? v.version : v);
  const isV9 = !!y.snapshots; const keyOf = (n, v) => (isV9 ? `${n}@${v}` : `/${n}@${v}`);
  const pkgsSection = y.packages || {}; const snaps = y.snapshots || pkgsSection;
  const edges = (k) => { const s = snaps[k] || snaps[k.replace(/^\//, '')] || {}; return Object.entries({ ...(s.dependencies || {}), ...(s.optionalDependencies || {}) }).map(([n, v]) => keyOf(n, String(ver(v)).replace(/\(.*$/, ''))); };
  const links = []; const rootsOf = (sec) => Object.entries(imp[sec] || {}).flatMap(([n, v]) => { const vv = String(ver(v)); if (LINKISH.test(vv)) { links.push(n); return []; } return [keyOf(n, vv.replace(/\(.*$/, ''))]; });
  const prod = reach([...rootsOf('dependencies'), ...rootsOf('optionalDependencies')], edges); rootsOf('devDependencies');
  const pkgs = [];
  for (const [key, v] of Object.entries(pkgsSection)) {
    const { name, version } = splitPnpmKey(key); const k = keyOf(name, version);
    const dev = typeof v.dev === 'string' ? v.dev === 'true' : isV9 ? !prod.has(k) && !prod.has(k.replace(/^\//, '')) : false;
    const dir = npmInstalledDir(projectDir, opts.modules_dir, name, version);
    pkgs.push({ key, name, version, dev, ecosystem: 'npm', dir, installed_license: installedLicense(dir) });
  }
  for (const n of [...new Set(links)]) pkgs.push({ key: `link:${n}`, name: n, version: null, link: true });
  return { pkgs, lockText: text, lockFile: 'pnpm-lock.yaml', lockVersion: String(y.lockfileVersion || '') };
}

export function readYarn(projectDir, pj, opts = {}) {
  const text = readFileSync(join(projectDir, 'yarn.lock'), 'utf8'); const berry = /^__metadata:/m.test(text);
  const blocks = []; let cur = null; let sub = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length; const line = raw.trim();
    if (indent === 0) { cur = { specs: line.replace(/:$/, '').split(/,\s*/).map((x) => x.replace(/^["']|["']$/g, '')), fields: {}, deps: {} }; blocks.push(cur); sub = null; continue; }
    if (!cur) continue;
    if (indent === 2) { const m = /^("?[^\s":]+"?):?\s*(.*)$/.exec(line); if (!m) continue; const k = unq(m[1]); if (!m[2]) { sub = k; continue; } sub = null; cur.fields[k] = unq(m[2]); continue; }
    if (sub === 'dependencies' || sub === 'optionalDependencies') { const m = /^("?[^\s"]+?"?):?\s+(.+)$/.exec(line); if (m) cur.deps[unq(m[1])] = unq(m[2]); }
  }
  const bySpec = new Map(); for (const b of blocks) for (const s of b.specs) bySpec.set(s, b);
  const nameOf = (spec) => { const i = spec.lastIndexOf('@'); return i > 0 ? spec.slice(0, i) : spec; };
  const find = (n, range) => bySpec.get(`${n}@${range}`) || bySpec.get(`${n}@npm:${range}`);
  const links = []; const roots = (sec) => Object.entries(pj[sec] || {}).flatMap(([n, r]) => { if (LINKISH.test(String(r))) { links.push(n); return []; } const b = find(n, r); return b ? [b] : []; });
  const prod = reach(roots('dependencies').concat(roots('optionalDependencies')), (b) => Object.entries(b.deps).map(([n, r]) => find(n, r)).filter(Boolean)); roots('devDependencies');
  const pkgs = [];
  for (const b of blocks) {
    if (b.specs[0] === '__metadata') continue;
    const name = nameOf(b.specs[0]).replace(/@npm$/, ''); const res = b.fields.resolution || '';
    if (/@workspace:|@link:|@portal:|@file:/.test(res) || /@workspace:|@link:/.test(b.specs[0]) || b.fields.linkType === 'soft') { if (!/@workspace:\.$/.test(res) && !/@workspace:\.$/.test(b.specs[0])) links.push(name); continue; }
    const version = b.fields.version || null; const dir = npmInstalledDir(projectDir, opts.modules_dir, name, version);
    pkgs.push({ key: b.specs[0], name, version, dev: !prod.has(b), ecosystem: 'npm', dir, installed_license: installedLicense(dir) });
  }
  for (const n of [...new Set(links)]) pkgs.push({ key: `link:${n}`, name: n, version: null, link: true });
  return { pkgs, lockText: text, lockFile: 'yarn.lock', lockVersion: berry ? 'berry' : '1' };
}

// ---------- Python ----------
export const pyNorm = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
export function readTomlTables(text) {
  // Minimal TOML: [[package]] / [table] headers and key = value lines (strings, arrays of strings, inline tables kept as text).
  const out = []; let cur = { _table: '', _array: false }; out.push(cur);
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    let m = /^\[\[([^\]]+)\]\]$/.exec(line); if (m) { cur = { _table: m[1].trim(), _array: true }; out.push(cur); continue; }
    m = /^\[([^\]]+)\]$/.exec(line); if (m) { cur = { _table: m[1].trim(), _array: false }; out.push(cur); continue; }
    m = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line); if (!m) continue;
    const v = m[2].trim(); cur[unq(m[1])] = v.startsWith('[') ? [...v.matchAll(/"([^"]*)"/g)].map((x) => x[1]) : unq(v);
  }
  return out;
}
export function parseMetadata(text) {
  const head = String(text).split(/\r?\n\r?\n/)[0]; const fields = {}; let last = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && last) { fields[last][fields[last].length - 1] += '\n' + line.trim(); continue; }
    const m = /^([A-Za-z-]+):\s?(.*)$/.exec(line); if (!m) continue; last = m[1].toLowerCase(); (fields[last] ||= []).push(m[2]);
  }
  return fields;
}
const CLASSIFIERS = { 'mit license': 'MIT', 'apache software license': 'Apache-2.0', 'isc license (iscl)': 'ISC', 'bsd license': 'BSD-UNSPECIFIED', 'mozilla public license 2.0 (mpl 2.0)': 'MPL-2.0', 'gnu general public license v2 (gplv2)': 'GPL-2.0-only', 'gnu general public license v3 (gplv3)': 'GPL-3.0-only', 'gnu general public license v2 or later (gplv2+)': 'GPL-2.0-or-later', 'gnu general public license v3 or later (gplv3+)': 'GPL-3.0-or-later', 'gnu lesser general public license v2 (lgplv2)': 'LGPL-2.0-only', 'gnu lesser general public license v2 or later (lgplv2+)': 'LGPL-2.0-or-later', 'gnu lesser general public license v3 (lgplv3)': 'LGPL-3.0-only', 'gnu lesser general public license v3 or later (lgplv3+)': 'LGPL-3.0-or-later', 'gnu affero general public license v3': 'AGPL-3.0-only', 'gnu affero general public license v3 or later (agplv3+)': 'AGPL-3.0-or-later', 'the unlicense (unlicense)': 'Unlicense', 'public domain': 'LicenseRef-Public-Domain', 'python software foundation license': 'PSF-2.0', 'zero-clause bsd (0bsd)': '0BSD', 'creative commons attribution 4.0 international (cc by 4.0)': 'CC-BY-4.0', 'other/proprietary license': 'UNLICENSED' };
/** License from a dist-info METADATA: License-Expression, then License (if short), then classifiers. */
export function pyLicense(fields) {
  if (fields['license-expression']?.[0]) return { value: fields['license-expression'][0].trim(), via: 'License-Expression' };
  const lic = (fields.license?.[0] || '').trim();
  if (lic && lic.length <= 60 && !/\n/.test(lic) && !/^unknown$/i.test(lic)) return { value: lic, via: 'License' };
  const cls = (fields.classifier || []).map((c) => /^License :: (?:OSI Approved :: )?(.+)$/.exec(c)).filter(Boolean).map((m) => m[1].trim()).filter((c) => c !== 'OSI Approved');
  const ids = [...new Set(cls.map((c) => CLASSIFIERS[c.toLowerCase()] || `LicenseRef-Classifier-${c.replace(/[^A-Za-z0-9.]+/g, '-')}`))];
  if (ids.length) return { value: ids.join(' OR '), via: `classifier${ids.length > 1 ? 's' : ''}`, normalized: true };
  if (lic && !/^unknown$/i.test(lic)) return { value: null, via: 'License text in METADATA', text: lic };
  return { value: null, via: 'none' };
}
function findSitePackages(projectDir, opts) {
  const cands = opts.site_packages ? [join(projectDir, opts.site_packages)] : [];
  for (const v of ['.venv', 'venv', 'env']) { const lib = join(projectDir, v, 'lib'); if (existsSync(lib)) for (const py of readdirSync(lib)) cands.push(join(lib, py, 'site-packages')); cands.push(join(projectDir, v, 'Lib', 'site-packages')); }
  cands.push(join(projectDir, 'site-packages'));
  return cands.find((d) => existsSync(d) && statSync(d).isDirectory()) || null;
}
export function readPython(projectDir, opts = {}) {
  const lockFile = ['poetry.lock', 'uv.lock', 'requirements.txt'].find((f) => existsSync(join(projectDir, f)));
  const text = readFileSync(join(projectDir, lockFile), 'utf8'); const pkgs = [];
  if (lockFile === 'requirements.txt') {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim(); if (!line || /^-(r|c|i|-index|-extra)/.test(line)) continue;
      const e = /^-e\s+(.+)$/.exec(line) || /^(\.{1,2}\/.+|file:.+)$/.exec(line); if (e) { pkgs.push({ key: line, name: e[1].replace(/.*[\\/#=]/, ''), version: null, link: true }); continue; }
      const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:==\s*([^\s;]+))?/.exec(line); if (m) pkgs.push({ key: m[1], name: m[1], version: m[2] || null, dev: false });
    }
  } else {
    const tables = readTomlTables(text); let p = null;
    for (const t of tables) {
      if (t._table === 'package' && t._array) { p = { key: t.name, name: t.name, version: t.version || null, dev: Array.isArray(t.groups) ? !t.groups.includes('main') : t.category ? t.category === 'dev' : false }; if (t.source && /editable|directory|virtual|path/.test(t.source)) p.link = true; pkgs.push(p); }
      else if (t._table === 'package.source' && p && /^(directory|file|path)$/.test(t.type || '')) p.link = true;
    }
  }
  const sp = findSitePackages(projectDir, opts); const dist = new Map();
  if (sp) for (const d of readdirSync(sp)) { const m = /^(.+?)-([^-]+)\.dist-info$/.exec(d); if (m) dist.set(pyNorm(m[1]), join(sp, d)); }
  for (const p of pkgs) {
    if (p.link) continue; p.ecosystem = 'pypi'; const dir = dist.get(pyNorm(p.name)) || null; p.dir = dir;
    if (dir && existsSync(join(dir, 'METADATA'))) { const f = parseMetadata(readFileSync(join(dir, 'METADATA'), 'utf8')); const l = pyLicense(f); p.installed_license = l.value; p.installed_via = l.via; p.installed_normalized = !!l.normalized; p.metadata_text = l.text || null; if (!p.version) p.version = f.version?.[0] || null; }
  }
  return { pkgs, lockText: text, lockFile, lockVersion: lockFile, sitePackages: sp };
}
export function pyProjectMeta(projectDir) {
  const f = join(projectDir, 'pyproject.toml'); if (!existsSync(f)) return { name: null, version: null, license: null };
  const t = readTomlTables(readFileSync(f, 'utf8')); const proj = t.find((x) => x._table === 'project') || t.find((x) => x._table === 'tool.poetry') || {};
  const lic = proj.license ? (/text\s*=\s*"([^"]+)"/.exec(proj.license)?.[1] || proj.license) : null;
  return { name: proj.name || null, version: proj.version || null, license: lic };
}

// ---------- Go ----------
export function readGo(projectDir) {
  const gomod = readFileSync(join(projectDir, 'go.mod'), 'utf8'); const module = (/^module\s+(\S+)/m.exec(gomod) || [])[1] || null;
  const reqs = []; let inReq = false; const replaced = new Set();
  for (const raw of gomod.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim(); const indirect = /\/\/\s*indirect/.test(raw);
    if (/^require\s*\($/.test(line)) { inReq = true; continue; } if (inReq && line === ')') { inReq = false; continue; }
    const m = inReq ? /^(\S+)\s+(\S+)$/.exec(line) : /^require\s+(\S+)\s+(\S+)$/.exec(line); if (m) reqs.push({ path: m[1], version: m[2], indirect });
    const r = /^replace\s+(\S+)(?:\s+\S+)?\s+=>\s+(\.{1,2}\/\S*|\/\S+)/.exec(line); if (r) replaced.add(r[1]);
  }
  const mt = join(projectDir, 'vendor', 'modules.txt'); let list = reqs; let lockText = gomod; let lockFile = 'go.mod';
  if (existsSync(mt)) { lockText = readFileSync(mt, 'utf8'); lockFile = 'vendor/modules.txt'; list = [...lockText.matchAll(/^# (\S+) (\S+)(?: => (\S+))?/gm)].map((m) => ({ path: m[1], version: m[2], local: m[3] && /^\.|^\//.test(m[3]) })); }
  const pkgs = list.map((x) => (x.local || replaced.has(x.path) ? { key: x.path, name: x.path, version: null, link: true } : { key: x.path, name: x.path, version: x.version, dev: false, ecosystem: 'golang', dir: existsSync(join(projectDir, 'vendor', x.path)) ? join(projectDir, 'vendor', x.path) : null, installed_license: undefined }));
  return { pkgs, lockText, lockFile, lockVersion: lockFile === 'go.mod' ? 'go.mod' : 'modules.txt', module };
}
