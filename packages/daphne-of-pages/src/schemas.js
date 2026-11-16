import { CHECKS } from './pages.js';

// JSON Schema for the optional audit config, loaded with ctx.readJson(path, 'audit_config').
export const AUDIT_CONFIG_SCHEMA = Object.freeze({
  $id: 'daphne-of-pages/audit_config',
  type: 'object',
  additionalProperties: false,
  properties: {
    $comment: { type: 'string' },
    base_url: { type: 'string', pattern: '^https?://[^/\\s]+' },
    ignore: { type: 'array', items: { type: 'string', enum: Object.keys(CHECKS) }, uniqueItems: true },
    ignore_pages: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Page paths, or folder prefixes ending in "/", to leave out' },
    contrast: { type: 'object', additionalProperties: false, required: ['normal', 'large'], properties: { normal: { type: 'number', minimum: 1, maximum: 21 }, large: { type: 'number', minimum: 1, maximum: 21 } } },
    sitemap: { type: 'string', minLength: 1, description: 'Sitemap file name in the site folder (default sitemap.xml)' },
    robots: { type: 'string', minLength: 1, description: 'robots file name in the site folder (default robots.txt)' },
    template_min_pages: { type: 'integer', minimum: 2, description: 'Pages an issue must repeat on to be called a likely template fix (default 2)' },
  },
});
