# Renderer unclassified-error migration report

This is the final SEN-MIG-01 input to SEN-OPS-03. It inventories application
owners under `app/` after all feature-family migrations were integrated on
2026-09-03.

| Check | Result |
| --- | ---: |
| `BrowserLogger.error` calls | 77 |
| Calls without a code or existing receipt | 0 |
| Worker-parent captures using `UNCLASSIFIED_RENDERER_ERROR` | 0 |
| Application-owned generic renderer or main code literals | 0 |

Every logger owner now supplies a subsystem-specific closed code and bounded
context, or reuses the existing `FailureReceipt`. The five browser and renderer
worker parents use specific PDF page, search, combine, annotation, and PDF
serialization codes. Expected cancellation, disposal, unsupported input,
absence, and refusal paths stay non-red.

The blocking `custom/require-classified-error-log` and
`custom/no-unclassified-diagnostic-code` rules preserve this zero. The
renderer logger no longer has a receipt-free overload. The TypeScript
contraction test fails if that overload returns.

Verification is executable in
`tests/typecheck/sentryCompatibilityOverloads.ts`.
