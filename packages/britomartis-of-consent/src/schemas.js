// JSON Schemas for the config files Britomartis reads. Used by ctx.readJson and `validate-config`.
const PURPOSE = { type: 'string', enum: ['necessary', 'preferences', 'analytics', 'marketing', 'other'] };
export const declaredPolicySchema = {
  type: 'object', additionalProperties: false, required: ['source'],
  properties: {
    source: { type: 'string', minLength: 1, description: 'Which policy page or banner text this comes from, and its date' },
    url: { type: 'string' }, updated: { type: 'string' },
    cookies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1 }, provider: { type: 'string' }, purpose: PURPOSE, duration: { type: 'string' }, notes: { type: 'string' } } } },
    third_parties: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['host'], properties: { host: { type: 'string', minLength: 1 }, name: { type: 'string' }, purpose: PURPOSE, notes: { type: 'string' } } } },
  },
};
const entry = { type: 'object', additionalProperties: false, required: ['match', 'vendor', 'purpose'], properties: { match: { type: 'string', minLength: 1 }, vendor: { type: 'string', minLength: 1 }, purpose: PURPOSE } };
export const vendorListSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'version', 'source'],
  properties: { name: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 }, updated: { type: 'string' }, source: { type: 'string', minLength: 1 }, hosts: { type: 'array', items: entry }, cookies: { type: 'array', items: entry } },
};
export const configSchemas = { declared_policy: declaredPolicySchema, vendor_list: vendorListSchema };
