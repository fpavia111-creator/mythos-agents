Fictional contacts and companies (example domains).

- `contacts.csv`: ten contacts covering every hygiene flag, with consent source and date columns for the provenance check.
- `contacts-previous.csv`: the same list a month earlier (one contact since removed, some since bounced or unsubscribed) for `nausicaa_compare`.
- `suppression.csv`: a suppression list with one domain.
- `hygiene-rules.json`: example hygiene rules (extra role/disposable/typo lists, allowed consent sources).
- `mx-contacts.csv` + `mx-records.json`: fictional `.example` domains and saved DNS answers for the offline MX check (one null MX, one A-only, one not found). No live lookups are made with these.
