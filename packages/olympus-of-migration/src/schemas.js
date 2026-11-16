// JSON Schemas for Olympus config files. Loaded with ctx.readJson(path, 'migration_rules')
// so typos fail with JSON-pointer errors instead of being ignored.

export const fieldRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['column'],
  properties: {
    id: { type: 'string', description: 'Rule id shown in findings' },
    column: { type: 'string', minLength: 1 },
    required: { type: 'boolean' },
    unique: { type: 'boolean' },
    type: { enum: ['number', 'integer', 'date'] },
    enum: { type: 'array', items: { type: ['string', 'number'] }, minItems: 1 },
    pattern: { type: 'string' },
    min: { type: 'number' },
    max: { type: 'number' },
    max_length: { type: 'integer', minimum: 1 },
    severity: { enum: ['blocking', 'warning'] },
  },
};

export const migrationRulesSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Olympus migration rules',
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, description: 'Label printed in the report, e.g. "Trial load 3 rules"' },
    key: { type: 'string' },
    target_key: { type: 'string' },
    amount_column: { type: 'string' },
    account_column: { type: 'string' },
    balance_column: { type: 'string' },
    subsidiary_column: { type: 'string' },
    currency_column: { type: 'string' },
    tolerance: { type: 'number', minimum: 0 },
    base_currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    fx_rates: { type: 'object', additionalProperties: { type: 'number', exclusiveMinimum: 0 } },
    field_rules: { type: 'array', items: { $ref: '#/$defs/field_rule' } },
  },
  $defs: { field_rule: fieldRuleSchema },
};
