# Sentry delivery closure

Moved out of the README on 2026-09-12. This is an operating record, not
product documentation.

| Desktop app | repository root | Electron app plus the shared Nuxt viewer/workspace |
| Browser workspace | repository root | SSR Nuxt build served at `/` |
| Landing/download site | `landing/` | Release picker, docs, and marketing pages |

Desktop and hosted-browser Sentry diagnostics are consent-gated. Viewer Nitro
remains disabled pending its separate legal and objection gates. Operate
client diagnostics from the maintained
[Sentry agent check](sentry-agent-check.md),
[runbook](sentry-runbook.md), [account controls](sentry-account-controls.md),
[architecture ledger](../sentry-error-telemetry-ledger-2026-09-01.md),
and [implementation ledger](../sentry-implementation-ledger-2026-09-01.md).
The reusable agent routing is installed locally at
`~/.codex/skills/sentry-operations/SKILL.md` on the operator Mac; VPS
availability must be verified before use there.

### Sentry delivery closure

Project 5 and umbrella [#215](https://github.com/evb0110/evb-viewer/issues/215)
close against the delivered consent-gated desktop and hosted-browser scope.
That scope covers the eight shipping desktop identities, the served production
browser, privacy and consent behavior, private source maps, closed event
records, alerts, triage, deletion, removal rehearsal, and exact hosted proof.
Desktop and browser diagnostics remain opt-in. Landing diagnostics remain
local-only.

The following issues stay open as operating follow-ups. They are deliberately
removed from the closed delivery board, not marked complete:

- [#222](https://github.com/evb0110/evb-viewer/issues/222) records the Nitro
  legitimate-interest, objection, and qualified-review evidence.
- [#261](https://github.com/evb0110/evb-viewer/issues/261) records Nitro
  enablement and its one-week canary after #222 and the technical gates.
- [#267](https://github.com/evb0110/evb-viewer/issues/267) records real dated
  client and, later, Nitro observation, including the four-week measurements.

Nitro remains disabled. Removing these cards preserves their issue history and
means only that they are outside the delivery closure. It does not waive their
legal, privacy, account-control, canary, or elapsed-time requirements. The
closed project is retained as historical evidence; the runbook and ledgers
remain the maintained operational record.

![EVB Viewer](../../screenshot.png)
