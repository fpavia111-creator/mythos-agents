// JSON Schema for the license policy file. Used by ctx.readJson and `validate-config license_policy <file>`.
const list = { type: 'array', items: { type: 'string', minLength: 1 }, description: 'SPDX ids or * patterns' };
export const licensePolicySchema = {
  type: 'object', additionalProperties: false, required: ['source', 'allow'],
  properties: {
    source: { type: 'string', minLength: 1, description: 'Name and version of your written license policy' },
    sections: { type: 'object', additionalProperties: false, properties: { allow: { type: 'string' }, review: { type: 'string' }, deny: { type: 'string' }, unknown: { type: 'string' }, exceptions: { type: 'string' } } },
    allow: { ...list, minItems: 1 }, review: list, deny: list,
    unknown: { type: 'string', enum: ['review', 'deny'] },
    proprietary: { type: 'string', enum: ['review', 'deny'] },
    dev_dependencies: { type: 'string', enum: ['include', 'ignore'] },
    exceptions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['package'], properties: { package: { type: 'string', minLength: 1 }, version: { type: 'string' }, license: { type: 'string' }, reason: { type: 'string' }, approved_by: { type: 'string' }, expires: { type: 'string', format: 'date' } } } },
    attribution: { type: 'object', additionalProperties: false, properties: { not_required: { ...list, description: 'Licenses your policy says need no attribution entry (default: 0BSD, Unlicense, CC0-1.0, WTFPL, LicenseRef-Public-Domain, UNLICENSED)' } } },
  },
};
export const configSchemas = { license_policy: licensePolicySchema };
