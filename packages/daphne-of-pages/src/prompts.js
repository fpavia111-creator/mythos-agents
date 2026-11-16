export const PROMPTS = Object.freeze([
  {
    name: 'daphne_site_review',
    title: 'Review a site folder',
    description: 'Walks the host model through a page audit end to end: audit, prioritised actions, report, mechanical fix drafts as a diff, and the one-click publish a person approves. It never presents results as a conformance or compliance finding.',
    arguments: [
      { name: 'site', description: 'Folder of exported HTML pages under --root', required: true },
      { name: 'base_url', description: 'The site URL, e.g. https://www.example.com (optional)', required: false },
      { name: 'lang', description: 'Page language to set where missing, e.g. en (optional)', required: false },
      { name: 'config', description: 'Audit config JSON (optional)', required: false },
    ],
    text: [
      'Review the site in {{site}} with daphne-of-pages. Base URL: {{base_url}}. Language: {{lang}}. Config: {{config}}.',
      '',
      '1. Call daphne_audit with site={{site}}, base_url and config if given. If the config is invalid, report the JSON-pointer error and stop.',
      '2. Start from top_actions: they are ordered by severity and reach, and say when one template fix covers several pages. Quote the selector and the example page:line for each.',
      '3. Explain the sitemap and robots findings (pages missing from sitemap.xml, sitemap URLs that are dead or blocked by robots.txt) and the contrast, focus and ARIA findings. Read the contrast note: elements on images, gradients or CSS variables were skipped and need a person or a browser tool.',
      '4. Call daphne_write_report with the same arguments. It writes page-audit.md, page-audit.html and fix-list.csv with blank owner and status columns for people.',
      '5. Call daphne_draft_fixes with lang={{lang}}. It asks for a human yes unless Auto is on for it. It writes proposed copies and fixes.diff; the site files are not changed. Never write alt text, titles, descriptions, labels or link text yourself: list them for a person.',
      '6. Human step: after a person has reviewed fixes.diff, daphne_request_publish records the approval for that exact proposal_sha256. It is always one named human click (production_deploy), even in Auto. A person publishes; deploy_site and http_fetch are blocked.',
      '',
      'Say clearly that automated checks cover only part of WCAG, that the WCAG numbers are a mapping, and that this is a technical checklist, not a legal opinion or a conformance claim.',
    ].join('\n'),
  },
]);
