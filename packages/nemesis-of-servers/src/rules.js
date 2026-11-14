import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

/** Source rules. Pattern-based: they find things to look at, they do not prove a server is safe or unsafe. */
export const SOURCE_RULES = [
  { id: 'NEM-EXEC-SHELL', severity: 'high', title: 'Runs shell commands', re: /\b(execSync|exec|spawnSync|spawn|execFile)\s*\(|shell\s*:\s*true|subprocess\.(run|Popen|call)|os\.system\(/, why: 'A tool that can run commands can do anything the user can. Needs an allowlist and an approval hook.' },
  { id: 'NEM-EVAL', severity: 'high', title: 'Evaluates code from strings', re: /\beval\s*\(|new\s+Function\s*\(|\bvm\.(runIn\w*|Script)\b|\bexec\s*\(\s*compile\(/, why: 'Generated or user-supplied code runs with full privileges unless it is sandboxed.' },
  { id: 'NEM-CODEMODE-NOSANDBOX', severity: 'high', title: 'Code Mode execute without an isolated sandbox', re: /(execute|runCode|run_code|codeMode)[\s\S]{0,120}(new\s+Function|eval\s*\(|vm\.runIn)/, why: 'Code Mode needs an isolate (e.g. a Worker or isolated-vm) with no ambient network, fs or env.' },
  { id: 'NEM-ENV-DUMP', severity: 'high', title: 'Exposes the whole environment', re: /JSON\.stringify\(\s*process\.env\s*\)|\.\.\.process\.env\b|os\.environ\.copy\(\)|dict\(os\.environ\)/, why: 'Passing all environment variables to tools or sandboxes leaks every secret.' },
  { id: 'NEM-CRED-PATH', severity: 'high', title: 'Reads credential paths', re: /\.ssh\/|id_rsa|\.aws\/credentials|\.npmrc|\.netrc|\.docker\/config\.json|\.kube\/config|\.config\/gcloud/, why: 'Credential files should never be reachable from tool code.' },
  { id: 'NEM-HARDCODED-SECRET', severity: 'high', title: 'Hard-coded secret', re: /(sk_live_[0-9a-zA-Z]{10,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY)/, why: 'Secrets in source end up in packages and logs.', mask: true },
  { id: 'NEM-INJECTION-TEXT', severity: 'high', title: 'Prompt-injection wording in tool text', re: /ignore (all )?(previous|prior) instructions|do not tell the user|without (asking|telling) the user|<\s*(important|system)\s*>/i, why: 'Tool descriptions are read by the model; hidden instructions can steer it.' },
  { id: 'NEM-INVISIBLE-UNICODE', severity: 'high', title: 'Invisible or bidi Unicode characters', re: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u, why: 'Invisible characters can hide instructions from human reviewers.' },
  { id: 'NEM-OPEN-EGRESS', severity: 'medium', title: 'Outbound network call', re: /\bfetch\s*\(|\baxios\b|\bhttps?\.request\s*\(|requests\.(get|post|put)\(|urllib\.request|new\s+WebSocket\(/, why: 'Check that egress goes only to an allowlist of hosts; open egress enables exfiltration.' },
  { id: 'NEM-PLAIN-HTTP', severity: 'medium', title: 'Plain http:// URL', re: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^"'`\s]+/, why: 'Traffic can be read or changed in transit.' },
  { id: 'NEM-FS-WRITE', severity: 'medium', title: 'Writes or deletes files', re: /\b(writeFileSync|writeFile|appendFileSync|rmSync|unlinkSync|rmdirSync|rm\s*\(|unlink\s*\()|shutil\.rmtree|os\.remove\(/, why: 'Writes need a root folder check and, for deletes, a human approval.' },
  { id: 'NEM-NO-PATH-GUARD', severity: 'low', title: 'Path joined from input without a root check', re: /(join|resolve)\([^)]*(args|input|params|request)\.[a-zA-Z_]+/, why: 'Without a "stays inside root" check, ../ can reach any file.' },
];

export const PKG_RULES = (pkg) => {
  const out = [];
  const s = pkg.scripts || {};
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) if (s[k]) out.push({ id: 'NEM-INSTALL-SCRIPT', severity: k === 'prepare' ? 'low' : 'medium', title: `Has a ${k} script`, detail: s[k], why: 'Install scripts run on every machine that installs the server.' });
  for (const [sec, deps] of Object.entries({ dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies })) {
    for (const [n, v] of Object.entries(deps || {})) {
      if (/^(\*|latest|x|)$/.test(String(v).trim())) out.push({ id: 'NEM-UNPINNED-DEP', severity: 'medium', title: `Unpinned ${sec.replace(/ies$/, 'y')} ${n}@${v || '(empty)'}`, why: 'Any future version, including a compromised one, is accepted.' });
      else if (/^(git|github:|https?:)/.test(String(v))) out.push({ id: 'NEM-URL-DEP', severity: 'medium', title: `${n} installs from ${v}`, why: 'URL and git dependencies bypass the registry and are hard to audit.' });
    }
  }
  return out;
};

/** Files ending in .sample are scanned as their underlying type (e.g. server.js.sample), so risky test fixtures need not ship as runnable code. */
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.py', '.json', '.md', '.yaml', '.yml']);

export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'].includes(name)) continue;
    const p = join(dir, name); const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SRC_EXT.has(extname(name.replace(/\.sample$/i, '')).toLowerCase()) && st.size < 2_000_000) out.push(p);
  }
  return out;
}

const maskLine = (l) => l.replace(/([A-Za-z0-9_\-]{4})[A-Za-z0-9_\-]{8,}/g, '$1••••').slice(0, 200);

export function scanSource(dir) {
  const findings = [];
  for (const f of walk(dir)) {
    const rel = relative(dir, f).split('\\').join('/');
    const text = readFileSync(f, 'utf8');
    if (basename(f).replace(/\.sample$/i, '') === 'package.json') {
      try { for (const x of PKG_RULES(JSON.parse(text))) findings.push({ ...x, file: rel, line: 1 }); } catch { /* not JSON */ }
      continue;
    }
    const isDoc = /\.(md|ya?ml|json)(\.sample)?$/i.test(f);
    text.split(/\r?\n/).forEach((line, i) => {
      for (const r of SOURCE_RULES) {
        if (isDoc && !['NEM-INJECTION-TEXT', 'NEM-INVISIBLE-UNICODE', 'NEM-HARDCODED-SECRET', 'NEM-PLAIN-HTTP'].includes(r.id)) continue;
        if (r.re.test(line)) findings.push({ id: r.id, severity: r.severity, title: r.title, why: r.why, file: rel, line: i + 1, snippet: r.mask || r.id === 'NEM-HARDCODED-SECRET' ? maskLine(line.trim()) : line.trim().slice(0, 200) });
      }
    });
    // whole-file rules
    const usesWrite = /writeFile|rmSync|unlink|shutil\.rmtree|os\.remove/.test(text);
    if (usesWrite && !/approv|confirm|human|ask/i.test(text)) findings.push({ id: 'NEM-WRITE-NO-APPROVAL', severity: 'medium', title: 'Writes without any approval hook in this file', why: 'Destructive or state-changing tools should route through an approval step.', file: rel, line: 0 });
    const usesExec = SOURCE_RULES[0].re.test(text);
    if (usesExec && !/(allow|whitelist|permit)(ed)?(List|_list|Commands)?/i.test(text)) findings.push({ id: 'NEM-EXEC-NO-ALLOWLIST', severity: 'high', title: 'Runs commands with no visible allowlist in this file', why: 'Command tools need an explicit allowlist.', file: rel, line: 0 });
  }
  return summarize(findings, { scanned: walk(dir).length });
}

/** Review an MCP client config (mcpServers / servers). */
export function scanConfig(json) {
  const servers = json.mcpServers || json.servers || json.mcp?.servers || {};
  const findings = [];
  for (const [name, s] of Object.entries(servers)) {
    const add = (id, severity, title, why) => findings.push({ id, severity, title, why, server: name });
    const cmd = String(s.command || ''); const args = (s.args || []).map(String); const all = [cmd, ...args].join(' ');
    if (s.url) {
      if (/^http:\/\//i.test(s.url) && !/localhost|127\.0\.0\.1/.test(s.url)) add('NEM-CFG-PLAIN-HTTP', 'high', `Remote server over plain http (${s.url})`, 'Use https for remote MCP servers.');
      if (s.headers && Object.values(s.headers).some((v) => /^Bearer\s+[A-Za-z0-9._-]{16,}$/.test(String(v)))) add('NEM-CFG-INLINE-TOKEN', 'high', 'Bearer token written into the config', 'Reference an environment variable instead of pasting the token.');
    }
    if (/\b(npx|bunx|pnpm\s+dlx|uvx)\b/.test(cmd) || ['npx', 'bunx', 'uvx'].includes(cmd)) {
      const pkgArg = args.find((a) => !a.startsWith('-') && a !== 'dlx');
      if (pkgArg && !/@\d|==\d/.test(pkgArg.replace(/^@[^/]+\//, ''))) add('NEM-CFG-UNPINNED', 'medium', `Runs ${pkgArg} without a pinned version`, 'Pin an exact version (pkg@1.2.3) so a new release cannot change what runs.');
      if (pkgArg && /@latest\b/.test(pkgArg)) add('NEM-CFG-LATEST', 'medium', `Runs ${pkgArg}`, '@latest is not a pin.');
    }
    if (/curl[^|]*\|\s*(ba|z)?sh|wget[^|]*\|\s*(ba|z)?sh/.test(all)) add('NEM-CFG-PIPE-SH', 'high', 'Pipes a download into a shell', 'Anything at that URL runs on your machine.');
    if (/^(bash|sh|zsh|cmd|powershell|pwsh)$/i.test(cmd) && args.some((a) => /^(-c|\/c|-Command)$/i.test(a))) add('NEM-CFG-SHELL-WRAP', 'medium', 'Starts the server through a shell string', 'Shell strings are hard to review; run the binary directly.');
    if (/\bsudo\b/.test(all)) add('NEM-CFG-SUDO', 'high', 'Runs with sudo', 'An MCP server should never need root.');
    if (/docker/.test(cmd) && /--privileged|-v\s*\/:\/|--network[= ]host|\/var\/run\/docker\.sock/.test(all)) add('NEM-CFG-DOCKER-BROAD', 'high', 'Docker with privileged mode, host network, root mount or the Docker socket', 'This removes most of the container boundary.');
    if (args.some((a) => a === '/' || a === '~' || a === '$HOME' || /^[A-Z]:\\?$/i.test(a))) add('NEM-CFG-BROAD-ROOT', 'high', 'Filesystem root or home folder passed as an argument', 'Scope the server to one project folder.');
    for (const [k, v] of Object.entries(s.env || {})) {
      if (/(KEY|TOKEN|SECRET|PASSWORD|PASS)$/i.test(k) && v && !/^\$\{?[A-Z_]+\}?$|^\$env:|^<.*>$/.test(String(v))) add('NEM-CFG-INLINE-SECRET', 'high', `Secret value written inline for ${k} (value not shown)`, 'Keep secrets in your OS keychain or a secrets manager, not in a config file.');
    }
  }
  return summarize(findings, { servers: Object.keys(servers).length });
}

function summarize(findings, extra) {
  const by = { high: 0, medium: 0, low: 0 };
  for (const f of findings) by[f.severity]++;
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || String(a.file || a.server).localeCompare(String(b.file || b.server)) || (a.line || 0) - (b.line || 0));
  return { ...extra, findings: findings.length, by_severity: by, verdict: by.high ? 'review_before_use' : by.medium ? 'review_recommended' : 'no_pattern_findings', items: findings, note: 'Static, pattern-based review. No findings does not mean the server is safe; findings are places a person should read.' };
}

export function sarif(result, toolVersion) {
  const lvl = { high: 'error', medium: 'warning', low: 'note' };
  const ids = [...new Set(result.items.map((i) => i.id))];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'nemesis-of-servers', version: toolVersion, informationUri: 'https://github.com/fpavia111-creator/mythos-agents', rules: ids.map((id) => { const i = result.items.find((x) => x.id === id); return { id, shortDescription: { text: i.title }, help: { text: i.why } }; }) } },
      results: result.items.map((i) => ({ ruleId: i.id, level: lvl[i.severity], message: { text: `${i.title}. ${i.why}` }, locations: [{ physicalLocation: { artifactLocation: { uri: i.file || 'mcp-config.json' }, region: { startLine: Math.max(1, i.line || 1) } } }] })),
    }],
  };
}

export function reportMarkdown(result, title, generatedAt) {
  const L = [`# ${title}`, '', `Generated ${generatedAt} by nemesis-of-servers. Static, pattern-based review.`, '', `**Verdict:** ${result.verdict.replace(/_/g, ' ')} · high ${result.by_severity.high}, medium ${result.by_severity.medium}, low ${result.by_severity.low}`, ''];
  L.push('| Severity | Rule | Where | Finding |', '|---|---|---|---|');
  for (const i of result.items) L.push(`| ${i.severity} | ${i.id} | ${i.server ? 'server ' + i.server : `${i.file}${i.line ? ':' + i.line : ''}`} | ${i.title.replace(/\|/g, '/')} |`);
  L.push('', '## Limits', '', '- Patterns find places to read; they can miss obfuscated or dynamic code and can flag safe code.', '- This is not a penetration test, a certification or a guarantee.', '');
  return L.join('\n');
}
