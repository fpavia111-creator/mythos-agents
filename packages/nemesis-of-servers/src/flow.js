// Taint-style data-flow checks, one file at a time. Deliberately small and explainable:
// it tracks named variables through simple assignments and reports a source -> ... -> sink
// path with line numbers. It does not follow calls across functions or files, so it can
// miss flows (false negatives) and flag guarded ones (false positives). Findings are places
// to read, not proof.

// Only secret-looking variables (API_KEY, TOKEN, ...) or the whole environment count as a secret
// source: reading PORT or BASE_URL from the environment and using it in a URL is ordinary config.
const SECRET = '\\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE)\\w*';
const SECRET_NAME = new RegExp(`^${SECRET}$`, 'i');
const SOURCES = {
  env: new RegExp([
    `\\bprocess\\.env\\.${SECRET}\\b`, `\\bprocess\\.env\\[\\s*['"]${SECRET}['"]\\s*\\]`,
    `\\bos\\.environ(?:\\.get\\(|\\[)\\s*['"]${SECRET}['"]`, `\\bos\\.getenv\\(\\s*['"]${SECRET}['"]`,
    `\\bDeno\\.env\\.get\\(\\s*['"]${SECRET}['"]`, `\\bBun\\.env\\.${SECRET}\\b`,
    '\\bprocess\\.env\\b(?!\\s*[.\\[?])', '\\bos\\.environ\\b(?!\\s*[.\\[])', '\\bos\\.environ\\.copy\\(', '\\bdict\\(\\s*os\\.environ\\s*\\)',
  ].join('|'), 'i'),
  secretfile: /\b(readFileSync|readFile|open)\s*\([^)]*(\.ssh|id_rsa|id_ed25519|\.aws|\.npmrc|\.netrc|\.kube|\.docker|credentials|\.pem)/,
  token: /\b(req|request|ctx\.request|extra\.request|httpReq)\.headers\s*(\.authorization\b|\[\s*['"]authorization['"]\s*\]|\.get\(\s*['"]authorization['"]\s*\))|\bextra\.authInfo\.token\b|request\.headers\.get\(\s*['"]Authorization['"]/i,
  input: /\b(args|input|params|arguments|toolArgs|tool_input|req\.body|req\.query|request\.params\.arguments|request\.json\(\)|request\.args)\s*(\.|\[)/,
};

const SINKS = {
  // A bare exec(...)/spawn(...) or child_process.exec(...); not someRegex.exec(...) or db.exec(...).
  exec: /(?<![.\w$])(execSync|exec|spawnSync|spawn|execFile|execFileSync|execa|execaSync)\s*\(|\b(child_process|childProcess|cp)(['"]\))?\.(execSync|exec|spawnSync|spawn|execFile|execFileSync)\s*\(|\bsubprocess\.\w+\s*\(|\bos\.(system|popen)\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn\w*\s*\(|\bBun\.spawn\w*\s*\(/,
  net: /\bfetch\s*\(|\baxios(\.\w+)?\s*\(|\bhttps?\.(request|get)\s*\(|\brequests\.\w+\s*\(|\bhttpx\.\w+\s*\(|\burllib\.request\.urlopen\s*\(|\bgot(\.\w+)?\s*\(|\bnew\s+WebSocket\s*\(|\bundici\.request\s*\(/,
  path: /\b(readFileSync|readFile|writeFileSync|writeFile|appendFileSync|appendFile|createReadStream|createWriteStream|rmSync|unlinkSync|unlink|rm|readdirSync)\s*\(|(?<![\w.])open\s*\(|\bshutil\.(rmtree|copy\w*|move)\s*\(|\bPath\s*\(/,
};

const SOURCE_LABEL = { input: 'tool input', input_fixedurl: 'tool input (inside a URL with a fixed host)', token: 'incoming Authorization header', secretfile: 'credential file', env: 'secret from the environment' };

// [source class, sink] -> rule
const FLOWS = [
  { cls: ['env', 'secretfile'], sink: 'net', id: 'NEM-FLOW-ENV-TO-NET' },
  { cls: ['token'], sink: 'net', id: 'NEM-TOKEN-PASSTHROUGH' },
  { cls: ['input', 'input_fixedurl'], sink: 'exec', id: 'NEM-FLOW-INPUT-TO-EXEC' },
  { cls: ['input'], sink: 'net', id: 'NEM-FLOW-INPUT-TO-NET' }, // only the URL argument is checked (SSRF)
  { cls: ['input', 'input_fixedurl'], sink: 'path', id: 'NEM-FLOW-INPUT-TO-PATH' },
];

// Calls treated as sanitizers: their arguments are removed before looking for tainted names.
const SANITIZER = /\b(inside|safePath|safe_path|resolveInside|resolveInRoot|within\w*|sanitiz\w*|validat\w*|assert\w*|guard\w*|check\w*|isAllowed\w*|allowed\w*|shellQuote|shlex\.quote|encodeURIComponent|path\.basename|basename|parseInt|Number|Boolean)\s*\(/g;

function stripCalls(s, re) {
  let out = s; let m; let guard = 0;
  re.lastIndex = 0;
  while ((m = re.exec(out)) && guard++ < 50) {
    let i = m.index + m[0].length; let depth = 1;
    while (i < out.length && depth) { if (out[i] === '(') depth++; else if (out[i] === ')') depth--; i++; }
    out = out.slice(0, m.index) + 'SANITIZED' + out.slice(i);
    re.lastIndex = m.index + 9;
  }
  return out;
}

/** Remove "<match>...<balanced close>" where the match ends with an opening bracket. */
function stripBalanced(s, re) {
  let out = s; let m; let guard = 0; const g = new RegExp(re.source, 'gi');
  while ((m = g.exec(out)) && guard++ < 50) {
    const open = m[0][m[0].length - 1]; const close = { '{': '}', '(': ')', '[': ']' }[open];
    let i = m.index + m[0].length; let depth = 1;
    while (i < out.length && depth) { if (out[i] === open) depth++; else if (out[i] === close) depth--; i++; }
    out = out.slice(0, m.index) + 'AUTH' + out.slice(i); g.lastIndex = m.index + 4;
  }
  return out;
}
/**
 * Sending a secret as an auth header is what API clients are for, so header and auth
 * positions are removed before looking for secrets that reach a network call.
 */
function stripAuth(s) {
  let out = stripBalanced(s, /\bheaders\s*[:=]\s*\{/);
  out = stripBalanced(out, /\bauth\s*[:=]\s*[({]/);
  return out.replace(/['"`]?\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-goog-api-key)\b['"`]?\s*[:=,]\s*[^,}\n]+/gi, 'AUTH').replace(/\bBearer\s+\$\{[^}]*\}|['"]Bearer\s*['"]\s*\+\s*[\w.$]+/g, 'AUTH');
}
const HEADERISH = /^(\w*headers?|auth\w*|authorization|bearer\w*)$/i;

/** Drop URL literals whose scheme and host are fixed: input after a fixed host cannot redirect the request. */
const stripFixedUrls = (s) => s.replace(/(['"`])https?:\/\/[^/'"`$\s{]+\/(?:\\.|(?!\1)[\s\S])*\1(\s*\+\s*[\w.$[\]'"`]+)*/g, '""');

/** The first argument of a call (the URL of a network call, the path of a file call), or the url property of an options object. */
function urlArg(s, sinkRe) {
  const m = sinkRe.exec(s); if (!m) return s;
  let i = m.index + m[0].length; let depth = 0; let q = null; const start = i;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
    else if (ch === ',' && depth === 0) break;
  }
  const first = s.slice(start, i);
  if (/^\s*\{/.test(first)) { const u = /\b(?:url|baseURL|uri)\s*:\s*([^,}]+)/.exec(first); return u ? u[1] : ''; }
  return first;
}

const isComment = (l) => /^\s*(\/\/|#|\*|\/\*)/.test(l);

/** Join lines from i until parentheses/brackets balance (max 12 lines). */
function statement(lines, i) {
  let text = ''; let depth = 0; let j = i;
  for (; j < lines.length && j < i + 12; j++) {
    const l = lines[j].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    text += (j > i ? '\n' : '') + lines[j];
    for (const ch of l) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; }
    if (depth <= 0) break;
  }
  return { text, end: j };
}

const identRe = (name) => new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);

/**
 * Scan one file's text. Returns [{ id, line, flow: [{ line, code, label }] }].
 * snippet(line) masks secrets in code excerpts.
 */
export function scanFlows(text, { snippet = (s) => s.trim().slice(0, 160) } = {}) {
  const lines = text.split(/\r?\n/);
  const taint = new Map(); // name -> { cls:Set, chain:[] }
  const out = []; const seen = new Set();
  // Variables checked against an allowlist anywhere in the file count as sanitized for exec.
  const allowGuarded = new Set();
  for (const m of text.matchAll(/\b\w*(allow|permit|whitelist)\w*\s*\.\s*(includes|has)\s*\(\s*([\w$.]+)\s*\)/gi)) allowGuarded.add(m[3]);
  for (const m of text.matchAll(/\b([\w.]+)\s+(?:not\s+)?in\s+\w*(ALLOW|allow|PERMIT|permit)\w*/g)) allowGuarded.add(m[1]);

  const rawClasses = (s) => {
    const cls = new Map(); // cls -> chain
    for (const [c, re] of Object.entries(SOURCES)) if (re.test(s)) cls.set(c, []);
    for (const [name, t] of taint) if (identRe(name).test(s)) for (const c of t.cls) if (!cls.has(c) || cls.get(c).length > t.chain.length) cls.set(c, t.chain);
    return cls;
  };
  // Secrets only count where they sit outside header/auth positions.
  const classesIn = (s) => {
    const cls = rawClasses(s);
    if (cls.has('env') || cls.has('secretfile')) { const outside = rawClasses(stripAuth(s)); for (const c of ['env', 'secretfile']) if (!outside.has(c)) cls.delete(c); }
    return cls;
  };
  let pendingPyParams = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line) || !line.trim()) continue;
    // Python MCP tool functions: parameters of a function decorated with @x.tool are input.
    if (/^\s*@\w+(\.\w+)*\.tool\b/.test(line)) { pendingPyParams = true; continue; }
    const def = /^\s*(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/.exec(line);
    if (def && pendingPyParams) {
      for (const p of def[1].split(',')) { const n = p.trim().split(/[:=\s]/)[0]; if (n && n !== 'self' && n !== 'ctx') taint.set(n, { cls: new Set(['input']), chain: [{ line: i + 1, code: snippet(line), label: `tool parameter ${n}` }] }); }
      pendingPyParams = false; continue;
    }
    // JS handlers with destructured arguments: async ({ path, cmd }) => ...
    for (const m of line.matchAll(/\(\s*\{([^}]*)\}\s*(?::\s*[\w<>{}\[\]|, ]+)?\)\s*=>/g)) {
      // ...but not array or promise callbacks such as .map(({ id }) => ...)
      if (/\.(map|filter|forEach|find|findIndex|findLast|some|every|reduce|flatMap|sort|then|catch|replace)\s*\(\s*$/.test(line.slice(0, m.index))) continue;
      for (const p of m[1].split(',')) { const n = p.trim().split(/[:=\s]/)[0]; if (/^[A-Za-z_$][\w$]*$/.test(n)) taint.set(n, { cls: new Set(['input']), chain: [{ line: i + 1, code: snippet(line), label: `tool argument ${n}` }] }); }
    }

    // Sinks
    for (const [sink, re] of Object.entries(SINKS)) {
      if (!re.test(line)) continue;
      const st = statement(lines, i);
      let s = stripCalls(st.text, new RegExp(SANITIZER.source, 'g')).replace(/\(\s*\{[^}]*\}\s*(?::\s*[\w<>{}\[\]|, ]+)?\)\s*=>/g, '() =>');
      if (sink === 'path' && /\bjoin\s*\(\s*(ROOT|root|base|BASE|this\.root|rootDir)\b/.test(s) && /startsWith\(\s*['"]\.\.['"]|relative\(/.test(text)) continue;
      const all = classesIn(s);
      const urlOnly = sink === 'net' ? classesIn(stripFixedUrls(urlArg(s, re))) : null;
      const pathOnly = sink === 'path' ? classesIn(urlArg(s, re)) : null; // the path argument, not the content written
      for (const f of FLOWS) {
        if (f.sink !== sink) continue;
        const cls = f.id === 'NEM-FLOW-INPUT-TO-NET' ? urlOnly : f.id === 'NEM-FLOW-INPUT-TO-PATH' ? pathOnly : all;
        const hit = f.cls.find((c) => cls.has(c));
        if (!hit) continue;
        if (sink === 'exec' && [...allowGuarded].some((g) => identRe(g).test(s))) continue;
        const key = `${f.id}|${i}`; if (seen.has(key)) continue; seen.add(key);
        const chain = cls.get(hit);
        const sinkName = (line.match(re) || [''])[0].replace(/\s*\($/, '');
        const flow = [...chain, { line: i + 1, code: snippet(line), label: `sink: ${sinkName}` }];
        if (!chain.length) {
          let k = i; for (let j = i; j <= st.end; j++) if (SOURCES[hit].test(lines[j] || '')) { k = j; break; }
          flow.unshift({ line: k + 1, code: snippet(lines[k]), label: `source: ${SOURCE_LABEL[hit]}` });
        }
        out.push({ id: f.id, line: i + 1, flow });
      }
    }

    // Assignments (const/let/var/plain, Python), including object destructuring.
    const st = statement(lines, i);
    const a = /^\s*(?:export\s+)?(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>\[\]|. ]+)?\s*=(?![=>])\s*([\s\S]+)$/.exec(st.text);
    const d = /^\s*(?:const|let|var)\s*\{([^}]+)\}\s*=\s*([\s\S]+)$/.exec(st.text);
    const targets = a ? [a[1]] : d ? d[1].split(',').map((p) => p.trim().split(/[:=\s]/).pop()).filter(Boolean) : [];
    const rhs = a ? a[2] : d ? d[2] : null;
    if (rhs !== null) {
      const cleaned = stripCalls(rhs, new RegExp(SANITIZER.source, 'g'));
      const base = classesIn(cleaned);
      // Input that only appears after a fixed scheme and host keeps a weaker class: still unsafe for exec, not SSRF.
      if (base.has('input') && !classesIn(stripFixedUrls(cleaned)).has('input')) { base.set('input_fixedurl', base.get('input')); base.delete('input'); }
      const wholeEnv = d && /^\s*(process\.env|os\.environ)\s*;?\s*$/.test(rhs);
      for (const name of targets) {
        const cls = new Map(base);
        if (HEADERISH.test(name) || (wholeEnv && !SECRET_NAME.test(name))) { cls.delete('env'); cls.delete('secretfile'); }
        if (!cls.size) { taint.delete(name); continue; }
        const longest = [...cls.values()].reduce((x, y) => (y.length > x.length ? y : x), []);
        const chain = longest.length
          ? [...longest, { line: i + 1, code: snippet(line), label: `${name} = ...` }]
          : [{ line: i + 1, code: snippet(line), label: `${name} = ${[...cls.keys()].map((c) => SOURCE_LABEL[c]).join(' + ')}` }];
        taint.set(name, { cls: new Set(cls.keys()), chain });
      }
    }
  }
  return out;
}

export const FLOW_RULE_IDS = FLOWS.map((f) => f.id);
