# DjVu fidelity corpus

This directory contains the deterministic eight-class DjVu conversion
fidelity corpus. Goldens are rendered and compared at the same physical
page size (points derived from each page's own DPI), never at equal raw pixel
dimensions.

Run `node scripts/generate-djvu-fidelity-corpus.mjs` with DjVuLibre installed to
recreate every source and golden. The generated images use geometric patterns
and a deterministic pseudo-photo gradient, so no third-party artwork or fonts
enter the repository. `corpus-manifest.json` records SHA-256 hashes and CC0
provenance. Missing-tool and ENOSPC behavior is simulated around the checked-in
corrupt fixture by the contract tests.

`sources/browser-boundary-501-pages.djvu` is also the required default Electron
E2E viewer fixture, keeping DjVu smoke lanes independent of host generator tools.

`search/regex-budget-text-layer.djvu` is not part of the corpus. It is
`sources/bitonal-faint-pencil.djvu` with page 1's text layer set to 12,000
`a` characters and a final `!`: `djvused -e 'select 1; set-txt FILE' -s` with
FILE holding `(page 0 0 512 512 "…")`. The browser DjVu search budget case
opens it and searches `a+.a+$`, which Chromium evaluates in quadratic time on
this text, to show that a catastrophic regular expression stops with the
budget error.
