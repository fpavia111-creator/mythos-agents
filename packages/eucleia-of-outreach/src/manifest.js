import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkDraft, checkBatch, suppressionSet, draftText, heldCsv, readyCsv, DEFAULTS, WEEKDAYS, validTimeZone } from './gate.js';
import { parseEspExport, ESP_FORMATS } from './esp.js';
import { planSchedule, scheduleCsv, scheduleIcs } from './schedule.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const cfgProps = { config: { ...str, description: 'eucleia-config JSON: footer (from_name, postal_address, unsubscribe), window (days, start_hour, end_hour, time_zone, windows, blackout_dates), limits, link_allowlist, spam_words, spam_policy, max_per_day, min_gap_minutes' }, from_name: str, postal_address: str, unsubscribe: str, suppression: { ...str, description: 'CSV/JSON suppression list (email or domain column)' } };

const day = { enum: WEEKDAYS };
const hour = (max) => ({ type: 'integer', minimum: 0, maximum: max });
/** Sender config (eucleia-config). Unknown keys fail, so typos are caught. */
export const CONFIG_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    $schema: str,
    from_name: str, postal_address: str, unsubscribe: str,
    days: { type: 'array', items: day, minItems: 1, uniqueItems: true, description: 'Send days (default Tue, Wed)' },
    start_hour: hour(23), end_hour: hour(24),
    time_zone: { type: 'string', minLength: 1, description: 'IANA time zone for the window (default America/Chicago). A draft can override with a time_zone column.' },
    windows: { type: 'array', minItems: 1, description: 'Several windows instead of days/start_hour/end_hour', items: { type: 'object', additionalProperties: false, required: ['days', 'start_hour', 'end_hour'], properties: { days: { type: 'array', items: day, minItems: 1 }, start_hour: hour(23), end_hour: hour(24) } } },
    blackout_dates: { type: 'array', items: { type: 'string', format: 'date' }, description: 'Local dates with no sending (holidays)' },
    max_subject_chars: { type: 'integer', minimum: 1 }, max_body_words: { type: 'integer', minimum: 1 },
    link_allowlist: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Domains links may point to (subdomains included). When set, any other link holds the draft.' },
    max_links: { type: 'integer', minimum: 0 },
    spam_words: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Extra phrases to flag, on top of the built-in list' },
    spam_policy: { enum: ['warn', 'hold'], description: 'warn (default) or hold drafts with spam phrases' },
    max_per_day: { type: 'integer', minimum: 1, maximum: 100000 }, min_gap_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
  },
};

function load(a, ctx) {
  const config = { ...(a.config ? ctx.readJson(a.config, 'eucleia-config') : {}) };
  if (config.time_zone && !validTimeZone(config.time_zone)) throw new Error(`${a.config}: /time_zone "${config.time_zone}" is not a known IANA time zone`);
  for (const w of config.windows || []) if (w.end_hour <= w.start_hour) throw new Error(`${a.config}: a window ends before it starts`);
  if (config.start_hour !== undefined && config.end_hour !== undefined && config.end_hour <= config.start_hour) throw new Error(`${a.config}: end_hour must be after start_hour`);
  for (const k of ['from_name', 'postal_address', 'unsubscribe']) if (a[k]) config[k] = a[k];
  const suppression = a.suppression ? suppressionSet(ctx.records(a.suppression)) : new Set();
  return { config, suppression };
}

export const manifest = defineManifest({
  name: 'eucleia-of-outreach',
  version: pkg.version,
  description: 'A draft-only gate in front of outreach email: suppression list (with Mailchimp, HubSpot and Resend export import), CAN-SPAM footer fields, configurable send windows and time zones (default Tue/Wed America/Chicago), unfilled placeholders, spam phrases, link checks, and length limits. Plans send slots. It never sends; releasing a batch is always one human click.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 80, maxSpendUsd: 0 },
  configSchemas: { 'eucleia-config': CONFIG_SCHEMA },
  prompts: [{
    name: 'eucleia_outreach_batch', title: 'Gate an outreach batch',
    description: 'Import opt-outs, check every draft, fix or hold, plan send slots, prepare the outbox and hand the release to a person.',
    arguments: [
      { name: 'drafts', description: 'Drafts CSV/JSON under --root (to, subject, body, send_at, optional time_zone)', required: true },
      { name: 'config', description: 'eucleia-config JSON under --root', required: true },
      { name: 'suppression', description: 'Suppression CSV under --root', required: true },
      { name: 'esp_export', description: 'Unsubscribe/bounce export from Mailchimp, HubSpot or Resend (optional)', required: false },
      { name: 'start_from', description: 'ISO date-time to plan send slots from', required: false },
    ],
    text: `You are gating an outreach batch with the eucleia-of-outreach tools. Work only on files under --root. Eucleia never sends email; a person sends from their own mail tool.

1. If an ESP export was given ("{{esp_export}}"), call eucleia_import_suppression with suppression="{{suppression}}" and export="{{esp_export}}" first, so new opt-outs are honoured. It needs a human yes unless the buyer opted it in to Auto. It only adds; it never removes anyone.
2. Call eucleia_check_batch with drafts="{{drafts}}", config="{{config}}", suppression="{{suppression}}". For each held row, quote the exact failure (suppressed, unfilled placeholder, link not on the allowlist, URL shortener, outside the window, too long, missing footer field). Report spam-phrase warnings with the cited phrase and where it is. Do not rewrite a draft unless the user asks; never remove anyone from the suppression list.
3. If the user wants send times, call eucleia_plan_schedule with the same arguments and start_from="{{start_from}}". It writes schedule.csv and a calendar (.ics) with one entry per sending day. Explain the daily cap and gap.
4. Call eucleia_prepare_outbox to write ready.csv, held.csv and one text file per ready draft with the footer.
5. Call eucleia_release_batch. It returns needs_approval: releasing outreach is a binding send and stays one named human click, even in Auto. Give the user the approval command and repeat the same call after they approve. Then tell them to send from their own mail tool.

Passing these checks does not make a campaign lawful under CAN-SPAM, GDPR, CASL or any other law, and is not legal advice.`,
  }],
  tools: [
    {
      name: 'eucleia_check_draft', kind: 'read',
      description: 'Check one draft (to, subject, body, send_at, optional time_zone) against the suppression list, footer fields, send window (in the recipient\'s time zone when given), length limits, unfilled placeholders and links; cites spam phrases. Returns every failure; any failure holds the draft.',
      inputSchema: { type: 'object', required: ['to', 'subject', 'body'], properties: { to: str, subject: str, body: str, send_at: { ...str, description: 'ISO date-time' }, time_zone: { ...str, description: "Recipient's IANA time zone; the window is checked in it" }, is_reply: { type: 'boolean' }, ...cfgProps } },
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
      name: 'eucleia_import_suppression', kind: 'write', title: 'Import opt-outs from an ESP export',
      description: 'Read a Mailchimp (unsubscribed/cleaned), HubSpot (contacts with unsubscribe or hard-bounce columns) or Resend (contacts with unsubscribed) export and add those addresses to the suppression CSV. Adds only; never removes. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['suppression', 'export'], additionalProperties: false, properties: { suppression: str, export: { ...str, description: 'ESP export CSV/JSON' }, format: { type: 'string', enum: ['auto', ...ESP_FORMATS], description: 'Default auto (detected from the header)' } } },
      handler: async (a, ctx) => {
        const parsed = parseEspExport(ctx.records(a.export), a.format || 'auto');
        const f = ctx.path(a.suppression);
        const have = existsSync(f) ? suppressionSet(ctx.records(a.suppression)) : new Set();
        const fresh = parsed.entries.filter((e) => !have.has(e.email) && !have.has(e.email.split('@')[1]));
        const now = new Date().toISOString();
        if (fresh.length) {
          const csv = toCsv(fresh.map((e) => ({ email: e.email, reason: e.reason, added_at: now })), ['email', 'reason', 'added_at']);
          appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv);
        }
        return { summary: `${parsed.format} export: ${parsed.entries.length} suppressed address(es), ${fresh.length} new added, ${parsed.entries.length - fresh.length} already on the list. Nothing was removed.`, format: parsed.format, found: parsed.entries.length, added: fresh.length, already: parsed.entries.length - fresh.length };
      },
    },
    {
      name: 'eucleia_plan_schedule', kind: 'report', title: 'Plan send slots',
      description: 'For drafts that pass every check, plan send slots from start_from: inside the window in each recipient\'s time zone (or the config\'s), at most max_per_day per day, at least min_gap_minutes apart, skipping blackout dates. Writes schedule.csv and schedule.ics (one all-day entry per sending day, no addresses) into out_dir (default mythos-out/eucleia). Nothing is sent.',
      inputSchema: { type: 'object', required: ['drafts', 'start_from'], additionalProperties: false, properties: { drafts: str, start_from: { type: 'string', format: 'date-time' }, max_per_day: { type: 'integer', minimum: 1, maximum: 100000 }, min_gap_minutes: { type: 'integer', minimum: 1, maximum: 1440 }, out_dir: str, ...cfgProps } },
      handler: async (a, ctx) => {
        const o = load(a, ctx);
        const p = planSchedule(ctx.records(a.drafts), { ...o, start_from: a.start_from, max_per_day: a.max_per_day, min_gap_minutes: a.min_gap_minutes });
        const out = ctx.outDir(a.out_dir || 'mythos-out/eucleia');
        const csv = scheduleCsv(p);
        const files = [ctx.writeFile(out, 'schedule.csv', csv), ctx.writeFile(out, 'schedule.ics', scheduleIcs(p))];
        return { summary: `${p.scheduled} draft(s) scheduled over ${p.days.length} day(s); ${p.held} held, ${p.unplaced} without a slot. Nothing was sent.`, files, ...p, output_sha256: sha256(csv) };
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
        const text = JSON.stringify(rel, null, 2);
        const f = ctx.writeFile(out, 'release.json', text);
        return { summary: `Released ${ready.length} draft(s) for a person to send (${b.held} held). Eucleia sent nothing.`, file: f, released: ready.length, output_sha256: sha256(text) };
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
    { tool: 'eucleia_import_suppression', decision: 'ask', reason: 'Changing the suppression list needs a human yes (or an Auto opt-in).' },
    { tool: 'eucleia_plan_schedule', decision: 'allow' },
    { tool: 'eucleia_release_batch', decision: 'ask', reason: 'Releasing outreach is a legally binding send: one named human click, even in Auto.' },
    { tool: 'eucleia_send_email', decision: 'block', reason: 'Eucleia never sends email. A person sends from their own mail tool.' },
    { tool: '*', decision: 'block', reason: 'Not on the Eucleia allowlist.' },
  ] },
});
export { DEFAULTS };
