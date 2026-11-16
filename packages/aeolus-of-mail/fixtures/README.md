Fictional data for reserved example domains (example.com, example.net, example.org; RFC 2606) and documentation IP ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). The problems are planted on purpose so the demo, tests and evals have something to find.

- `records.json`: saved DNS in the format `aeolus_audit` reads with `records`. The DKIM keys are throwaway public keys made for this file. `brand.example.net` has a BIMI record with problems; `good.example.org` has a clean one.
- `dmarc/`: DMARC aggregate reports for example.com as `.xml`, `.xml.gz` and `.zip` (the zip resends the first report, so it should be counted once). One sender has unaligned SPF and DKIM; one looks like spoofing.
- `dmarc-brand/`: a report for brand.example.net where 99.5% of mail passes, enough for the next rollout stage.
- `messages/forwarded.eml`: a forwarded message with an aligned DKIM signature and a valid-looking two-hop ARC chain. `messages/broken-arc.eml`: DMARC fail, `rsa-sha1`, a gap and a broken ARC set. Signatures are placeholders.
- `dmarc-rollout.json`: a rollout config that passes the `dmarc_rollout` schema.
