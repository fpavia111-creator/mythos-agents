export const PROMPTS = Object.freeze([
  {
    name: 'urania_board_pack',
    title: 'Build and check a board pack',
    description: 'Walks the host model through a board pack end to end: lock figures, variances, prior-pack comparison, commentary, claims check, charts, assembly, then the human sign-off and distribution clicks.',
    arguments: [
      { name: 'figures', description: 'Figures CSV/JSON under --root (id, metric, period, actual, budget, prior, source)', required: true },
      { name: 'docs', description: 'Comma-separated documents for the pack (Markdown or text)', required: true },
      { name: 'period', description: 'Period label, e.g. October 2026', required: true },
      { name: 'prior_figures', description: "Previous pack's figures file (optional)", required: false },
    ],
    text: [
      'You are preparing the {{period}} board pack with urania-of-flux. Figures: {{figures}}. Documents: {{docs}}. Prior figures: {{prior_figures}}.',
      '',
      '1. Call urania_variance with figures={{figures}}. Report the lock state and list the material variances.',
      '2. If a prior figures file was given, call urania_compare_prior with figures={{figures}}, prior_figures={{prior_figures}} and the docs. Any restatement or prior-period change must be explained by a person before going on; show the listed sentences that cite affected figure ids.',
      '3. Call urania_lock_figures with figures={{figures}}. It returns an approval_id unless Auto is on for it: ask a named person to approve, then call it again with the same arguments.',
      '4. Call urania_draft_commentary with figures={{figures}} and period={{period}}. Do not write any "Reason" yourself: each [TO WRITE] belongs to the line owner.',
      '5. Call urania_check_claims with the docs and commentary=mythos-out/urania/commentary.md. For each issue (uncited_number, unknown_citation, number_mismatch, direction_mismatch) show the doc, line and sentence to its author. Do not edit numbers to make them pass; the author decides.',
      '6. Call urania_charts with figures={{figures}}. Check the summary says every point traces to a figure id.',
      '7. Call urania_assemble_pack with figures={{figures}}, the docs, the commentary, period={{period}} and html=true. It stays DRAFT.',
      '8. Human step: the controller reviews board-pack.md and calls urania_record_signoff with the pack_sha256 from pack-manifest.json. This is always one named human click, even in Auto. Never pass accept_open_issues unless the controller asked for it and wrote the note.',
      '9. Human step: after sign-off, urania_request_distribution records the approved recipients (one human click). A person sends the pack; Urania never uploads or emails, and board_portal_upload and send_email are blocked.',
      '',
      'Report what you did, what is still open, and which steps are waiting on a person. This is not accounting or audit advice.',
    ].join('\n'),
  },
]);
