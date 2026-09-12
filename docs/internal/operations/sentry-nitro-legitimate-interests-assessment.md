# Viewer Nitro legitimate-interests assessment

- Status: draft, processing prohibited until qualified approval
- Controller: EVB Viewer
- Processor: Functional Software, Inc. d/b/a Sentry
- Processing: viewer Nitro application errors only

This assessment applies only to errors owned by EVB Viewer's hosted Nitro
server. It does not authorize Electron or hosted-browser client reporting.
Those clients require affirmative opt-in under the release policy.

## Proposed interest

EVB Viewer needs enough evidence to find and fix failures in the hosted viewer
that operators cannot reproduce from a user's screenshot. The specific
interest is maintaining the reliability and security of the hosted viewer by
diagnosing product faults. The data cannot be used for analytics, advertising,
training, feature profiling, user behavior analysis, or another purpose.

## Necessity

Manual reports often omit the failing release, runtime seam, and application
frame. Server logs alone do not group one application fault across deployments
and do not provide the closed error identity used by the client-facing support
flow. A Sentry event is necessary only when the application creates it from the
closed diagnostic contract.

The permitted record contains only:

- schema version and random per-occurrence event ID
- closed diagnostic code, severity, runtime, and optional operation
- occurrence time, release, and distribution identifiers
- canonical application frames with origins, paths, queries, and fragments
  removed
- bounded context values declared by the diagnostic-code registry

The adapter must reject any record carrying an unknown field or value. It must
not read or send request headers, cookies, body, response data, route values,
URL, query, IP address, account identity, document data, raw exception text,
console arguments, breadcrumbs, replay, traces, profiles, logs, sessions,
feedback, attachments, or minidumps.

Less intrusive alternatives do not provide equivalent evidence. Keeping only
local logs makes hosted failures unavailable to the operator. Asking every
visitor to reproduce and describe a server failure produces sparse and vague
reports. Sending raw framework exceptions would be more intrusive and is
forbidden.

## Balancing

People reasonably expect the viewer to work without behavioral monitoring.
They may not expect a server error to create a third-party record. A timestamp,
release, and event ID can remain indirectly linkable through separate service
logs even when the Sentry event has no direct identifier. Children and people
opening sensitive documents may use the viewer, so the assessment assumes the
highest practical privacy risk rather than an average business user.

The following safeguards are cumulative. If any safeguard is absent, the
processing is not authorized:

- EVB constructs the event from a closed allowlist and tests forbidden values
  at every depth.
- Sentry stores events in its EU region with Enhanced Privacy, mandatory
  scrubbers, IP-address suppression, source fetching disabled, and AI features
  disabled.
- The browser sends no new information to trigger Nitro reporting. Nitro owns
  only failures already produced while serving the requested viewer response.
- One logical fault produces at most one event, with bounded burst accounting.
- Production access is limited to the owner, pay-as-you-go is disabled, and
  quota alerts detect loops.
- Sentry platform retention is limited to the contracted event-retention
  period, and EVB deletes resolved issues during weekly triage.
- The public notice names Sentry, the purpose, fields, exclusions, region,
  transfers, retention, rights, and contact route.
- An unconditional online objection stops future Nitro diagnostic events. It
  does not depend on identity, locale, IP address, timezone, or proof of harm.

With every safeguard active, the small closed record and unconditional
objection limit the effect on the person. The interest does not override the
person's rights for this narrow server-owned processing. This conclusion does
not survive a broader payload, another purpose, missing notice, missing DPA,
missing objection route, or a change in Sentry's data use.

## Right to object

The first-layer privacy notice must state the right to object separately and
clearly at first communication. The hosted viewer must provide a persistent
control that stops future Nitro diagnostic events immediately. Turning the
control off cannot recall an event already received or in flight. Requests for
access or deletion may use the Error ID without requiring an account.

## Approval gate

The qualified reviewer must verify each item below before Nitro reporting is
enabled:

- [ ] The interest is current, specific, and limited to fixing hosted-viewer
  product faults.
- [ ] The closed event is necessary and no less intrusive method provides the
  same operational evidence.
- [ ] The balancing test covers user expectations, children, sensitive-use
  contexts, linkability, consequences, and every safeguard above.
- [ ] The Sentry DPA is accepted and retained.
- [ ] The complete notice and separate right-to-object statement are public in
  all supported locales.
- [ ] The online objection route works without identity or jurisdiction
  inference.
- [ ] Account, scrubbing, source-map, retention, access, and deletion controls
  match `sentry-account-controls.md`.
- [ ] A no-request-data test and public-artifact scan pass on the exact release.

| Approval record | Value |
| --- | --- |
| Reviewer role | Pending |
| Review date | Pending |
| Decision | Not approved |
| Reassessment trigger | Payload, purpose, processor, retention, transfer, or legal change |

## Sources

- [GDPR Articles 5, 6, 13, and 21](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/)
- [EDPB Guidelines 1/2024 on legitimate interests](https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202401_legitimateinterest_en.pdf)
- [Sentry Data Processing Addendum](https://sentry.io/legal/dpa/)
- [Sentry data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)
