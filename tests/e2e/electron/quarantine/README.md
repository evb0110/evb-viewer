# Electron E2E Quarantine

Place Electron E2E tests here only while a named product regression or harness
failure needs investigation.

- The quarantine lane is manually dispatched and non-blocking.
- CI retries Electron E2E session boot/restart failures marked `[INFRA]` up
  to twice. Assertion and user-flow failures are not retried by this policy;
  the shared Electron E2E project factory applies the same infrastructure
  retry condition lane-wide.
- Do not move stable smoke tests here without an audit-backed reason.
- Move a test back to its normal project after its named product or harness
  failure is fixed and that project passes it. Fix assertion or user-flow
  failures in the product or test, and fix `[INFRA]` boot/restart failures in
  the harness or environment before restoring the test.
- Keep each policy-tracked quarantine test and target current in
  `graduation-policy.json`. The `unit-policy` tests verify that each listed
  test appears in the quarantine reporter output.
- Every entry names its tracking issue, an expiry date, and the JSON reporter
  suite that must supply its assertions. The wrapper rejects an expired entry,
  a suite missing from the report, or a reported suite with no live policy
  entry. Extending an expiry requires an issue-linked policy change.
- The quarantine project runs through `scripts/ci/runElectronQuarantine.ts`.
  Its JSON report must contain at least one assertion, and every assertion must
  pass. The wrapper fails on failed, pending, skipped, or todo assertions, and
  on missing, empty, malformed, or internally inconsistent report counters.

Operator-only scan-cleanup diagnostics are not kept in this quarantine. The
blocking toolbar contract is the checked-in scan-cleanup acceptance path; any
new diagnostic must have a named owner and an explicit policy entry before it
is added here.
