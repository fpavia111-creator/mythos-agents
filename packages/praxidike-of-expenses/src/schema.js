// JSON Schema for the written-policy rules file. additionalProperties:false at every
// level so a typo ("recipt_required_over") fails with a JSON pointer instead of being ignored.
const num0 = { type: 'number', minimum: 0 };
const date = { type: 'string', format: 'date' };
export const POLICY_SCHEMA = {
  $defs: {
    category: {
      type: 'object', additionalProperties: false,
      properties: {
        limit: num0, per: { enum: ['item', 'person', 'night', 'day'] }, attendees_required: { type: 'boolean' }, section: { type: 'string', minLength: 1 },
        rate_per_mile: num0, mileage: { type: 'boolean' }, receipt_exempt: { type: 'boolean' },
        per_diem: { type: 'string', minLength: 1, description: 'Which per-diem rate field caps this category per day (e.g. "meals")' },
        note: { type: 'string' },
      },
    },
  },
  type: 'object', additionalProperties: false, required: ['source'],
  properties: {
    source: { type: 'string', minLength: 1, description: 'The written policy (name and version) these rules come from' },
    currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
    receipt_required_over: num0, submit_within_days: { type: 'integer', minimum: 0 }, preapproval_over: num0,
    late_decision: { enum: ['needs_info', 'reject'] },
    sections: { type: 'object', additionalProperties: { type: 'string' } },
    categories: { type: 'object', additionalProperties: { $ref: '#/$defs/category' } },
    category_aliases: { type: 'object', additionalProperties: { type: 'string', minLength: 1 }, description: 'Category names used by your expense or card system, mapped to the policy category they fall under, e.g. { "Restaurants": "meals" }. Letter case is ignored.' },
    disallowed: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category'], properties: { category: { type: 'string', minLength: 1 }, section: { type: 'string' }, note: { type: 'string' } } } },
    per_diem: {
      type: 'object', additionalProperties: false, required: ['rates'],
      properties: {
        section: { type: 'string' }, source: { type: 'string' },
        rates: { type: 'array', minItems: 1, items: { type: 'object', required: ['location'], additionalProperties: num0, properties: { location: { type: 'string', minLength: 1 }, from: date, to: date } } },
      },
    },
    mileage_rates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['rate'], properties: { rate: num0, from: date, to: date, location: { type: 'string' }, note: { type: 'string' } } } },
    risk_weights: { type: 'object', additionalProperties: num0 },
    notes: { type: 'string' },
  },
};
