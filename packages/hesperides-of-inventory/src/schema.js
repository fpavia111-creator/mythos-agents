// JSON Schemas for Hesperides config files. additionalProperties:false so a typo fails
// with a JSON pointer instead of being silently ignored.
const unit = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,12}$' };
export const UOM_TABLE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['conversions'],
  properties: {
    source: { type: 'string', description: 'Where the factors come from (item master export, date)' },
    conversions: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false, required: ['from', 'to', 'factor'],
        properties: { sku: { type: 'string', minLength: 1 }, from: unit, to: unit, factor: { type: 'number', exclusiveMinimum: 0 }, note: { type: 'string' } },
      },
    },
  },
};
export const COUNT_POLICY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['classes', 'start_date', 'weeks'],
  properties: {
    name: { type: 'string' },
    classes: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false, required: ['class', 'cumulative_share', 'counts_per_year'],
        properties: { class: { type: 'string', pattern: '^[A-Z]$' }, cumulative_share: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, counts_per_year: { type: 'number', exclusiveMinimum: 0, maximum: 365 }, tolerance_pct: { type: 'number', minimum: 0, maximum: 1 } },
      },
    },
    start_date: { type: 'string', format: 'date' },
    weeks: { type: 'integer', minimum: 1, maximum: 104 },
    working_days: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
    blind: { type: 'boolean' },
  },
};
