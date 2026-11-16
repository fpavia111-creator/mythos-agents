// Extra drift checks: OpenAPI endpoints vs the docs, and CHANGELOG vs package.json version.
// Reads files only; nothing is fetched or run.

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const normPath = (p) => {
  let s = String(p).split(/[?#]/)[0].replace(/\{[^}/]+\}|:[A-Za-z_][\w-]*|<[^>/]+>/g, '{}');
  s = s.replace(/\/+$/, ''); return s || '/';
};

/** Operations in an OpenAPI 3.x / Swagger 2.0 document (JSON). */
export function specOperations(spec) {
  if (!spec || typeof spec !== 'object' || !(spec.openapi || spec.swagger) || typeof spec.paths !== 'object') throw new Error('openapi file must be an OpenAPI 3.x or Swagger 2.0 document in JSON with "paths"');
  let base = '';
  const server = (spec.servers || [])[0]?.url; if (server) { const m = /^(?:[a-z]+:\/\/[^/]+)?(\/[^?#]*)/i.exec(server); if (m && m[1] !== '/') base = m[1].replace(/\/+$/, ''); }
  if (spec.basePath && spec.basePath !== '/') base = spec.basePath.replace(/\/+$/, '');
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths)) for (const m of METHODS) if (item && item[m]) ops.push({ method: m.toUpperCase(), path, key: `${m.toUpperCase()} ${normPath(path)}`, operationId: item[m].operationId || null, deprecated: !!item[m].deprecated });
  return { base, ops, title: spec.info?.title || null, version: spec.info?.version || null };
}

const ENDPOINT = /(?:^|[\s`|("'])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+`?(?:https?:\/\/[^\s/`]+)?(\/[A-Za-z0-9_\-./{}:<>~%]*)/g;
const CURL = /\bcurl\b[^\n]*?-X\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[^\n]*?(?:https?:\/\/[^\s/'"]+)(\/[A-Za-z0-9_\-./{}:<>~%]*)/g;

/** Endpoints mentioned in doc lines: "GET /notes/{id}", "`POST /v1/notes`", "curl -X DELETE https://h/notes/1". */
export function docEndpoints(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const seen = new Set();
    for (const re of [ENDPOINT, CURL]) for (const m of l.matchAll(re)) { const path = m[2].replace(/[.,;:)`]+$/, ''); const k = `${m[1]} ${path}`; if (seen.has(k) || path === '/') continue; seen.add(k); out.push({ line: i + 1, method: m[1], path, text: l }); }
  });
  return out;
}

/**
 * docs: [{ rel, lines }]. Returns findings for endpoints in the docs that the spec does not have,
 * spec operations no doc mentions, and deprecated operations documented without saying so.
 */
export function checkOpenapi(docs, spec, specLabel = 'the OpenAPI spec') {
  const { base, ops } = specOperations(spec);
  const byKey = new Map(ops.map((o) => [o.key, o]));
  const byPath = new Map(); for (const o of ops) { const p = o.key.slice(o.method.length + 1); byPath.set(p, [...(byPath.get(p) || []), o.method]); }
  const findings = []; const mentioned = new Set();
  const strip = (p) => { const n = normPath(p); return base && (n === base || n.startsWith(base + '/')) ? normPath(n.slice(base.length) || '/') : n; };
  for (const d of docs) for (const e of docEndpoints(d.lines)) {
    let p = strip(e.path);
    if (!byPath.has(p)) { const seg = p.split('/'); const hit = [...byPath.keys()].find((sp) => { const t = sp.split('/'); return t.length === seg.length && t.every((x, i) => x === seg[i] || (x === '{}' && seg[i] !== '')); }); if (hit) p = hit; }
    const key = `${e.method} ${p}`; const op = byKey.get(key);
    if (op) {
      mentioned.add(key);
      if (op.deprecated && !/deprecat/i.test(e.text)) findings.push({ check: 'endpoint_deprecated', severity: 'advisory', file: d.rel, line: e.line, detail: `\`${e.method} ${e.path}\` is deprecated in ${specLabel}; the docs do not say so.` });
      continue;
    }
    const other = byPath.get(p);
    if (other) findings.push({ check: 'endpoint_method_mismatch', severity: 'error', file: d.rel, line: e.line, detail: `Docs use \`${e.method} ${e.path}\`; ${specLabel} has ${other.map((m) => `\`${m}\``).join(', ')} for that path.` });
    else findings.push({ check: 'endpoint_not_in_spec', severity: 'error', file: d.rel, line: e.line, detail: `\`${e.method} ${e.path}\` is not in ${specLabel}.` });
  }
  for (const o of ops) if (!mentioned.has(o.key)) findings.push({ check: 'endpoint_undocumented', severity: o.deprecated ? 'advisory' : 'warning', file: '(openapi)', line: null, detail: `\`${o.method} ${base}${o.path}\`${o.operationId ? ` (${o.operationId})` : ''}${o.deprecated ? ', deprecated,' : ''} is in ${specLabel} but not in any doc.` });
  return { findings, operations: ops.length, documented: mentioned.size };
}

const VER = /^#{1,3}\s*\[?v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\]?(?=[\s\-–—(]|$)/;
const cmp = (a, b) => { const pa = a.split(/[.-]/); const pb = b.split(/[.-]/); for (let i = 0; i < 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d; } return (pa.length > 3 ? -1 : 0) - (pb.length > 3 ? -1 : 0); };

/** Changelog vs package.json version. text is null when there is no CHANGELOG.md. */
export function checkChangelog(text, version, { require = false, rel = 'CHANGELOG.md' } = {}) {
  if (text === null) return require ? [{ check: 'changelog_missing', severity: 'warning', file: '(package)', line: null, detail: `No CHANGELOG.md; version ${version} has no release notes.` }] : [];
  const entries = []; String(text).split('\n').forEach((l, i) => { const m = VER.exec(l.trim()); if (m) entries.push({ version: m[1], line: i + 1 }); });
  const out = [];
  if (!entries.some((e) => e.version === version)) out.push({ check: 'changelog_missing_entry', severity: 'warning', file: rel, line: entries[0]?.line ?? 1, detail: `package.json is ${version}, but ${rel} has no entry for it${entries.length ? ` (latest entry: ${entries[0].version})` : ''}. A version bump needs release notes.` });
  const ahead = entries.filter((e) => cmp(e.version, version) > 0);
  for (const e of ahead) out.push({ check: 'changelog_ahead', severity: 'advisory', file: rel, line: e.line, detail: `${rel} has an entry for ${e.version}, newer than package.json ${version}.` });
  const seen = new Map(); for (const e of entries) { if (seen.has(e.version)) out.push({ check: 'changelog_duplicate', severity: 'warning', file: rel, line: e.line, detail: `${e.version} has two entries (also line ${seen.get(e.version)}).` }); else seen.set(e.version, e.line); }
  return out;
}
