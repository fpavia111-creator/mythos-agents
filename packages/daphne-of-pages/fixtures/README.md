Fictional pages for a made-up studio ("Fernhill Studio", example.com). The issues are planted on purpose so the demo, tests and evals have something to find.

- `site/`: four pages with planted link, SEO and accessibility issues (no sitemap.xml or robots.txt, so those checks are skipped there).
- `shop/`: a second fictional site ("Fernhill Studio Shop", shop.example.com) with `assets/site.css`, `sitemap.xml` and `robots.txt`. Planted: low-contrast footer text and button, `a:focus { outline: none }`, a cart link inside an `aria-hidden` header on every page (a template issue), an invalid role, a `role="button"` span, a missing `aria-labelledby` target, `aria-expanded="yes"`, `aria-lable`, text on a background image (skipped), a page missing from the sitemap, a dead and a robots-blocked sitemap URL, a robots-blocked page and no `Sitemap:` line.
- `daphne.config.json`: example audit config for `shop/`.
