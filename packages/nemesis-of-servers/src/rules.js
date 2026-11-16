import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { RULES, enrich } from './catalog.js';
import { scanFlows } from './flow.js';
import { applyPolicy, ignored } from './policy.js';
import { matchAdvisories } from './advisories.js';

const T = (id) => RULES[id].title;
const W = (id) => RULES[id].why;

/** Source rules. Pattern-based: they find things to look at, they do not prove a server is safe or unsafe. */
export const SOURCE_RULES = [
  { id: 'NEM-EXEC-SHELL', re: /(?<![.\w$])(execSync|exec|spawnSync|spawn|execFile|execFileSync)\s*\(|\b(child_process|childProcess|cp)(['"]\))?\.(execSync|exec|spawnSync|spawn|execFile|execFileSync)\s*\(|shell\s*:\s*true|subprocess\.(run|Popen|call)|os\.system\(/ },
  { id: 'NEM-EVAL', re: /\beval\s*\(|new\s+Function\s*\(|\bvm\.(runIn\w*|Script)\b|\bexec\s*\(\s*compile\(/ },
  { id: 'NEM-CODEMODE-NOSANDBOX', re: /(execute|runCode|run_code|codeMode)[\s\S]{0,120}(new\s+Function|eval\s*\(|vm\.runIn)/ },
  { id: 'NEM-ENV-DUMP', re: /JSON\.stringify\(\s*process\.env\s*\)|\.\.\.process\.env\b|os\.environ\.copy\(\)|dict\(os\.environ\)/ },
  { id: 'NEM-CRED-PATH', re: /\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.netrc|\.docker\/config\.json|\.kube\/config|\.config\/gcloud/ },
  { id: 'NEM-HARDCODED-SECRET', re: /(sk_live_[0-9a-zA-Z]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)/, mask: true },
  { id: 'NEM-INJECTION-TEXT', re: /ignore (all )?(previous|prior) instructions|disregard (all )?(previous|prior) (instructions|rules)|do not (tell|inform|mention) (this to )?the user|without (asking|telling|informing) the user|<\s*(important|system|instructions)\s*>/i },
  { id: 'NEM-INVISIBLE-UNICODE', re: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u },
  { id: 'NEM-OPEN-EGRESS', re: /\bfetch\s*\(|\baxios\b|\bhttps?\.request\s*\(|requests\.(get|post|put)\(|urllib\.request|new\s+WebSocket\(/ },
  { id: 'NEM-PLAIN-HTTP', re: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^"'`\s]+/ },
  { id: 'NEM-FS-WRITE', re: /\b(writeFileSync|writeFile|appendFileSync|rmSync|unlinkSync|rmdirSync|rm\s*\(|unlink\s*\()|shutil\.rmtree|os\.remove\(/ },
  { id: 'NEM-NO-PATH-GUARD', re: /(join|resolve)\([^)]*(args|input|params|request)\.[a-zA-Z_]+/ },
  { id: 'NEM-TLS-DISABLED', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0|verify\s*=\s*False|ssl\._create_unverified_context/ },
  { id: 'NEM-BIND-ALL', re: /\.listen\([^)]*['"]0\.0\.0\.0['"]|\bhost\s*[=:]\s*['"]0\.0\.0\.0['"]|--host[= ]0\.0\.0\.0/ },
  { id: 'NEM-CORS-ANY', re: /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]|\borigin\s*:\s*['"]\*['"]|\bcors\(\s*\)|allow_origins\s*=\s*\[\s*['"]\*['"]\s*\]/ },
  { id: 'NEM-UNSAFE-DESERIALIZE', re: /\bpickle\.loads?\(|\byaml\.load\((?![^)]*SafeLoader)|\bmarshal\.loads\(|\bunserialize\(/ },
  { id: 'NEM-SQL-CONCAT', re: /`[^`]*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^`]*\$\{|\bf"[^"]*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^"]*\{|\bf'[^']*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^']*\{|["'][^"']*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^"']*["']\s*\+\s*[A-Za-z_]/ },
].map((r) => ({ ...r, severity: RULES[r.id].severity, title: T(r.id), why: W(r.id) }));

const DOC_RULES = new Set(['NEM-INJECTION-TEXT', 'NEM-INVISIBLE-UNICODE', 'NEM-HARDCODED-SECRET', 'NEM-PLAIN-HTTP']);
const SECRET_RE = SOURCE_RULES.find((r) => r.id === 'NEM-HARDCODED-SECRET').re;

const maskLine = (l) => l.replace(/([A-Za-z0-9_\-]{4})[A-Za-z0-9_\-]{8,}/g, '$1••••').slice(0, 200);
/** Code excerpt for reports: secrets masked, length capped. */
export const snippetOf = (line) => (SECRET_RE.test(line) ? maskLine(line.trim()) : line.trim().slice(0, 200));

export const PKG_RULES = (pkg) => {
  const out = [];
  const s = pkg.scripts || {};
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) if (s[k]) out.push({ id: 'NEM-INSTALL-SCRIPT', severity: k === 'prepare' ? 'low' : 'medium', title: `Has a ${k} script`, detail: s[k], why: W('NEM-INSTALL-SCRIPT') });
  for (const [sec, deps] of Object.entries({ dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies })) {
    for (const [n, v] of Object.entries(deps || {})) {
      if (/^(\*|latest|x|)$/.test(String(v).trim())) out.push({ id: 'NEM-UNPINNED-DEP', severity: 'medium', title: `Unpinned ${sec.replace(/ies$/, 'y')} ${n}@${v || '(empty)'}`, why: W('NEM-UNPINNED-DEP'), package: n });
      else if (/^(git|github:|https?:)/.test(String(v))) out.push({ id: 'NEM-URL-DEP', severity: 'medium', title: `${n} installs from ${v}`, why: W('NEM-URL-DEP'), package: n });
    }
  }
  return out;
};

/** Files ending in .sample are scanned as their underlying type (e.g. server.js.sample), so risky test fixtures need not ship as runnable code. */
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.py', '.json', '.md', '.yaml', '.yml']);
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const unsample = (n) => n.replace(/\.sample$/i, '');

export function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'].includes(name)) continue;
    const p = join(dir, name); const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SRC_EXT.has(extname(unsample(name)).toLowerCase()) && st.size < 2_000_000) out.push(p);
  }
  return out;
}

const lineOf = (text, needle) => { const i = text.indexOf(needle); return i < 0 ? 1 : text.slice(0, i).split('\n').length; };

/** Lockfile, requirements and advisory checks for the folder's top level. */
function supplyChain(dir, advisories, findings) {
  const files = readdirSync(dir);
  const has = (n) => files.find((f) => unsample(f) === n);
  const pkgFile = has('package.json');
  let pkg = null; try { pkg = pkgFile ? JSON.parse(readFileSync(join(dir, pkgFile), 'utf8')) : null; } catch { pkg = null; }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) } : {};
  const lock = LOCKFILES.map(has).find(Boolean);
  if (pkg && Object.keys(deps).length && !lock) findings.push({ id: 'NEM-NO-LOCKFILE', file: pkgFile, line: 1, title: `${Object.keys(deps).length} dependenc${Object.keys(deps).length === 1 ? 'y' : 'ies'} and no lockfile` });
  const versions = []; // { name, version, file, line }
  const lockName = lock && unsample(lock);
  if (lockName === 'package-lock.json' || lockName === 'npm-shrinkwrap.json') {
    const text = readFileSync(join(dir, lock), 'utf8');
    let j = null; try { j = JSON.parse(text); } catch { j = null; }
    const entries = j?.packages ? Object.entries(j.packages).filter(([k]) => k).map(([k, v]) => [k.replace(/^.*node_modules\//, ''), v, k])
      : Object.entries(j?.dependencies || {}).map(([k, v]) => [k, v, k]);
    for (const [name, v, key] of entries) {
      const line = lineOf(text, `"${key}"`);
      if (v.link) continue;
      versions.push({ name, version: v.version, file: lock, line });
      const res = String(v.resolved || '');
      if (res && !/^https:\/\/registry\.npmjs\.org\//.test(res) && !/^file:/.test(res)) findings.push({ id: 'NEM-LOCK-NONREGISTRY', file: lock, line, title: `${name} resolves from ${res.replace(/^(\w+:\/\/[^/]+|[^:]+:[^/#]+).*$/, '$1')}`, package: name });
      if (res && !v.integrity && !/^git/.test(res)) findings.push({ id: 'NEM-LOCK-NO-INTEGRITY', file: lock, line, title: `${name}@${v.version} has no integrity hash`, package: name });
    }
  } else if (pkg) {
    for (const [name, v] of Object.entries(deps)) if (/^\d+\.\d+\.\d+/.test(String(v))) versions.push({ name, version: String(v), file: pkgFile, line: lineOf(readFileSync(join(dir, pkgFile), 'utf8'), `"${name}"`) });
  }
  for (const x of versions) for (const a of matchAdvisories(advisories, 'npm', x.name, x.version)) findings.push({ id: 'NEM-ADVISORY', severity: a.severity || 'high', file: x.file, line: x.line, title: `${x.name}@${x.version}: ${a.id}${a.fixed ? ` (fixed in ${a.fixed})` : ''}`, why: a.summary, advisory: { id: a.id, url: a.url || null, fixed: a.fixed || null }, package: x.name });
  const req = has('requirements.txt');
  if (req) {
    const text = readFileSync(join(dir, req), 'utf8');
    text.split(/\r?\n/).forEach((raw, i) => {
      const l = raw.replace(/#.*$/, '').trim();
      if (!l || l.startsWith('-')) return;
      const m = /^([A-Za-z0-9_.\-\[\]]+)\s*(==|===|>=|<=|~=|>|<|!=)?\s*([^;\s]*)/.exec(l); if (!m) return;
      const name = m[1].replace(/\[.*\]$/, '');
      if (m[2] !== '==' && m[2] !== '===') findings.push({ id: 'NEM-PY-UNPINNED', file: req, line: i + 1, title: `${name} is not pinned with ==`, package: name, snippet: l.slice(0, 120) });
      else for (const a of matchAdvisories(advisories, 'pypi', name, m[3])) findings.push({ id: 'NEM-ADVISORY', severity: a.severity || 'high', file: req, line: i + 1, title: `${name}==${m[3]}: ${a.id}${a.fixed ? ` (fixed in ${a.fixed})` : ''}`, why: a.summary, advisory: { id: a.id, url: a.url || null, fixed: a.fixed || null }, package: name });
    });
  }
}

/**
 * Scan a server folder. opts: { advisories: [..] (offline list), policy: {..} (nemesis-policy) }.
 */
export function scanSource(dir, opts = {}) {
  const findings = [];
  const policy = opts.policy || null;
  const files = walk(dir).filter((f) => !ignored(policy, relative(dir, f).split('\\').join('/')));
  for (const f of files) {
    const rel = relative(dir, f).split('\\').join('/');
    const base = unsample(basename(f));
    const text = readFileSync(f, 'utf8');
    if (base === 'package.json') {
      try { for (const x of PKG_RULES(JSON.parse(text))) findings.push({ ...x, file: rel, line: x.package ? lineOf(text, `"${x.package}"`) : lineOf(text, `"${x.title.split(' ')[2]}"`) }); } catch { /* not JSON */ }
      continue;
    }
    if (LOCKFILES.includes(base)) continue;
    const isDoc = /\.(md|ya?ml|json)$/i.test(unsample(f));
    text.split(/\r?\n/).forEach((line, i) => {
      for (const r of SOURCE_RULES) {
        if (isDoc && !DOC_RULES.has(r.id)) continue;
        if (r.re.test(line)) findings.push({ id: r.id, severity: r.severity, title: r.title, why: r.why, file: rel, line: i + 1, snippet: r.mask ? maskLine(line.trim()) : snippetOf(line) });
      }
    });
    if (!isDoc) {
      for (const fl of scanFlows(text, { snippet: snippetOf })) findings.push({ id: fl.id, file: rel, line: fl.line, snippet: fl.flow[fl.flow.length - 1].code, flow: fl.flow, title: `${T(fl.id)}: ${[...new Set(fl.flow.map((s) => s.line))].map((n) => `line ${n}`).join(' -> ')}` });
    }
    // whole-file rules
    const usesWrite = /writeFile|rmSync|unlink|shutil\.rmtree|os\.remove/.test(text);
    if (!isDoc && usesWrite && !/approv|confirm|human|ask/i.test(text)) findings.push({ id: 'NEM-WRITE-NO-APPROVAL', file: rel, line: 0 });
    const usesExec = SOURCE_RULES[0].re.test(text);
    if (!isDoc && usesExec && !/(allow|whitelist|permit)(ed)?(List|_list|Commands)?/i.test(text)) findings.push({ id: 'NEM-EXEC-NO-ALLOWLIST', file: rel, line: 0 });
  }
  supplyChain(dir, opts.advisories || [], findings);
  return summarize(findings, { scanned: files.length }, policy);
}

const AUTO_KEYS = ['alwaysAllow', 'autoApprove', 'auto_approve', 'autoApproveTools'];
const RISKY_VERB = /(^|[_\-.])(delete|remove|drop|destroy|purge|wipe|write|update|create|send|post|transfer|pay|deploy|exec|execute|run|shell|kill|revoke|push|merge|move|edit)([_\-.]|$)|^(delete|remove|write|send|run|exec|execute|create|update|deploy|push|edit)[A-Z]/i;

/**
 * Review an MCP client config (mcpServers / servers). opts: { text (raw JSON for line numbers), file, advisories, policy }.
 */
export function scanConfig(json, opts = {}) {
  const servers = json.mcpServers || json.servers || json.mcp?.servers || json.context_servers || {};
  const findings = [];
  const text = opts.text || '';
  const seenRun = new Map();
  for (const [name, s] of Object.entries(servers)) {
    const line = text ? lineOf(text, `"${name}"`) : 0;
    const add = (id, severity, title, why, extra = {}) => findings.push({ id, severity, title, why: why || W(id), server: name, ...(opts.file ? { file: opts.file, line } : {}), ...extra });
    const cmd = String(s.command || ''); const args = (s.args || []).map(String); const all = [cmd, ...args].join(' ');
    const url = s.url || s.serverUrl || s.httpUrl;
    if (url) {
      if (/^http:\/\//i.test(url) && !/localhost|127\.0\.0\.1/.test(url)) add('NEM-CFG-PLAIN-HTTP', 'high', `Remote server over plain http (${url})`, 'Use https for remote MCP servers.');
      if (s.headers && Object.values(s.headers).some((v) => /^Bearer\s+[A-Za-z0-9._-]{16,}$/.test(String(v)))) add('NEM-CFG-INLINE-TOKEN', 'high', 'Bearer token written into the config', 'Reference an environment variable instead of pasting the token.');
    }
    if (/\b(npx|bunx|pnpm\s+dlx|uvx)\b/.test(cmd) || ['npx', 'bunx', 'uvx'].includes(cmd)) {
      const pkgArg = args.find((a) => !a.startsWith('-') && a !== 'dlx');
      if (pkgArg && !/@\d|==\d/.test(pkgArg.replace(/^@[^/]+\//, ''))) add('NEM-CFG-UNPINNED', 'medium', `Runs ${pkgArg} without a pinned version`, 'Pin an exact version (pkg@1.2.3) so a new release cannot change what runs.');
      if (pkgArg && /@latest\b/.test(pkgArg)) add('NEM-CFG-LATEST', 'medium', `Runs ${pkgArg}`, '@latest is not a pin.');
      const m = pkgArg && (/^(@[^/@]+\/[^@]+|[^@=]+)@(\d[^\s]*)$/.exec(pkgArg) || /^([^=]+)==(\d[^\s]*)$/.exec(pkgArg));
      if (m) for (const a of matchAdvisories(opts.advisories || [], /==/.test(pkgArg) || cmd === 'uvx' ? 'pypi' : 'npm', m[1], m[2])) add('NEM-CFG-ADVISORY', a.severity || 'high', `${m[1]}@${m[2]}: ${a.id}${a.fixed ? ` (fixed in ${a.fixed})` : ''}`, a.summary, { advisory: { id: a.id, url: a.url || null, fixed: a.fixed || null } });
    }
    const launch = url ? `url:${url}` : cmd ? `${cmd} ${args.filter((a) => a !== '-y' && a !== '--yes').join(' ')}`.trim() : '';
    if (launch && seenRun.has(launch)) add('NEM-CFG-DUPLICATE', 'medium', `Starts exactly the same server as "${seenRun.get(launch)}"`); else if (launch) seenRun.set(launch, name);
    if (/curl[^|]*\|\s*(ba|z)?sh|wget[^|]*\|\s*(ba|z)?sh/.test(all)) add('NEM-CFG-PIPE-SH', 'high', 'Pipes a download into a shell', 'Anything at that URL runs on your machine.');
    if (/^(bash|sh|zsh|cmd|powershell|pwsh)$/i.test(cmd) && args.some((a) => /^(-c|\/c|-Command)$/i.test(a))) add('NEM-CFG-SHELL-WRAP', 'medium', 'Starts the server through a shell string', 'Shell strings are hard to review; run the binary directly.');
    if (/\bsudo\b/.test(all)) add('NEM-CFG-SUDO', 'high', 'Runs with sudo', 'An MCP server should never need root.');
    if (/docker/.test(cmd) && /--privileged|-v\s*\/:\/|--network[= ]host|\/var\/run\/docker\.sock/.test(all)) add('NEM-CFG-DOCKER-BROAD', 'high', 'Docker with privileged mode, host network, root mount or the Docker socket', 'This removes most of the container boundary.');
    if (args.some((a) => a === '/' || a === '~' || a === '$HOME' || /^[A-Z]:\\?$/i.test(a))) add('NEM-CFG-BROAD-ROOT', 'high', 'Filesystem root or home folder passed as an argument', 'Scope the server to one project folder.');
    const skip = args.find((a) => /^--?(dangerously-skip-permissions|allow-all|allow-all-tools|yolo|no-sandbox|disable-sandbox|unsafe|trust-all)\b/i.test(a));
    if (skip) add('NEM-CFG-SKIP-PERMS', 'high', `Started with ${skip}`);
    for (const [k, v] of Object.entries(s.env || {})) {
      if (/(KEY|TOKEN|SECRET|PASSWORD|PASS)$/i.test(k) && v && !/^\$\{?[A-Z_]+\}?$|^\$env:|^<.*>$/.test(String(v))) add('NEM-CFG-INLINE-SECRET', 'high', `Secret value written inline for ${k} (value not shown)`, 'Keep secrets in your OS keychain or a secrets manager, not in a config file.');
    }
    if (s.trust === true) add('NEM-CFG-AUTO-APPROVE', 'high', 'trust: true auto-approves every tool on this server');
    for (const k of AUTO_KEYS) {
      const list = Array.isArray(s[k]) ? s[k].map(String) : [];
      if (!list.length) continue;
      const risky = list.filter((t) => t === '*' || RISKY_VERB.test(t));
      add('NEM-CFG-AUTO-APPROVE', risky.length ? 'high' : 'low', risky.length ? `${k} skips confirmation for state-changing tools: ${risky.join(', ')}` : `${k} skips confirmation for ${list.length} tool(s): ${list.join(', ')}`, undefined, { tools: list });
    }
  }
  return summarize(findings, { servers: Object.keys(servers).length }, opts.policy || null);
}

const ORDER = { high: 0, medium: 1, low: 2 };
export function verdictOf(by) { return by.high ? 'review_before_use' : by.medium ? 'review_recommended' : 'no_pattern_findings'; }
export function countBy(items) { const by = { high: 0, medium: 0, low: 0 }; for (const f of items) by[f.severity]++; return by; }
export function sortFindings(findings) {
  return findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || String(a.file || a.server || '').localeCompare(String(b.file || b.server || '')) || (a.line || 0) - (b.line || 0) || a.id.localeCompare(b.id));
}

export function summarize(findings, extra, policy = null) {
  const enriched = findings.map(enrich);
  const { items, suppressed } = applyPolicy(enriched, policy);
  const by = countBy(items);
  sortFindings(items);
  return { ...extra, findings: items.length, by_severity: by, verdict: verdictOf(by), items, suppressed, note: 'Static, pattern-based review. No findings does not mean the server is safe; findings are places a person should read.' };
}

export { sarif } from './sarif.js';
export { reportMarkdown } from './report.js';
