import { shannonEntropy } from 'mythos-agent-core';

// Secret detection for workflow exports: known token prefixes, secret-named keys, and
// high-entropy strings. Results name the rule and the location, never the value.

/** Known secret formats (ideas from open-source scanners; patterns written for this package). */
export const SECRET_RULES = Object.freeze([
  { id: 'stripe_live_key', label: 'Stripe live secret or restricted key', re: /\b[sr]k_live_[A-Za-z0-9]{8,}/ },
  { id: 'stripe_test_key', label: 'Stripe test secret key', re: /\bsk_test_[A-Za-z0-9]{8,}/ },
  { id: 'slack_token', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{8,}/ },
  { id: 'slack_webhook', label: 'Slack incoming-webhook URL', re: /hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/ },
  { id: 'discord_webhook', label: 'Discord webhook URL', re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/ },
  { id: 'aws_access_key', label: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github_token', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'gitlab_token', label: 'GitLab personal access token', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { id: 'google_api_key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'anthropic_key', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai_key', label: 'OpenAI-style API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: 'sendgrid_key', label: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { id: 'twilio_key', label: 'Twilio API key sid', re: /\bSK[0-9a-f]{32}\b/ },
  { id: 'mailgun_key', label: 'Mailgun API key', re: /\bkey-[0-9a-f]{32}\b/ },
  { id: 'shopify_token', label: 'Shopify access token', re: /\bshp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}\b/ },
  { id: 'npm_token', label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'jwt', label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'private_key', label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'url_credentials', label: 'password in a URL', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"]+:)[^\s@/"]{3,}(@)/i, keep: true },
  { id: 'url_signature', label: 'signed URL key (sig=, token=, api_key=, code=)', re: /([?&](?:sig|signature|token|access_token|api[_-]?key|apikey|key|code)=)[A-Za-z0-9%._~+/=-]{16,}()/i, keep: true },
]);
const PREFIX_UNION = new RegExp(SECRET_RULES.map((r) => r.re.source).join('|'));
/** Backwards-compatible union of all known-format rules. */
export const SECRET_VALUE = PREFIX_UNION;
export const SECRET_KEY = /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization|bearer|private[_-]?key|client[_-]?secret|signing[_-]?key|webhook[_-]?secret)/i;
const NOT_SECRET_VALUE = /^(none|true|false|header|query|body|bearer|basic|oauth2?|api[_ -]?key|predefined.*|generic.*|headerauth|querystring)$/i;

export const DEFAULT_ENTROPY = Object.freeze({ min_length: 20, min_bits: 4.0, min_bits_hex: 3.0, hex_min_length: 32 });
const isExpr = (v) => typeof v === 'string' && (v.startsWith('=') || v.startsWith('@') || v.includes('{{') || /^\$\w/.test(v) || /^@\{.*\}$/s.test(v) || /^#\{.*\}$/s.test(v) || v.includes('@{') || v.includes('#{'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A token-like string with high Shannon entropy (bits per char), skipping UUIDs, URLs, paths and prose. */
export function highEntropy(v, opts = {}) {
  const o = { ...DEFAULT_ENTROPY, ...opts }; const s = String(v).trim();
  if (s.length < o.min_length || /\s/.test(s) || UUID.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[./~]|\/.*\//.test(s)) return false;
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false;
  if (/^[0-9a-f]+$/i.test(s)) return s.length >= o.hex_min_length && shannonEntropy(s) >= o.min_bits_hex;
  return shannonEntropy(s) >= o.min_bits;
}

function ruleFor(v) { for (const r of SECRET_RULES) if (r.re.test(v)) return r; return null; }

/**
 * Scan any params object. Returns [{ path, rule, label, confidence, value }] where `value` is the raw
 * secret for internal grouping only. Callers must never return or write it; use publicHits().
 */
export function scanSecretsRaw(params, { entropy = {}, path = '' } = {}) {
  const hits = [];
  const visit = (v, p, keyHint) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${p}[${i}]`, keyHint));
    if (typeof v === 'object') {
      const nameLike = v.name ?? v.key ?? v.header;
      if (typeof nameLike === 'string' && 'value' in v) return visit(v.value, `${p}.${nameLike}`, nameLike);
      for (const [k, x] of Object.entries(v)) visit(x, p ? `${p}.${k}` : k, k);
      return;
    }
    if (typeof v !== 'string' || isExpr(v)) return;
    const r = ruleFor(v);
    if (r) return hits.push({ path: p, rule: r.id, label: r.label, confidence: 'high', value: v });
    if (SECRET_KEY.test(String(keyHint || '')) && v.trim().length >= 8 && !NOT_SECRET_VALUE.test(v.trim())) return hits.push({ path: p, rule: 'secret_named_field', label: `value in a secret-named field "${keyHint}"`, confidence: 'high', value: v });
    if (entropy !== false && highEntropy(v, entropy || {})) hits.push({ path: p, rule: 'high_entropy', label: `high-entropy string (${shannonEntropy(v.trim()).toFixed(1)} bits/char)`, confidence: 'medium', value: v });
  };
  visit(params, path, '');
  return hits;
}
/** Same hits with the value removed: safe to return, log or write. */
export const publicHits = (hits) => hits.map(({ value, ...h }) => h);

/** Replace every detected secret in a string value. Known formats are replaced in place; other hits replace the whole value. */
export function redactValue(v, keyHint = '', opts = {}) {
  if (typeof v !== 'string' || isExpr(v)) return v;
  const hits = scanSecretsRaw({ [keyHint || '_']: v }, opts);
  if (!hits.length) return v;
  const PH = '<<REDACTED: use a stored credential>>';
  if (hits[0].rule === 'secret_named_field' || hits[0].rule === 'high_entropy') return PH;
  let out = v;
  // URL rules keep the scheme, user, host and parameter name; only the secret part is replaced.
  for (const r of SECRET_RULES) out = out.replace(new RegExp(r.re.source, 'g' + r.re.flags.replace('g', '')), r.keep ? `$1${PH}$2` : PH);
  return out;
}
