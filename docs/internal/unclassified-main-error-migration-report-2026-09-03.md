# Main-process unclassified-error migration report

This is the final SEN-MIG-02 input to SEN-OPS-03. It inventories Electron
logger owners after all startup, shutdown, recovery, worker-parent, and feature
family migrations were integrated on 2026-09-03.

| Check | Result |
| --- | ---: |
| Statically identified Electron logger error calls | 98 |
| Calls without a code or existing receipt | 0 |
| Application-owned `UNCLASSIFIED_MAIN_ERROR` literals | 0 |

Main-thread owners now use subsystem-specific closed codes or reuse an existing
receipt. Worker-thread logging remains local-only because `createLogger`
returns before consulting the main reporter when `isMainThread` is false.
Expected cancellation, teardown, and refusal paths use non-red logging.

The blocking `custom/require-classified-error-log` and
`custom/no-unclassified-diagnostic-code` rules preserve this zero. The main
logger no longer has a receipt-free overload. The TypeScript contraction test
fails if that overload returns.

Verification is executable in
`tests/typecheck/sentryCompatibilityOverloads.ts`.
