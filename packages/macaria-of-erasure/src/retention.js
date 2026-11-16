// Retention rules, legal holds and the request deadline tracker. The rules are the
// user's own (a JSON file they write); Macaria applies them and cites the rule id.
// Nothing here is legal advice or decides which rule applies to you.
import { toIcs, toCsv } from 'mythos-agent-core';
import { dueDate, DEFAULT_RESPONSE_DAYS } from './erasure.js';

const str = { type: 'string' };
/** JSON Schema for the rules file (manifest configSchemas.retention_rules). */
export const RETENTION_RULES_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['retention_rules'],
  properties: {
    note: str,
    response_periods: { type: 'object', description: 'Days to respond per regime, e.g. {"gdpr":30,"ccpa":45}. Your choice; confirm what applies to you.', additionalProperties: { type: 'integer', minimum: 1, maximum: 400 } },
    due_soon_days: { type: 'integer', minimum: 0, maximum: 120 },
    retention_rules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'record_type', 'file_pattern', 'keep_days'],
        properties: {
          id: { type: 'string', minLength: 1 },
          record_type: { type: 'string', minLength: 1 },
          file_pattern: { type: 'string', minLength: 1, description: 'Case-insensitive text that the export file path contains' },
          date_column: { type: 'string', description: 'Column holding the record date the period counts from' },
          keep_days: { type: 'integer', minimum: 0 },
          action_after: { type: 'string', enum: ['delete', 'anonymise', 'review'] },
          basis: { type: 'string', description: 'Your note on why (for the reviewer); not checked' },
        },
      },
    },
    legal_holds: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'file_pattern'],
        properties: { id: { type: 'string', minLength: 1 }, file_pattern: { type: 'string', minLength: 1 }, until: { type: 'string', format: 'date' }, note: str },
      },
    },
  },
});

const has = (file, pat) => String(file).toLowerCase().includes(String(pat).toLowerCase());
const addDays = (d, n) => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : null; };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Apply the user's retention rules and legal holds to the subject's matched rows.
 * Holds win over rules. Each row gets a status and the id of the rule or hold behind it:
 *   on_hold · retain_until · period_ended · date_missing · no_rule
 * Only the record date (for the period) is read from the row; identifiers are not echoed.
 */
export function applyRetention(files, found, rules = {}, asOf = today()) {
  const holds = (rules.legal_holds || []).filter((h) => !h.until || h.until >= asOf);
  const expired = (rules.legal_holds || []).filter((h) => h.until && h.until < asOf).map((h) => h.id);
  const rows = []; const perFile = [];
  found.files.forEach((f, fi) => {
    if (!f.rows_found) return;
    const src = files[fi].rows; const out = [];
    for (const m of f.matches) {
      const hold = holds.find((h) => has(f.file, h.file_pattern));
      const rule = (rules.retention_rules || []).find((r) => has(f.file, r.file_pattern));
      let x;
      if (hold) x = { status: 'on_hold', rule_id: hold.id, until: hold.until || null, why: `Legal hold ${hold.id}${hold.until ? ` until ${hold.until}` : ' (no end date)'}${hold.note ? `: ${hold.note}` : ''}` };
      else if (rule) {
        const raw = rule.date_column ? src[m.row - 2]?.[rule.date_column] : null;
        const until = raw ? addDays(String(raw).trim(), rule.keep_days) : null;
        if (rule.keep_days === 0 && !rule.date_column) x = { status: 'period_ended', rule_id: rule.id, until: null, action_after: rule.action_after || 'review', why: `Rule ${rule.id} (${rule.record_type}) keeps nothing after the request; your rule says ${rule.action_after || 'review'}.` };
        else if (!rule.date_column || !raw || until === null) x = { status: 'date_missing', rule_id: rule.id, until: null, why: `Rule ${rule.id} (${rule.record_type}, ${rule.keep_days} days) needs a record date${rule.date_column ? ` in "${rule.date_column}"` : ''}; check by hand.` };
        else if (until > asOf) x = { status: 'retain_until', rule_id: rule.id, until, why: `Rule ${rule.id} (${rule.record_type}) keeps it ${rule.keep_days} days from ${rule.date_column}: until ${until}.` };
        else x = { status: 'period_ended', rule_id: rule.id, until, action_after: rule.action_after || 'review', why: `Rule ${rule.id} (${rule.record_type}) period ended ${until}; your rule says ${rule.action_after || 'review'}.` };
        if (rule.basis) x.basis = rule.basis;
      } else x = { status: 'no_rule', rule_id: null, until: null, why: f.retention_flag ? 'No rule of yours covers this file, but its name suggests records you may have to keep. Add a rule or check by hand.' : 'No retention rule covers this file.' };
      const r = { file: f.file, row: m.row, ...x }; rows.push(r); out.push(r);
    }
    const ids = [...new Set(out.map((r) => r.rule_id).filter(Boolean))];
    const by = (s) => out.filter((r) => r.status === s).length;
    const text = ids.length ? [by('on_hold') && `on hold (${ids.filter((i) => holds.some((h) => h.id === i)).join(', ')}): ${by('on_hold')} row(s)`, by('retain_until') && `retain: ${by('retain_until')} row(s) until ${out.filter((r) => r.status === 'retain_until').map((r) => r.until).sort().pop()}`, by('period_ended') && `period ended: ${by('period_ended')} row(s)`, by('date_missing') && `date missing: ${by('date_missing')} row(s)`].filter(Boolean).join('; ') + ` [${ids.join(', ')}]` : '';
    perFile.push({ file: f.file, rows: out.length, rules_cited: ids, on_hold: by('on_hold') > 0, retain: by('retain_until') + by('date_missing') > 0, text });
  });
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { as_of: asOf, rows, files: perFile, on_hold: count('on_hold'), retain_until: count('retain_until'), period_ended: count('period_ended'), date_missing: count('date_missing'), no_rule: count('no_rule'), expired_holds_ignored: expired,
    note: 'Applies the rules and holds you wrote, in that order (holds first). It does not decide whether a rule or exemption applies to you. Not legal advice.' };
}

const CLOSED = /^(closed|done|completed|complete|fulfilled|denied|withdrawn)$/i;
/**
 * Request deadline tracker over the requests.csv log. Due dates come from the configured
 * response period per regime (rules file response_periods, else the built-in defaults).
 */
export function trackDeadlines(rows, { periods = {}, dueSoonDays = 7, asOf = today() } = {}) {
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const items = rows.map((r, i) => {
    const due = dueDate(r.received, r.regime, periods);
    const closed = CLOSED.test(String(r.status || '').trim());
    const left = due ? days(asOf, due) : null;
    const state = closed ? 'closed' : !due ? 'no_period_configured' : left < 0 ? 'overdue' : left <= dueSoonDays ? 'due_soon' : 'on_track';
    const flags = [];
    if (r.target_date && due && r.target_date !== due) flags.push(`logged_target_${r.target_date}_differs`);
    return { row: i + 2, request_key: r.request_key || '', subject: r.subject || '', received: r.received || '', regime: r.regime || '', period_days: due ? { ...DEFAULT_RESPONSE_DAYS, ...periods }[String(r.regime).toLowerCase()] : null, due, days_left: closed ? null : left, state, status: r.status || '', flags };
  });
  const order = { overdue: 0, due_soon: 1, no_period_configured: 2, on_track: 3, closed: 4 };
  items.sort((a, b) => order[a.state] - order[b.state] || String(a.due).localeCompare(String(b.due)));
  const n = (s) => items.filter((x) => x.state === s).length;
  return { as_of: asOf, requests: items.length, overdue: n('overdue'), due_soon: n('due_soon'), on_track: n('on_track'), closed: n('closed'), no_period_configured: n('no_period_configured'), items };
}

export const DEADLINE_COLUMNS = ['request_key', 'subject', 'received', 'regime', 'period_days', 'due', 'days_left', 'state', 'status', 'flags'];
export const deadlinesCsv = (t) => toCsv(t.items.map((x) => ({ ...x, days_left: x.days_left ?? '', period_days: x.period_days ?? '', due: x.due || '', flags: x.flags.join('; ') })), DEADLINE_COLUMNS);
export const deadlinesIcs = (t) => toIcs(t.items.filter((x) => x.due && x.state !== 'closed').map((x) => ({ uid: `${x.request_key || x.row}-due@macaria.local`, date: x.due, summary: `Erasure request ${x.request_key} due (${x.regime || 'no regime'})`, description: `Subject ${x.subject}. Received ${x.received}. Confirm the deadline that applies to you.`, reminders: [7, 2] })), { prodId: '-//Mythos Machine//macaria-of-erasure//EN', calName: 'Erasure request deadlines' });
