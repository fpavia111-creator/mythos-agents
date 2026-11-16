// Rule catalog: one entry per rule id, with the fix, OWASP MCP Top 10 mapping and CWE.
// Used by the Markdown report ("fix first" list), SARIF rule metadata and the README table.

const R = (severity, title, why, fix, owasp, cwe, extra = {}) => ({ severity, title, why, fix, owasp, cwe, ...extra });

export const OWASP_MCP = {
  MCP01: 'Token Mismanagement & Secret Exposure',
  MCP02: 'Privilege Escalation via Scope Creep',
  MCP03: 'Tool Poisoning',
  MCP04: 'Software Supply Chain Attacks & Dependency Tampering',
  MCP05: 'Command Injection & Execution',
  MCP06: 'Prompt Injection via Contextual Payloads',
  MCP07: 'Insufficient Authentication & Authorization',
  MCP08: 'Lack of Audit and Telemetry',
  MCP09: 'Shadow MCP Servers',
  MCP10: 'Context Injection & Over-Sharing',
};

export const RULES = {
  // ---- server source: patterns ----
  'NEM-EXEC-SHELL': R('high', 'Runs shell commands', 'A tool that can run commands can do anything the user can.', 'Use execFile with a fixed binary and an explicit allowlist of commands and arguments; never pass shell: true.', ['MCP05'], [78]),
  'NEM-EXEC-NO-ALLOWLIST': R('high', 'Runs commands with no visible allowlist in this file', 'Command tools need an explicit allowlist.', 'Check the command against a constant allowlist before running it, and route it through a human approval.', ['MCP05'], [78]),
  'NEM-EVAL': R('high', 'Evaluates code from strings', 'Generated or user-supplied code runs with full privileges unless it is sandboxed.', 'Remove eval/new Function/vm; if code execution is the feature, run it in an isolate with no fs, network or env.', ['MCP05'], [95]),
  'NEM-CODEMODE-NOSANDBOX': R('high', 'Code Mode execute without an isolated sandbox', 'Code Mode needs an isolate (e.g. a Worker or isolated-vm) with no ambient network, fs or env.', 'Execute model-written code in an isolate with an explicit capability list and time/memory limits.', ['MCP05'], [94]),
  'NEM-ENV-DUMP': R('high', 'Exposes the whole environment', 'Passing all environment variables to tools or sandboxes leaks every secret.', 'Pass only the named variables a tool needs.', ['MCP01', 'MCP10'], [526]),
  'NEM-CRED-PATH': R('high', 'Reads credential paths', 'Credential files should never be reachable from tool code.', 'Remove access to ~/.ssh, ~/.aws, .npmrc and similar; use a scoped token from a secrets manager.', ['MCP01'], [522]),
  'NEM-HARDCODED-SECRET': R('high', 'Hard-coded secret', 'Secrets in source end up in packages and logs.', 'Rotate the secret now, remove it from source and history, and read it from the environment or a secrets manager.', ['MCP01'], [798]),
  'NEM-INJECTION-TEXT': R('high', 'Prompt-injection wording in tool text', 'Tool descriptions are read by the model; hidden instructions can steer it.', 'Remove instructions aimed at the model; a description should only say what the tool does.', ['MCP03', 'MCP06'], [1427]),
  'NEM-INVISIBLE-UNICODE': R('high', 'Invisible or bidi Unicode characters', 'Invisible characters can hide instructions from human reviewers.', 'Strip zero-width, bidi-control and tag characters from tool text and source.', ['MCP03'], [1007]),
  'NEM-OPEN-EGRESS': R('medium', 'Outbound network call', 'Check that egress goes only to an allowlist of hosts; open egress enables exfiltration.', 'Restrict outbound calls to a constant host allowlist (add hosts to the policy egress_allowlist once reviewed).', ['MCP10'], [200]),
  'NEM-PLAIN-HTTP': R('medium', 'Plain http:// URL', 'Traffic can be read or changed in transit.', 'Use https.', ['MCP07'], [319]),
  'NEM-FS-WRITE': R('medium', 'Writes or deletes files', 'Writes need a root folder check and, for deletes, a human approval.', 'Resolve paths inside one root folder and refuse anything outside it.', ['MCP02'], [73]),
  'NEM-NO-PATH-GUARD': R('low', 'Path joined from input without a root check', 'Without a "stays inside root" check, ../ can reach any file.', 'Resolve the path, then check path.relative(root, p) does not start with ".." and is not absolute.', ['MCP02'], [22]),
  'NEM-WRITE-NO-APPROVAL': R('medium', 'Writes without any approval hook in this file', 'Destructive or state-changing tools should route through an approval step.', 'Mark the tool destructive and require a human confirmation before it writes.', ['MCP02'], [862]),
  'NEM-TLS-DISABLED': R('high', 'TLS certificate checks turned off', 'Anyone on the network path can impersonate the upstream service.', 'Remove rejectUnauthorized: false / verify=False / NODE_TLS_REJECT_UNAUTHORIZED=0.', ['MCP07'], [295]),
  'NEM-BIND-ALL': R('medium', 'HTTP server listens on all interfaces', 'A local MCP server bound to 0.0.0.0 is reachable from the network.', 'Bind to 127.0.0.1 for local servers, and require authentication for remote ones.', ['MCP07'], [1327]),
  'NEM-CORS-ANY': R('medium', 'CORS allows any origin', 'Any web page the user visits can call a local server that answers with Access-Control-Allow-Origin: *.', 'Allow only the origins you need, and check the Origin header (DNS rebinding).', ['MCP07'], [942]),
  'NEM-UNSAFE-DESERIALIZE': R('high', 'Unsafe deserialization', 'pickle, yaml.load and similar can run code from the data they read.', 'Use json, or yaml.safe_load, for anything that came from outside.', ['MCP05'], [502]),
  'NEM-SQL-CONCAT': R('high', 'SQL built from a string template', 'Tool input concatenated into SQL lets the model (or an injected prompt) run any query.', 'Use parameterised queries.', ['MCP05'], [89]),
  'NEM-TOKEN-PASSTHROUGH': R('high', 'Forwards the client token to another service', 'Token passthrough makes the server a confused deputy: the upstream service cannot tell who is calling, and audience checks are skipped.', 'Validate tokens issued for this server (audience check) and use a separate credential for upstream calls.', ['MCP01', 'MCP07'], [441]),
  // ---- source: data-flow (taint-style) ----
  'NEM-FLOW-ENV-TO-NET': R('high', 'Secret flows into the body or URL of a network call', 'A secret (a key-like environment variable, the whole environment or a credential file) reaches the body or URL of an outbound request. That is how servers exfiltrate keys; it can also be an API that takes its key in the query string.', 'Check the destination is the service the secret belongs to. Send secrets as auth headers to a fixed, allowlisted host; never put them in request bodies or in URLs built from input.', ['MCP01', 'MCP10'], [201]),
  'NEM-FLOW-INPUT-TO-EXEC': R('high', 'Tool input flows into command or code execution', 'Model-controlled arguments reach exec/eval: one injected prompt runs any command.', 'Map input to a fixed allowlist of commands; pass arguments as an array to execFile; never build shell strings.', ['MCP05'], [78]),
  'NEM-FLOW-INPUT-TO-NET': R('medium', 'Tool input flows into a network call (SSRF)', 'A model-controlled URL can reach internal services, cloud metadata endpoints or an attacker host.', 'Parse the URL and check the host against an allowlist; block private and link-local addresses.', ['MCP10'], [918]),
  'NEM-FLOW-INPUT-TO-PATH': R('high', 'Tool input flows into a file path without a root check', 'Model-controlled paths with ../ or absolute paths can read or overwrite any file.', 'Resolve inside a root and refuse paths that escape it (wrap the input in a guard such as safePath/inside).', ['MCP02'], [22]),
  // ---- source: package and lockfile ----
  'NEM-INSTALL-SCRIPT': R('medium', 'Has an install script', 'Install scripts run on every machine that installs the server.', 'Remove pre/post-install scripts or document exactly what they do.', ['MCP04'], [829]),
  'NEM-UNPINNED-DEP': R('medium', 'Unpinned dependency', 'Any future version, including a compromised one, is accepted.', 'Use a version range and commit a lockfile, or pin an exact version.', ['MCP04'], [1104]),
  'NEM-URL-DEP': R('medium', 'Dependency installs from a URL or git', 'URL and git dependencies bypass the registry and are hard to audit.', 'Publish the dependency to a registry or vendor it, and pin it by version.', ['MCP04'], [829]),
  'NEM-NO-LOCKFILE': R('medium', 'Dependencies with no lockfile', 'Without a lockfile every install can resolve different (possibly compromised) versions.', 'Commit package-lock.json (or pnpm/yarn/bun lock) and install with npm ci.', ['MCP04'], [1104]),
  'NEM-LOCK-NONREGISTRY': R('medium', 'Lockfile resolves a package outside the npm registry', 'Tarballs from other hosts or git skip registry provenance.', 'Resolve from the registry, or review and vendor the dependency.', ['MCP04'], [829]),
  'NEM-LOCK-NO-INTEGRITY': R('low', 'Lockfile entry has no integrity hash', 'Without an integrity hash a swapped tarball installs silently.', 'Regenerate the lockfile with a current npm so every entry has an integrity field.', ['MCP04'], [353]),
  'NEM-PY-UNPINNED': R('medium', 'Python requirement without an exact pin', 'pip installs whatever version is newest at install time.', 'Pin with == (ideally with --hash) or use a lockfile (uv.lock, poetry.lock).', ['MCP04'], [1104]),
  'NEM-ADVISORY': R('high', 'Dependency matches an advisory in the offline list', 'This name and version appear in the advisory list Nemesis was given.', 'Upgrade to the fixed version or remove the package; check the linked advisory.', ['MCP04'], [1395]),
  // ---- MCP client config ----
  'NEM-CFG-PLAIN-HTTP': R('high', 'Remote server over plain http', 'Use https for remote MCP servers.', 'Switch the URL to https.', ['MCP07'], [319]),
  'NEM-CFG-INLINE-TOKEN': R('high', 'Bearer token written into the config', 'Reference an environment variable instead of pasting the token.', 'Rotate the token and reference it as ${VAR}.', ['MCP01'], [798]),
  'NEM-CFG-UNPINNED': R('medium', 'Runs a package without a pinned version', 'Pin an exact version (pkg@1.2.3) so a new release cannot change what runs.', 'Pin pkg@x.y.z (or ==x.y.z for uvx).', ['MCP04'], [1104]),
  'NEM-CFG-LATEST': R('medium', 'Runs @latest', '@latest is not a pin.', 'Pin an exact version.', ['MCP04'], [1104]),
  'NEM-CFG-PIPE-SH': R('high', 'Pipes a download into a shell', 'Anything at that URL runs on your machine.', 'Install a pinned, reviewed package instead.', ['MCP04'], [494]),
  'NEM-CFG-SHELL-WRAP': R('medium', 'Starts the server through a shell string', 'Shell strings are hard to review; run the binary directly.', 'Use command + args without bash -c.', ['MCP05'], [78]),
  'NEM-CFG-SUDO': R('high', 'Runs with sudo', 'An MCP server should never need root.', 'Run as the user, inside a container if it needs isolation.', ['MCP02'], [250]),
  'NEM-CFG-DOCKER-BROAD': R('high', 'Docker with privileged mode, host network, root mount or the Docker socket', 'This removes most of the container boundary.', 'Drop --privileged, host networking and socket mounts; mount one project folder read-only.', ['MCP02'], [250]),
  'NEM-CFG-BROAD-ROOT': R('high', 'Filesystem root or home folder passed as an argument', 'Scope the server to one project folder.', 'Pass one project folder.', ['MCP02'], [668]),
  'NEM-CFG-INLINE-SECRET': R('high', 'Secret value written inline', 'Keep secrets in your OS keychain or a secrets manager, not in a config file.', 'Rotate it and reference it as ${VAR}.', ['MCP01'], [798]),
  'NEM-CFG-AUTO-APPROVE': R('high', 'Tools auto-approved in the client config', 'alwaysAllow / autoApprove / trust skip the human confirmation, so a poisoned description or injected prompt runs those tools silently.', 'Remove auto-approval for tools that write, send, run or delete; keep it only for read-only tools you reviewed.', ['MCP02'], [862]),
  'NEM-CFG-SKIP-PERMS': R('high', 'Server started with a permission or sandbox bypass flag', 'Flags such as --dangerously-skip-permissions, --allow-all or --no-sandbox remove the checks that limit damage.', 'Remove the flag and grant only the specific permissions needed.', ['MCP02'], [250]),
  'NEM-CFG-DUPLICATE': R('medium', 'Same server configured more than once', 'Duplicate or shadow entries make it unclear which tools the model is calling, and enable tool shadowing.', 'Keep one entry per server and remove the rest.', ['MCP09'], [1188]),
  'NEM-CFG-ADVISORY': R('high', 'Configured package matches an advisory in the offline list', 'The pinned version appears in the advisory list Nemesis was given.', 'Pin the fixed version, or remove the server.', ['MCP04'], [1395]),
  // ---- tool descriptions (tools/list dump) ----
  'NEM-TOOL-INJECTION': R('high', 'Instructions to the model hidden in tool text', 'Tool poisoning: the model reads every description; text like "ignore previous instructions" or <IMPORTANT> blocks steers it without the user seeing.', 'Do not install the server until the text is removed; report it to the maintainer.', ['MCP03', 'MCP06'], [1427]),
  'NEM-TOOL-COERCIVE': R('medium', 'Coercive wording in tool text', 'Phrases like "you must always call this first" push the model to use a tool when it was not asked to.', 'Describe what the tool does; let the user decide when to call it.', ['MCP03'], [1427]),
  'NEM-TOOL-HIDDEN-UNICODE': R('high', 'Invisible Unicode in tool text', 'Zero-width, bidi or tag characters hide instructions from reviewers but not from the model.', 'Treat as poisoning until explained; strip the characters.', ['MCP03'], [1007]),
  'NEM-TOOL-PADDING': R('medium', 'Tool text padded with long runs of whitespace', 'Long whitespace runs push hidden text out of view in client UIs.', 'Remove the padding and review the text after it.', ['MCP03'], [1007]),
  'NEM-TOOL-SENSITIVE-PATH': R('high', 'Tool text mentions credential or config files', 'A description that asks for ~/.ssh, ~/.aws, .env or mcp.json is a classic exfiltration lure.', 'Do not install; no tool description should reference secrets.', ['MCP03', 'MCP01'], [522]),
  'NEM-TOOL-CONTEXT-EXFIL': R('high', 'Tool text asks for the conversation, system prompt or file contents', 'Hidden parameters that collect chat history or file contents leak context to the server.', 'Remove the parameter or the instruction; tools should take only the inputs they need.', ['MCP10'], [200]),
  'NEM-TOOL-SHADOWING': R('high', 'Tool text tries to change how other tools behave', 'Tool shadowing (cross-server escalation): one server\'s description rewrites the behaviour of another server\'s tool, e.g. adding a BCC or redirecting a payment.', 'Do not run this server alongside others until the text is removed.', ['MCP03'], [1427]),
  'NEM-TOOL-ENCODED': R('medium', 'Encoded blob in tool text', 'Long base64-like strings can carry instructions or payloads a reviewer cannot read.', 'Decode and review it, or remove it.', ['MCP03'], [506]),
  'NEM-TOOL-LONG-DESC': R('low', 'Very long tool description', 'Long descriptions are hard to review and a common place to hide instructions.', 'Keep descriptions short and factual.', ['MCP03'], [1427]),
  'NEM-TOOL-NAME-COLLISION': R('medium', 'Same tool name on more than one server', 'The model may call the wrong server\'s tool, and a malicious server can shadow a trusted one.', 'Rename or remove one of them; prefer clients that namespace tools by server.', ['MCP09', 'MCP03'], [1188]),
  'NEM-TOOL-CONFUSABLE-NAME': R('medium', 'Tool name uses non-ASCII or look-alike characters', 'Look-alike names (homoglyphs) impersonate trusted tools.', 'Use plain ASCII tool names.', ['MCP03'], [1007]),
  'NEM-TOOL-FREEFORM-EXEC': R('medium', 'Free-form command or code parameter', 'A string parameter named command/code/sql with no enum or pattern lets the model run anything.', 'Constrain it with an enum or pattern, or split it into specific tools.', ['MCP02', 'MCP05'], [77]),
  'NEM-TOOL-ANNOTATION-MISMATCH': R('high', 'Tool claims to be read-only but its name says it changes things', 'readOnlyHint: true on a delete/send/run tool can make clients skip confirmation.', 'Fix the annotation (destructiveHint: true) and do not trust annotations from servers you did not review.', ['MCP02'], [345]),
  'NEM-TOOL-NO-ANNOTATIONS': R('low', 'State-changing tool has no annotations', 'Without readOnlyHint/destructiveHint, clients cannot tell a delete from a read.', 'Add MCP tool annotations (destructiveHint, idempotentHint, openWorldHint).', ['MCP02'], [1188]),
  // ---- rug pull (pins) ----
  'NEM-TOOL-CHANGED': R('medium', 'Tool definition changed since it was pinned', 'A rug pull changes a tool after you approved it. Any change should be re-reviewed before use.', 'Read the diff; re-pin only after a person reviews it.', ['MCP03', 'MCP04'], [494]),
  'NEM-TOOL-ADDED': R('low', 'Tool added since it was pinned', 'New tools were not part of what you reviewed.', 'Review the new tool and re-pin.', ['MCP04'], [494]),
  'NEM-TOOL-REMOVED': R('low', 'Tool removed since it was pinned', 'Removed tools can break workflows or signal a changed server.', 'Confirm the removal was expected and re-pin.', ['MCP04'], [494]),
};

export const SECURITY_SEVERITY = { high: '8.0', medium: '5.5', low: '3.0' };

/** Fill a finding from the catalog (title/why/fix/owasp/cwe) without overwriting specific values. */
export function enrich(f) {
  const r = RULES[f.id] || {};
  return { severity: r.severity, title: r.title, why: r.why, ...f, fix: f.fix || r.fix, owasp: r.owasp || [], cwe: r.cwe || [] };
}
