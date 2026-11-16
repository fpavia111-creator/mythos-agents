// Domain memory: facts an agent may learn about one customer's setup in its own
// specialty (a column name, an extra privileged role, a reviewer delegation), kept
// so the next run does not have to be told again.
//
// Rules, enforced here rather than left to the model:
// - One file per agent: <stateDir>/memory/<agent>.jsonl. The runtime picks the file
//   from the manifest name; no tool argument can point at another agent's memory.
// - Only the kinds the agent's manifest declares, each with a JSON Schema. A kind
//   says in its own words what it changes; no kind can touch policy, caps, Auto
//   opt-ins or one-click categories (those are not memory, they are code).
// - Learning only proposes. A proposed fact does nothing until a named person accepts
//   it through <prefix>_accept_learning, which is a one-click category: it always
//   needs a person, even in Auto.
// - Append-only and hash-chained like the audit log (signed with the same key when
//   one is configured). If the chain does not verify, or an "accepted" line has no
//   matching approval by that person, the fact is not used.
// - Refuses values that look like credentials or that read like instructions to an AI.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { AuditLog, readAudit, verifyChain } from './audit.js';
import { sha256, canonical } from './util.js';
import { validate } from './schema.js';
import { injectionSignals, shannonEntropy } from './text.js';

export const MEMORY_CATEGORY = 'accept_learning';
export const MEMORY_DIR = 'memory';
const MAX_VALUE_CHARS = 4000;
const MAX_NOTE_CHARS = 1000;
const MAX_PENDING = 200;
const MAX_FACTS = 5000;

/** The kind every agent with memory gets: a plain note for people, with no effect on any check. */
export const NOTE_KIND = Object.freeze({
  description: 'A note about this customer\'s setup for the next person or run (for example "Subsidiary US01 posts in USD"). Changes no check.',
  effect: 'none (shown by recall only)',
  schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } } },
});

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\b[sr]k_(live|test)_[0-9A-Za-z]{10,}/, 'a Stripe secret key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(password|passwd|pwd|secret|api[_ -]?key|token)\s*[:=]\s*\S+/i, 'a password or key'],
  [/\b\d{3}-\d{2}-\d{4}\b/, 'what looks like a US social security number'],
];

/** Why a value must not be stored, or null. */
export function memoryValueProblem(text) {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return `it contains ${what}; memory keeps setup facts, never credentials or personal identifiers`;
  for (const tok of text.split(/[\s"',:{}[\]]+/)) if (tok.length >= 32 && shannonEntropy(tok) >= 4) return 'it contains a long random-looking string (a key or token?); memory keeps setup facts, never credentials';
  const sig = injectionSignals(text);
  if (sig.length) return `it reads like instructions to an AI (${sig.join(', ')}); memory keeps facts, not instructions`;
  return null;
}

const contentId = (agent, kind, value) => `MEM-${sha256(canonical({ agent, kind, value })).slice(0, 12)}`;
/** The runtime's approval id for a call (same formula as AgentRuntime.approvalId). */
export const approvalIdFor = (agent, tool, args) => sha256(`${agent}|${tool}|${canonical(args || {})}`).slice(0, 16);
const low = (s) => String(s ?? '').toLowerCase();

export class DomainMemory {
  /**
   * @param {string|null} file   JSONL file (null keeps memory in this process only)
   * @param {object} o
   *   agent      manifest name (written on every line, checked on read)
   *   kinds      { name: { description, effect, schema, check? } } from the manifest (note is added);
   *              check(value) returns a reason to refuse the value, or null
   *   signer     the audit signer, when lines should be signed
   *   approvals  the runtime's ApprovalStore, to check every acceptance against it
   */
  constructor(file, { agent, kinds = {}, signer = null, approvals = null } = {}) {
    this.file = file;
    this.agent = agent;
    this.kinds = Object.freeze({ note: NOTE_KIND, ...kinds });
    this.approvals = approvals;
    this.log = new AuditLog(file, { signer });
    this.memLines = []; // used when file is null
  }

  lines() {
    if (!this.file) return this.memLines.slice();
    return existsSync(this.file) ? readAudit(this.file) : [];
  }

  #write(entry) {
    const line = this.log.write({ type: 'memory', agent: this.agent, ...entry });
    if (!this.file) this.memLines.push(line);
    return line;
  }

  /**
   * Approve records by approval id, read once per load. An acceptance is checked
   * against the whole approvals history (not the current cycle), so asking again
   * with the same arguments later does not undo a fact that was properly accepted.
   */
  #approvalIndex() {
    if (!this.approvals) return null;
    const idx = new Map();
    for (const r of this.approvals.all()) if (r && r.type === 'approve' && r.id) { if (!idx.has(r.id)) idx.set(r.id, []); idx.get(r.id).push(r); }
    return idx;
  }

  /** Every fact with its current status, folded from the events in file order. */
  load() {
    const lines = this.lines();
    const chain = verifyChain(lines);
    const approvals = this.#approvalIndex();
    const facts = new Map(); const problems = [];
    // An acceptance or retirement counts only when the approval it names was given by
    // the same person, before the line was written, for exactly this fact and decision
    // (the approval id is a hash of the tool name and its arguments).
    const approved = (e) => {
      if (!approvals) return true; // no approvals store: in-process use by code, not through the runtime
      if (!e.approval_id || !/^[a-z][a-z0-9]*_(accept_learning|retire_memory)$/.test(e.tool || '')) return false;
      const args = e.event === 'retired' ? { id: e.memory_id, reason: e.reason } : { id: e.memory_id, decision: e.event === 'accepted' ? 'accept' : 'reject', ...(e.reason !== null && e.reason !== undefined ? { reason: e.reason } : {}) };
      if (approvalIdFor(this.agent, e.tool, args) !== e.approval_id) return false;
      const at = Date.parse(e.ts);
      return (approvals.get(e.approval_id) || []).some((r) => r.approved_by === e.by && Date.parse(r.ts) <= at && (!r.expires_at || Date.parse(r.expires_at) >= at));
    };
    for (const [i, e] of lines.entries()) {
      if (!e || e.__unparsable || e.type !== 'memory') continue;
      if (e.agent !== this.agent) { problems.push(`line ${i + 1} belongs to ${e.agent}, not ${this.agent}; ignored`); continue; }
      const id = e.memory_id; if (!id) continue;
      if (e.event === 'proposed') {
        // The id is a hash of the fact. A value edited in place no longer matches its
        // id, so an approval given for the original fact cannot carry over to it.
        if (id !== contentId(this.agent, e.kind, e.value)) { problems.push(`line ${i + 1}: fact ${id} does not match its content (edited?); ignored`); continue; }
        const prev = facts.get(id);
        if (prev && ['pending', 'active', 'unverified'].includes(prev.status)) continue;
        if (!this.kinds[e.kind]) problems.push(`${id}: kind "${e.kind}" is not one this version of ${this.agent} knows; it is kept but never used`);
        facts.set(id, { id, kind: e.kind, value: e.value, note: e.note || null, status: 'pending', proposed_at: e.ts, proposed_via: e.via || null, sources: e.sources || [], history: [...(prev ? prev.history : []), { event: 'proposed', at: e.ts }] });
        continue;
      }
      const f = facts.get(id); if (!f) { problems.push(`line ${i + 1}: ${e.event} for unknown fact ${id}; ignored`); continue; }
      f.history.push({ event: e.event, at: e.ts, by: e.by || null, reason: e.reason || null });
      if (e.event === 'accepted' && (f.status === 'pending' || f.status === 'unverified')) {
        if (!approved(e)) { problems.push(`${id}: the acceptance by ${e.by || 'nobody'} has no matching approval by that person; the fact is not used`); f.status = 'unverified'; }
        else Object.assign(f, { status: 'active', accepted_by: e.by, accepted_at: e.ts, accept_reason: e.reason || null, approval_id: e.approval_id || null });
      } else if (e.event === 'rejected' && (f.status === 'pending' || f.status === 'unverified')) Object.assign(f, { status: 'rejected', rejected_by: e.by, rejected_at: e.ts, reject_reason: e.reason || null });
      else if (e.event === 'retired' && f.status === 'active') {
        if (!approved(e)) problems.push(`${id}: the retirement by ${e.by || 'nobody'} has no matching approval by that person; ignored`);
        else Object.assign(f, { status: 'retired', retired_by: e.by, retired_at: e.ts, retire_reason: e.reason || null });
      }
    }
    if (!chain.ok) problems.unshift(`the memory file does not verify (${chain.breaks.slice(0, 3).map((b) => `line ${b.line}: ${b.problem}`).join('; ')}); no accepted fact is used until it is fixed`);
    return { chain: { ok: chain.ok, lines: chain.entries, signing: chain.signing, breaks: chain.breaks.slice(0, 20) }, facts: [...facts.values()], problems };
  }

  /** Accepted facts of one kind that may change a check: empty when the file does not verify. */
  active(kind) {
    const { chain, facts } = this.load();
    if (!chain.ok) return [];
    return facts.filter((f) => f.status === 'active' && this.kinds[f.kind] && (!kind || f.kind === kind));
  }

  checkValue(kind, value, note) {
    const k = this.kinds[kind];
    if (!k) throw new Error(`"${kind}" is not a kind of fact ${this.agent} can learn (kinds: ${Object.keys(this.kinds).join(', ')})`);
    const v = validate(k.schema, value);
    if (!v.ok) throw new Error(`value is not a valid ${kind}: ${v.errors.slice(0, 4).map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
    if (typeof k.check === 'function') { const why = k.check(value); if (why) throw new Error(`value is not a valid ${kind}: ${why}`); }
    const text = canonical(value);
    if (text.length > MAX_VALUE_CHARS) throw new Error(`value is too long (${text.length} characters, at most ${MAX_VALUE_CHARS})`);
    if (note !== undefined && note !== null && String(note).length > MAX_NOTE_CHARS) throw new Error(`note is too long (at most ${MAX_NOTE_CHARS} characters)`);
    const why = memoryValueProblem(`${text}\n${note ?? ''}`);
    if (why) throw new Error(`not stored: ${why}`);
  }

  /** Propose a fact. Returns the fact; an identical pending or accepted fact is returned as it is. */
  propose({ kind, value, note = null, via = null, sources = [] }) {
    this.checkValue(kind, value, note);
    const id = contentId(this.agent, kind, value);
    const { facts } = this.load();
    const same = facts.find((f) => f.id === id);
    if (same && ['pending', 'active', 'unverified'].includes(same.status)) return { ...same, already: true };
    if (facts.filter((f) => f.status === 'pending').length >= MAX_PENDING) throw new Error(`${MAX_PENDING} facts are already waiting for a person; accept or reject some first`);
    if (facts.length >= MAX_FACTS) throw new Error(`memory holds ${MAX_FACTS} facts, the most it keeps`);
    this.#write({ event: 'proposed', memory_id: id, kind, value, note: note || null, via, sources });
    return this.load().facts.find((f) => f.id === id);
  }

  /** A named person accepts or rejects a pending fact. */
  decide(id, decision, { by, reason = null, approval_id = null, tool = null } = {}) {
    if (!by || !String(by).trim()) throw new Error('a named person must accept or reject a fact');
    if (!['accept', 'reject'].includes(decision)) throw new Error('decision must be "accept" or "reject"');
    const f = this.load().facts.find((x) => x.id === id);
    if (!f) throw new Error(`no fact ${id} in ${this.agent}'s memory`);
    if (f.status !== 'pending' && f.status !== 'unverified') throw new Error(`${id} is ${f.status}, not waiting for a decision`);
    this.#write({ event: decision === 'accept' ? 'accepted' : 'rejected', memory_id: id, by: String(by).trim(), reason: reason ?? null, approval_id, tool });
    return this.load().facts.find((x) => x.id === id);
  }

  /** A named person retires an accepted fact (it stops applying; the history stays). */
  retire(id, { by, reason = null, approval_id = null, tool = null } = {}) {
    if (!by || !String(by).trim()) throw new Error('a named person must retire a fact');
    const f = this.load().facts.find((x) => x.id === id);
    if (!f) throw new Error(`no fact ${id} in ${this.agent}'s memory`);
    if (f.status !== 'active') throw new Error(`${id} is ${f.status}; only an accepted fact can be retired`);
    this.#write({ event: 'retired', memory_id: id, by: String(by).trim(), reason: reason ?? null, approval_id, tool });
    return this.load().facts.find((x) => x.id === id);
  }

  /** Search facts by text, kind and status (current = accepted, waiting and unverified). Scans the whole file. */
  search({ query = '', kind = null, status = 'current', limit = 50 } = {}) {
    const { chain, facts, problems } = this.load();
    const want = status === 'all' ? null : status === 'current' ? ['active', 'pending', 'unverified'] : [status];
    const q = low(query).trim();
    const hits = facts.filter((f) => (!want || want.includes(f.status)) && (!kind || f.kind === kind) && (!q || low(canonical({ kind: f.kind, value: f.value, note: f.note })).includes(q)));
    hits.sort((a, b) => (a.status === b.status ? 0 : a.status === 'pending' ? -1 : b.status === 'pending' ? 1 : 0) || String(b.proposed_at).localeCompare(String(a.proposed_at)));
    const counts = {}; for (const f of facts) counts[f.status] = (counts[f.status] || 0) + 1;
    return { chain, counts, total: hits.length, entries: hits.slice(0, limit).map(({ history, ...f }) => ({ ...f, effect: f.status === 'active' && chain.ok ? (this.kinds[f.kind] || {}).effect || null : 'none until accepted', history })), problems };
  }

  kindsInfo() { return Object.fromEntries(Object.entries(this.kinds).map(([k, v]) => [k, { description: v.description, effect: v.effect }])); }
}

/**
 * The four memory tools for a manifest, and their policy rules. Spread them into the
 * manifest: tools: [...ownTools, ...mem.tools], policy.rules: [...ownRules, ...mem.rules].
 *   recall           read    allow  search what this agent has learned
 *   learn            report  allow  propose a fact (stored as waiting; changes nothing)
 *   accept_learning  action  ask    one-click: a named person accepts or rejects it
 *   retire_memory    action  ask    one-click: a named person stops an accepted fact
 */
export function memoryTools(prefix, kinds = {}) {
  if (!/^[a-z][a-z0-9]{1,20}$/.test(prefix || '')) throw new Error('memoryTools: prefix must be the agent\'s short tool prefix, e.g. "ladon"');
  const all = { note: NOTE_KIND, ...kinds };
  const kindNames = Object.keys(all);
  const kindList = Object.entries(all).map(([k, v]) => `${k} (${v.effect})`).join('; ');
  const id = { type: 'string', pattern: '^MEM-[0-9a-f]{12}$', description: 'Fact id from recall or learn, e.g. MEM-1a2b3c4d5e6f' };
  const tools = [
    {
      name: `${prefix}_recall`, kind: 'read', title: 'Recall what this agent has learned',
      description: `Search this agent's own memory of the customer's setup: accepted facts (in use) and facts waiting for a person. Kinds: ${kindList}. Checks the memory file's hash chain; when it does not verify, no accepted fact is used.`,
      inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 200, description: 'Text to look for' }, kind: { enum: kindNames }, status: { enum: ['current', 'active', 'pending', 'rejected', 'retired', 'unverified', 'all'], description: 'current (default) = accepted, waiting, and accepted-but-unverified' }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
      handler: async (a, ctx) => {
        const r = ctx.memory.search({ query: a.query || '', kind: a.kind || null, status: a.status || 'current', limit: a.limit || 50 });
        return { summary: `${r.total} fact(s) found (${Object.entries(r.counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'memory is empty'}). Memory file ${r.chain.ok ? 'verifies' : 'DOES NOT VERIFY: accepted facts are not used'}.`, agent: ctx.manifest.name, kinds: ctx.memory.kindsInfo(), ...r };
      },
    },
    {
      name: `${prefix}_learn`, kind: 'report', title: 'Propose a fact to remember',
      description: `Propose one fact about the customer's setup for this agent to remember. It is stored as waiting and changes nothing until a named person accepts it with ${prefix}_accept_learning. Kinds: ${kindList}. Refuses credentials, personal identifiers and text that reads like instructions to an AI.`,
      inputSchema: { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: { kind: { enum: kindNames }, value: { type: 'object', description: 'The fact, in the shape of its kind (see recall for the kinds)' }, note: { type: 'string', maxLength: 1000, description: 'Why, for the person who accepts it' }, source_files: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Files under --root this came from (their hashes are recorded)' } } },
      handler: async (a, ctx) => {
        const sources = (a.source_files || []).map((p) => ({ file: p, sha256: ctx.hashFile(p) }));
        const f = ctx.memory.propose({ kind: a.kind, value: a.value, note: a.note || null, via: `${prefix}_learn`, sources });
        return { summary: f.already ? `${f.id} is already ${f.status === 'active' ? 'accepted' : f.status === 'unverified' ? 'recorded as accepted, but with no matching approval (a person can accept it again)' : 'waiting for a person'}; nothing new stored.` : `Stored ${f.id} as waiting. It changes nothing until a named person accepts it with ${prefix}_accept_learning (id "${f.id}", decision "accept").`, fact: f, next: f.status === 'pending' || f.status === 'unverified' ? { tool: `${prefix}_accept_learning`, args: { id: f.id, decision: 'accept' } } : null };
      },
    },
    {
      name: `${prefix}_accept_learning`, kind: 'action', category: MEMORY_CATEGORY, title: 'Accept or reject a learned fact',
      approvalPreview: (a, ctx) => factPreview(a, ctx, all),
      description: `A named person accepts or rejects a fact waiting in this agent's memory. Accepting makes it apply from the next run (see each kind's effect). Always needs a person's approval, even in Auto; the approver's name is recorded with the fact.`,
      inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'decision'], properties: { id, decision: { enum: ['accept', 'reject'] }, reason: { type: 'string', maxLength: 500 } } },
      handler: async (a, ctx) => {
        if (!ctx.approvedBy) throw new Error('accepting a fact needs a named person\'s approval');
        const f = ctx.memory.decide(a.id, a.decision, { by: ctx.approvedBy, reason: a.reason ?? null, approval_id: ctx.approvalId, tool: `${prefix}_accept_learning` });
        return { summary: `${f.id} ${f.status === 'active' ? 'accepted' : f.status} by ${ctx.approvedBy}.${f.status === 'active' ? ' It applies from the next run.' : ''}`, fact: f };
      },
    },
    {
      name: `${prefix}_retire_memory`, kind: 'action', category: MEMORY_CATEGORY, title: 'Retire a learned fact',
      approvalPreview: (a, ctx) => factPreview(a, ctx, all),
      description: 'A named person stops an accepted fact from applying. The history stays in the file. Always needs a person\'s approval, even in Auto.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id, reason: { type: 'string', minLength: 1, maxLength: 500 } } },
      handler: async (a, ctx) => {
        if (!ctx.approvedBy) throw new Error('retiring a fact needs a named person\'s approval');
        const f = ctx.memory.retire(a.id, { by: ctx.approvedBy, reason: a.reason, approval_id: ctx.approvalId, tool: `${prefix}_retire_memory` });
        return { summary: `${f.id} retired by ${ctx.approvedBy}; it no longer applies.`, fact: f };
      },
    },
  ];
  const rules = [
    { tool: `${prefix}_recall`, decision: 'allow' },
    { tool: `${prefix}_learn`, decision: 'allow' },
    { tool: `${prefix}_accept_learning`, decision: 'ask', reason: 'Changing what the agent remembers needs a named person, even in Auto.' },
    { tool: `${prefix}_retire_memory`, decision: 'ask', reason: 'Changing what the agent remembers needs a named person, even in Auto.' },
  ];
  return { tools, rules, kinds: all };
}

/** What a person sees when asked to approve accepting, rejecting or retiring a fact. */
function factPreview(a, ctx, kinds) {
  const f = ctx.memory && ctx.memory.load().facts.find((x) => x.id === a.id);
  if (!f) return { fact: a.id, problem: 'no such fact in this agent\'s memory; approving it will not change anything' };
  const k = kinds[f.kind] || {};
  return { fact: f.id, action: a.decision ? `${a.decision} this fact` : 'retire this fact', kind: f.kind, value: f.value, note: f.note, status_now: f.status, effect_if_accepted: k.effect || null, proposed_at: f.proposed_at };
}

/** Where an agent's memory lives under a state folder. */
export const memoryFile = (stateDir, agent) => join(stateDir, MEMORY_DIR, `${agent}.jsonl`);
