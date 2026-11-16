import { CATEGORIES } from './reasons.js';

/** JSON Schema for the refund policy file (manifest configSchemas.refund_policy). */
export const REFUND_POLICY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['window_days'],
  properties: {
    note: { type: 'string' },
    window_days: { type: 'integer', minimum: 0, maximum: 3650 },
    window_from: { type: 'string', enum: ['delivered', 'ordered'] },
    review_over: { type: 'number', minimum: 0 },
    max_refunds_per_customer_90d: { type: 'integer', minimum: 0 },
    chargeback_response_days: { type: 'integer', minimum: 1, maximum: 120 },
    no_refund_reasons: { type: 'array', items: { type: 'string' } },
    return_required_over: { type: 'number', minimum: 0 },
    reason_code_overrides: { type: 'object', description: 'Map a reason code to a dispute category, e.g. {"4853":"not_as_described"}', additionalProperties: { type: 'string', enum: [...CATEGORIES] } },
  },
});
