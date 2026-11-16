Fictional pages for a made-up bakery ("Fernhill Bakery", www.example.com), hand-written HAR captures and a fictional cookie policy as JSON. Cookie values and tracking ids are made up. The gaps are planted on purpose so the demo, tests and evals have something to find.

- `site/`: exported HTML pages.
- `har/first-visit.har`, `har/after-reject.har`: a first visit and a visit after clicking "Reject all".
- `har/gpc-visit.har`: a first visit with Global Privacy Control on (every request carries `Sec-GPC: 1`); analytics and a Meta pixel still load.
- `declared.json`: the stated cookie policy.
- `inventory-previous.json`: an `inventory.json` snapshot from an earlier scan (first visit only), for `britomartis_diff_inventory`.
- `capture-site/`: a copy of the bakery for the optional capture helper's test. A local static server serves it (with the response headers in `_headers.json`) and `stubs.json` answers every third-party request, so capturing it offline gives the same inventory as the bundled HARs. Its "Reject all" button deliberately forgets to clear `_ga`.
