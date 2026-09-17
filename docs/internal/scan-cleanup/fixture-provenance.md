# Scan-cleanup fixture provenance

These two committed PDFs are the fixtures used by the release and export
checks. Their byte identity is part of the checked-in contract.

| Fixture | Production record | Pages and raster evidence | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `tests/fixtures/electron/test-scanned.pdf` | Added as a binary fixture in commit `d99227ff9e5578657ffd09fb3239619ecf4bb2a8` (`Harden E2E release checks for CI`). The PDF metadata identifies ImageMagick as creator and producer; the repository does not retain the original ImageMagick command or source image. | One 612 x 792 point letter page with one 612 x 792, 8-bit grayscale image at 72 PPI. | 6,579 | `1c5f1d65b85321f7768bc28613afc90cfd0c36e4818fdb6e7397d48ddaef0ff0` |
| `tests/fixtures/release/scan-cleanup-four-page-grayscale.pdf` | Added as a binary release fixture in commit `0b92c17b81580579b4eaf5a0e32c8fc9d7d97f66` (`Close the remaining scan-cleanup reliability backlog (#38)`). The PDF metadata identifies pdf-lib as creator and Ghostscript 10.02.1 as producer, with `-dProcessColorModel=/DeviceGray` and grayscale conversion. The repository does not retain the source-image list or original conversion command. | Four letter pages with grayscale JPEG images at 100, 300, 100, and 200 PPI, respectively. | 585,166 | `608d44fbea526ff72d7205341a3364cd353ea71d6327eaa2439abc20687a129e` |

The byte counts and hashes above were measured from the current checkout on
2026-09-17 with `stat` and `sha256sum`. Both files pass `qpdf --check`; the
release fixture's four-page and grayscale contract is also checked by
`tests/unit/scripts/scanCleanupReleaseFixture.test.ts`.
