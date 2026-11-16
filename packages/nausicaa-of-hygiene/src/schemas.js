const list = { type: 'array', items: { type: 'string', minLength: 1 } };
/** JSON Schema for the optional hygiene rules file (manifest configSchemas.hygiene_rules). */
export const HYGIENE_RULES_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    version: { const: 1 },
    note: { type: 'string' },
    stale_days: { type: 'integer', minimum: 1 },
    reconsent_days: { type: 'integer', minimum: 1 },
    extra_role_locals: { ...list, description: 'Extra role local parts, e.g. ["events","press"]' },
    extra_disposable_domains: { ...list, description: 'Extra disposable domains to flag' },
    typo_domains: { type: 'object', additionalProperties: { type: 'string', minLength: 3 }, description: 'Extra typo fixes, e.g. {"exmaple.com":"example.com"}' },
    allowed_consent_sources: { ...list, description: 'Consent sources you accept (provenance check flags others)' },
  },
});
