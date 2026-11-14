import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkDraft, checkBatch, suppressionSet, draftText, heldCsv, readyCsv, DEFAULTS } from './gate.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const cfgProps = { config: { ...str, description: 'JSON file: {from_name, postal_address, unsubscribe, days, start_hour, end_hour, time_zone, max_subject_chars, max_body_words}' }, from_name: str, postal_address: str, unsubscribe: str, suppression: { ...str, description: 'CSV/JSON suppression list (email or domain column)' } };

function load(a, ctx) {
  const config = { ...(a.config ? JSON.parse(readFileSync(ctx.path(a.config), 'utf8')) : {}) };
  for (const k of ['from_name', 'postal_address', 'unsubscribe']) if (a[k]) config[k] = a[k];
  const suppression = a.suppression ? suppressionSet(ctx.records(a.suppression)) : new Set();
  return { config, suppression };
}

export const manifest = defineManifest({
  name: 'eucleia-of-outreach',
  version: pkg.version,
  description: 'A draft-only gate in front of outreach email: suppression list, CAN-SPAM footer fields, a Tue/Wed America/Chicago send window, subject under 30 characters and body under 100 words. It never sends; releasing a batch is always one human click.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 80, maxSpendUsd: 0 },
  tools: [
    {
      name: 'eucleia_check_draft', kind: 'read',
      description: 'Check one draft (to, subject, body, send_at) against the suppression list, footer fields, send window and length limits. Returns every failure; any failure holds the draft.',
      inputSchema: { type: 'object', required: ['to', 'subject', 'body'], properties: { to: str, subject: str, body: str, send_at: { ...str, description: 'ISO date-time' }, is_reply: { type: 'boolean' }, ...cfgProps } },
      handler: async (a, ctx) => { const o = load(a, ctx); const r = checkDraft(a, o); return { summary: r.ok ? `Ready (${r.subject_chars} chars, ${r.words} words). Still needs a human to release.` : `Held: ${r.fails.join('; ')}`, ...r }; },
    },
    {
      name: 'eucleia_check_batch', kind: 'read',
      description: 'Check a CSV/JSON file of drafts (to, subject, body, send_at). Also holds duplicate addresses in the same batch.',
      inputSchema: { type: 'object', required: ['drafts'], properties: { drafts: str, ...cfgProps } },
      handler: async (a, ctx) => { const o = load(a, ctx); const b = checkBatch(ctx.records(a.drafts), o); return { summary: `${b.ready} ready, ${b.held} held of ${b.drafts}.`, ...b }; },
    },
    {
      name: 'eucleia_prepare_outbox', kind: 'report',
      description: 'Write ready.csv, held.csv and one text file per ready draft (with the footer appended) into out_dir (default mythos-out/eucleia). Nothing is sent.',
      inputSchema: { type: 'object', required: ['drafts'], properties: { drafts: str, out_dir: str, ...cfgProps } },
      handler: async (a, ctx) => {
        const o = load(a, ctx); const drafts = ctx.records(a.drafts); const b = checkBatch(drafts, o);
        const out = ctx.outDir(a.out_dir || 'mythos-out/eucleia'); const dd = join(out, 'drafts'); mkdirSync(dd, { recursive: true });
        const files = [ctx.writeFile(out, 'ready.csv', readyCsv(b, drafts)), ctx.writeFile(out, 'held.csv', heldCsv(b))];
        for (const r of b.results.filter((x) => x.ok)) files.push(ctx.writeFile(dd, `row-${r.row}.txt`, draftText(drafts[r.row - 2], r)));
        return { summary: `Outbox prepared: ${b.ready} ready, ${b.held} held. Nothing was sent.`, ready: b.ready, held: b.held, files };
      },
    },
    {
      name: 'eucleia_add_suppression', kind: 'write',
      description: 'Add an address or domain to the suppression CSV (adds only; never removes). Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['suppression', 'email'], properties: { suppression: str, email: str, reason: str } },
      handler: async (a, ctx) => {
        const f = ctx.path(a.suppression); const e = String(a.email || '').trim().toLowerCase();
        if (!e || (!e.includes('@') && !e.includes('.'))) throw new Error('email must be an address or a domain');
        const row = toCsv([{ email: e, reason: a.reason || '', added_at: new Date().toISOString() }], ['email', 'reason', 'added_at']);
        if (existsSync(f) && suppressionSet(ctx.records(a.suppression)).has(e)) return { summary: `${e} was already suppressed.`, added: false };
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `${e} added to the suppression list.`, added: true };
      },
    },
    {
      name: 'eucleia_release_batch', kind: 'action', category: 'binding_send',
      description: 'One human click, every time (even in Auto): re-checks the batch and, if every ready draft still passes, records a release (release.json with a hash of each draft). Eucleia still sends nothing; a person sends from their own mail tool.',
      inputSchema: { type: 'object', required: ['drafts'], properties: { drafts: str, out_dir: str, ...cfgProps } },
      handler: async (a, ctx) => {
        const o = load(a, ctx); const drafts = ctx.records(a.drafts); const b = checkBatch(drafts, o);
        const ready = b.results.filter((r) => r.ok);
        if (!ready.length) throw new Error('no drafts pass the gate; nothing to release');
        const out = ctx.outDir(a.out_dir || 'mythos-out/eucleia');
        const rel = { released_at: new Date().toISOString(), drafts: ready.map((r) => ({ row: r.row, to: r.to, subject: r.subject, sha256: sha256(draftText(drafts[r.row - 2], r)) })), held: b.held, note: 'Released for a person to send from their own mail tool. Eucleia did not send anything.' };
        const f = ctx.writeFile(out, 'release.json', JSON.stringify(rel, null, 2));
        return { summary: `Released ${ready.length} draft(s) for a person to send (${b.held} held). Eucleia sent nothing.`, file: f, released: ready.length };
      },
    },
    {
      name: 'eucleia_send_email', kind: 'action', category: 'binding_send',
      description: 'Listed so agents can see it is refused. Eucleia never sends email itself.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  policy: { rules: [
    { tool: 'eucleia_check_draft', decision: 'allow' },
    { tool: 'eucleia_check_batch', decision: 'allow' },
    { tool: 'eucleia_prepare_outbox', decision: 'allow' },
    { tool: 'eucleia_add_suppression', decision: 'ask', reason: 'Changing the suppression list needs a human yes (or an Auto opt-in).' },
    { tool: 'eucleia_release_batch', decision: 'ask', reason: 'Releasing outreach is a legally binding send: one named human click, even in Auto.' },
    { tool: 'eucleia_send_email', decision: 'block', reason: 'Eucleia never sends email. A person sends from their own mail tool.' },
    { tool: '*', decision: 'block', reason: 'Not on the Eucleia allowlist.' },
  ] },
});
export { DEFAULTS };
