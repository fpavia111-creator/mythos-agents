// JSON Schema for the optional Arethusa policy file, loaded with ctx.readJson(path, 'policy').
// Typos fail with a JSON-pointer error instead of being silently ignored.
export const POLICY_SCHEMA = Object.freeze({
  $id: 'arethusa-of-flows/policy',
  type: 'object',
  additionalProperties: false,
  properties: {
    $comment: { type: 'string' },
    allow_http_hosts: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, description: 'Hosts where plain http:// is accepted (e.g. an internal service behind a VPN)' },
    fail_rate: { type: 'number', minimum: 0, maximum: 1 },
    stale_days: { type: 'number', minimum: 1 },
    entropy: {
      description: 'High-entropy secret detection thresholds, or false to turn it off',
      anyOf: [
        { const: false },
        { type: 'object', additionalProperties: false, properties: { min_length: { type: 'integer', minimum: 8 }, min_bits: { type: 'number', minimum: 1, maximum: 8 }, min_bits_hex: { type: 'number', minimum: 1, maximum: 4 }, hex_min_length: { type: 'integer', minimum: 8 } } },
      ],
    },
    ignore: {
      type: 'array',
      description: 'Suppressions. Each needs a reason; suppressed findings are still listed in the result and report.',
      items: {
        type: 'object', additionalProperties: false, required: ['reason'],
        properties: { flow: { type: 'string' }, code: { type: 'string' }, step: { type: 'string' }, reason: { type: 'string', minLength: 3 }, until: { type: 'string', format: 'date' } },
      },
    },
  },
});
