# Changelog

## 0.2.0

Fixed (handoff ver 6)
- Consent, status and bounce values written in German, French, Spanish, Portuguese, Italian, Japanese, Chinese or Korean (`ja`, `oui`, `はい`, `동의`, `widerrufen`, `配信停止`, `Abgemeldet`, `ハードバウンス`...) were read as unknown, so a withdrawn consent was not suppressed. They are read now; English values read as before.
- Role mailboxes in those languages (`kontakt@`, `ventas@`, `contato@`, `amministrazione@`, romanized `eigyo@`...) are flagged as role addresses.

- Real exports: Reads HubSpot contacts, Salesforce report and Data Loader exports, and Mailchimp audience exports directly. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
- New `nausicaa_merge_plan`: for each duplicate group, a survivor chosen by stated rules (S1-S4) and a winner per field with the rule that picked it (F1-F6). Opt-outs and hard bounces always carry over. Writes `merge-plan.csv` with blank reviewer columns.
- New `nausicaa_consent_provenance`: flags opted-in or subscribed contacts with no consent source, no date, an unreadable or future date, or a source not on your allowed list. Exports may add a `consent_source` column.
- New `nausicaa_compare`: period-over-period comparison of two exports (health change, added/removed, newly flagged, resolved, action changes).
- New `nausicaa_check_mx` (opt-in, off by default): domain MX/A/null-MX check from a saved records file, or with `allow_network:true` via one allowlisted DNS-over-HTTPS resolver, sending domain names only. Needs a human yes or an Auto opt-in; blocked in review mode. Tests use an injected fake transport only.
- `nausicaa_audit` returns an explained list health score (0-100).
- Optional rules file (`rules`), validated against the `hygiene_rules` config schema: extra role, disposable and typo lists, allowed consent sources, stale and re-consent days.
- MCP prompt `list_hygiene_workflow`.
- Unchanged: bulk deletes stay one named human click, even in Auto; deleting in the CRM stays blocked.

Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

