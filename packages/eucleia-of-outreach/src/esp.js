// Suppression import from ESP exports (Mailchimp, HubSpot, Resend). Column names are
// matched case-insensitively. Only addresses that the export marks as unsubscribed,
// cleaned, bounced or complained are returned; nothing is ever removed.

const low = (s) => String(s ?? '').trim().toLowerCase();
const truthy = (v) => /^(true|yes|1|y|unsubscribed)$/i.test(String(v ?? '').trim());
const keyed = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));

export const ESP_FORMATS = ['mailchimp', 'hubspot', 'resend'];

/** Guess the export format from its header row. */
export function detectFormat(rows) {
  if (!rows.length) return null;
  const h = new Set(Object.keys(rows[0]).map((k) => k.trim().toLowerCase()));
  if (h.has('email address') && (h.has('unsub_time') || h.has('clean_time') || h.has('leid') || h.has('euid') || h.has('member_rating'))) return 'mailchimp';
  if (h.has('record id') || h.has('unsubscribed from all email') || h.has('email hard bounce reason')) return 'hubspot';
  if (h.has('email') && h.has('unsubscribed')) return 'resend';
  return null;
}

/** Returns [{ email, reason }] sorted by email, de-duplicated. */
export function parseEspExport(rows, format = 'auto') {
  const fmt = format === 'auto' || !format ? detectFormat(rows) : format;
  if (!fmt) throw new Error('could not tell which ESP made this export; pass format: mailchimp, hubspot or resend');
  const out = new Map();
  const add = (email, reason) => { const e = low(email); if (e && e.includes('@') && !out.has(e)) out.set(e, reason); };
  for (const raw of rows) {
    const r = keyed(raw);
    if (fmt === 'mailchimp') {
      // Mailchimp's unsubscribed and cleaned exports list only suppressed members.
      // An audience export with a status column is filtered to those statuses.
      const status = low(r.status || r['member status']);
      if (status && !/unsub|clean|bounce|complain/.test(status)) continue;
      add(r['email address'], r.clean_time ? 'mailchimp: cleaned' : `mailchimp: unsubscribed${r.unsub_reason ? ' (' + String(r.unsub_reason).trim() + ')' : ''}`);
    } else if (fmt === 'hubspot') {
      const email = r.email || r['email address'];
      if (truthy(r['unsubscribed from all email'])) add(email, 'hubspot: unsubscribed from all email');
      else if (String(r['email hard bounce reason'] || '').trim()) add(email, 'hubspot: hard bounce');
      else if (/unsub|bounce|spam/.test(low(r['marketing contact status'] || r['email status']))) add(email, `hubspot: ${low(r['marketing contact status'] || r['email status'])}`);
    } else if (fmt === 'resend') {
      if (truthy(r.unsubscribed)) add(r.email, 'resend: unsubscribed');
      else if (/bounce|complain|suppress/.test(low(r.status || r.reason))) add(r.email, `resend: ${low(r.status || r.reason)}`);
    } else throw new Error(`unknown format ${fmt}`);
  }
  return { format: fmt, rows: rows.length, entries: [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([email, reason]) => ({ email, reason })) };
}
