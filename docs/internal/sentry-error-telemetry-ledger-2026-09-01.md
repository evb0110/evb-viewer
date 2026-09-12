# Sentry error telemetry architecture ledger

- Status: final implementation architecture, independent audit changes applied
- Research date: 2026-09-01
- Repository version inspected: 0.1.445
- Repository commit inspected: `e7f5606a45af2f7e78fe0ec861dacd3d07fdeb45`
- Sentry organization inspected read-only: `evb-viewer`, EU data region
- Supersedes: the prior opt-in design, archived locally as fully superseded

## Outcome

EVB Viewer should use Sentry for application errors and crashes only. It should
not use Sentry for analytics, user behavior, training, AI, replay, tracing,
profiles, logs, sessions, feedback, attachments, minidumps, or document data.

The product rule is:

> A red UI state or red console entry means an actual product fault. The owning
> layer records that fault once, and the same failure identity follows its local
> log, UI presentation, and one sanitized Sentry event.

This rule matches the intent already documented in
`app/utils/runtimeErrorFilter.ts`: one underlying fault is logged at error level
once by the closest owner, wrappers use a lower level, and cancellation is not
a fault. Sentry should extend that existing rule instead of adding a second
error system.

The target design has an explicit typed failure occurrence as the long-term
owner. Existing renderer and main-process error loggers become a compatibility
path during migration so useful reports arrive before every call site has a
specific diagnostic code. UI components only present a failure receipt. They
never originate a second remote report.

Every occurrence enters the local diagnostic gate. Exact repeats may be
represented by one event and a bounded suppression count so a loop cannot
exhaust quota. The remote event is newly constructed from a closed allowlist.
Raw log messages, exception messages, console arguments, UI text, file paths,
documents, and arbitrary objects never leave the device.

The requested default-on client opt-out is technically implementable, but it is
not the current ship policy for a global build. Electron and hosted-browser
clients require affirmative opt-in in the EEA, and Microsoft Store builds
require express in-product permission before publishing customer personal
information to Sentry. Nitro server errors can be default-on with a clear
opt-out after EVB completes a legitimate-interests assessment, disclosure, DPA,
and account hardening. The engineering design supports both policies without
using IP, locale, or download source to guess the user's jurisdiction.

The Sentry acknowledgement is independent of telemetry. It is bundled locally,
appears on the landing site and in the app, and makes no Sentry request by
itself.

No Sentry account setting, project, SDK, DSN, or runtime code was changed during
this research.

## Why this ledger replaces the earlier one

The earlier ledger assumed a small hand-selected error set and treated the
existing error UI as separate from capture. Further repository inspection found
that this would miss the user's actual support problem:

- The renderer has 76 `BrowserLogger.error` calls across 45 files.
- Electron has 104 `createLogger` constructions and 115 textual `.error(` call
  sites.
- The renderer has 24 explicit `color: 'error'` presentations across 11 files.
- `reportRuntimeError` has 8 calls and `setFatalRuntimeError` has 4 calls.
- Main-process errors are printed as red console entries in preload, buffered,
  broadcast to every renderer, and projected into the runtime error card.
- Renderer errors flow in the opposite direction through the renderer log IPC
  and deliberately do not echo back.
- Several paths both log an error and create a UI report. Capturing both paths
  would duplicate one failure.
- Fatal state and several inline error surfaces bypass the runtime report
  stream entirely.
- Some red UI currently represents expected refusal or missing input rather
  than a defect.

The earlier opt-in ledger remains useful historical evidence for source maps,
account hardening, acknowledgement placement, and SDK restrictions. Its capture
model and adversarial rulings do not adjudicate this broader error contract. It
is preserved in ignored legacy material with `opt-in-fully-superseded` in its
filename and a header that points back to this ledger.

## Research method and evidence

The design uses four kinds of evidence:

1. Direct inspection of the renderer, Electron, browser adapter, Nitro, landing,
   settings, build, test, and release paths at the commit named above.
2. Independent Luna Max inspections of renderer error surfaces, Electron main
   and preload failure paths, hosted web and settings behavior, legal policy,
   and three competing interface designs.
3. A separate primary-source legal and privacy report at
   `docs/internal/research/sentry-opt-out-diagnostics-2026-09-01.md`.
4. Read-only inspection of the live Sentry organization.

Primary external sources include:

- [Sentry for Open Source](https://sentry.io/for/open-source/)
- [Sentry branding](https://sentry.io/branding/)
- [Sentry Electron data collection](https://docs.sentry.io/platforms/javascript/guides/electron/data-management/data-collected/)
- [Sentry Electron options](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/options/)
- [Sentry source-map troubleshooting](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/)
- [Sentry organization privacy API](https://docs.sentry.io/api/organizations/update-an-organization/)
- [Sentry data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)
- [Sentry DPA](https://sentry.io/legal/dpa/)
- [Sentry Seer privacy statement](https://docs.sentry.io/product/ai-in-sentry/seer)
- [GDPR Articles 5, 6, 13, and 21](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/)
- [ePrivacy Directive Article 5(3)](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:02002L0058-20091219)
- [EDPB Guidelines 2/2023](https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf)
- [Microsoft Store Policies 10.5.1 and 10.5.2](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies#105-personal-information)

The legal conclusion is an engineering release constraint, not legal advice.
The requirement to record a qualified reviewer role and date is an authored
release rule for default-on viewer Nitro. The authoritative GDPR and EDPB
materials linked above describe the legitimate-interest, necessity, balancing,
and objection analysis, but this ledger does not claim that they prescribe a
particular reviewer title. Client consent-gated diagnostics do not depend on
the Nitro reviewer gate.

## Live Sentry account facts

The organization started with permissive defaults on 2026-09-01. The owner
hardened and provisioned it on 2026-09-04:

| Area | Current state |
| --- | --- |
| Plan | Sponsored Business |
| Data region | European Union |
| Projects | Exactly `evb-viewer-desktop` and `evb-viewer-web` |
| Events | Production web and test desktop diagnostics active; Nitro disabled |
| Included errors | 5 million per usage period |
| Pay-as-you-go | $0 limit, no payment method |
| Generative AI features | Disabled; Seer unconfigured |
| Authentication | Google connected login for the sole owner; personal Gmail cannot configure organization SSO; Sentry exposes no password-removal control |
| Sentry-native and organization 2FA | Disabled by explicit owner decision for the Google-login route |
| Shared issues | Disabled |
| Open membership and join requests | Disabled |
| Member invite, project, event-delete, and alert permissions | Disabled |
| Enhanced Privacy | Enabled |
| JavaScript source fetching | Disabled in both projects |
| Required Data Scrubber and default scrubbers | Enabled |
| IP address storage prevention | Enabled |
| Minidump attachment storage | Disabled |
| Advanced scrub rules | Targeted forbidden-field list; canonical frame and Debug ID fields preserved |
| Credentials | Three purpose-specific client keys, one `org:ci` upload token, and a separate read-only verification token |

The sponsored plan removes quota pressure, but it does not change the privacy
boundary. The account controls now permit private artifact upload and
credential provisioning. They do not authorize production events. Client
consent, Nitro legal gates, canaries, retention operations, and final release
evidence remain separate gates.

## Current error topology

### Renderer-origin errors

```text
feature or global guard
        |
        +--> BrowserLogger.error
        |       |
        |       +--> renderer console.error
        |       +--> settings.rendererLog
        |               |
        |               +--> renderer:log IPC
        |                       |
        |                       +--> rendererLogBridge
        |                               |
        |                               +--> main file logger
        |                                    broadcastToRenderers: false
        |
        +--> optional reportRuntimeError
                |
                +--> renderer-local top-right error card
```

`app/utils/browserLogger.ts` serializes raw `Error` name, message, stack, and
arbitrary data for the local renderer log. That is appropriate for local
diagnostics but not a remote event contract. In hosted-browser mode the browser
settings adapter makes `rendererLog` a no-op, so only console and local UI remain.

### Main-origin errors

```text
Electron owner
        |
        +--> createLogger(...).error
                |
                +--> redacted local file log
                +--> debug:log broadcast to every renderer
                        |
                        +--> preload buffer
                        +--> preload console.error
                        +--> runtimeErrorLogStream
                                |
                                +--> ERROR-only filter
                                +--> renderer-local top-right error card
```

`electron/utils/createLogger.ts` broadcasts main `ERROR` and `WARN` records to
every window. `electron/preload/installDebugLogListener.ts` prints an `ERROR`
record with `console.error`. `app/plugins/runtimeErrorLogStream.client.ts` then
turns the same record into a runtime report. This is why many red DevTools
entries appear to come from main.

The renderer log bridge uses `broadcastToRenderers: false`. A renderer error
therefore does not travel back into the runtime stream. The two directions are
different and must stay different.

### Global renderer failures

`app/plugins/rendererErrorGuard.client.ts` owns Vue errors, `window.error`, and
unhandled promise rejections. It currently serializes raw values, calls
`BrowserLogger.error`, and separately calls `reportRuntimeError`. Vue's previous
handler may also print the error. An SDK auto-capture hook or a console capture
integration would duplicate this path.

### Process and worker failures

Main already owns the important process seams:

- `process.on('unhandledRejection')` and `process.on('uncaughtException')` in
  `electron/main.ts`.
- `child-process-gone` and safe-mode GPU recovery in
  `electron/processDeathRecovery.ts`.
- Renderer gone, preload error, unresponsive recovery, and load failure in
  `electron/window.ts`.
- Worker error, invalid result, nonzero exit, cancellation, and duplicate
  marking in `electron/utils/workerTask.ts`.
- Service-specific OCR, search, scan-cleanup, DjVu, native command, update,
  shutdown, and utility-process parents.

There are two startup gaps and one duplicate path that the migration must fix:

- Main installs `uncaughtException` only after the shutdown coordinator exists.
  A synchronous exception before that point follows Node's default fail-fast
  path and cannot reach the current logger.
- `did-fail-load` is owned by both `window.ts` and `attachShowLifecycle.ts`.
  An initial `loadURL` failure can also be logged again by bootstrap rejection
  handling.
- Electron has no `webContents.on('console-message')` observer. Arbitrary
  renderer or preload console output therefore does not enter the main logger.

Expected utility teardown is already downgraded to warning. Worker cancellation
is already info. Several wrappers already avoid a second error when the inner
worker marked the error as reported. These are the right ownership seams for
Sentry. Child SDKs would make ownership worse.

## Error presentation inventory

There are more than two error UIs. The confirmed families are:

| Surface | Current owner | Current reporting relationship |
| --- | --- | --- |
| Fatal runtime modal | `AppFatalRuntimeDialog.vue` and `useFatalRuntimeError.ts` | Some callers also log; bridge-missing fatal paths do not |
| Top-right runtime report card | `app.vue` and `useRuntimeErrorReports.ts` | Main `ERROR` stream plus explicit renderer calls |
| Error toasts | 24 call sites across settings, save, export, print, DjVu, scan cleanup, drag/drop, and recent files | Mixed; some log, some do not |
| Workspace PDF and DjVu alerts | `WorkspaceDocumentAlerts.vue` | Error state only, no common receipt |
| Deferred workspace failure panel | `DocumentWorkspaceFailurePanel.vue` | Host state and recovery, separate from logger |
| Per-page source error | `DocumentPageSourcePageVisual.vue` | Viewer state, separate from runtime report card |
| Combine PDF alerts | `CombinePdfPage.vue` | Local combine state; combine service also logs some failures |
| Scan cleanup error state | `scanCleanupRunCoordinator.ts` | Stores raw error and also creates a toast |
| Settings persistence and integration errors | `SettingsContent.vue` and `useSettings.ts` | Some errors are logged at error, some at warning, then shown red |
| Assistant runtime error state | `AgentAssistantPanel.vue` and its controller | Controller may log and call `reportRuntimeError` |
| PDF optimize, print, and conversion alerts | Dialog components | State-specific, not one shared reporting path |

The UI contains raw localized descriptions, filenames, parser messages, source
paths, and other support details. Sentry must never scrape a component, toast,
or report text. The owning failure occurrence supplies only a closed diagnostic
record. The UI may retain richer local detail.

## Current semantic contradictions

The code already treats error level as a user-visible fault contract, but not
every presentation follows it yet. Examples include:

- Export selection above a materialization limit uses an error toast even
  though the program deliberately refuses the request.
- A recent file that no longer exists uses an error toast even though the app
  handled the stale entry.
- Some annotation selection and readiness outcomes use the shared red failure
  toast even though they describe user state or temporary readiness.
- Settings and assistant actions sometimes log a warning and then show a red
  toast.
- The landing release catalog logs exhausted upstream GitHub availability at
  error before returning a handled 503. It is `temporarily-unavailable` and
  moves to warning, so it does not justify a landing Sentry project.

These cannot remain exceptions. Expected input, unsupported operations,
cancellation, ordinary offline state, and handled absence use warning or neutral
presentation. Red and `ERROR` remain reserved for reportable defects. This is a
small product behavior change, but it is necessary if the user's visible rule is
to be reliable.

## Design alternatives

Three different interfaces were considered.

### Alternative A: logger-edge capture

`BrowserLogger.error` and `createLogger().error` automatically build a safe
Sentry record from a new call-site stack. Existing calls get broad coverage with
little migration.

Strengths:

- Fastest route to useful data from 191 existing renderer and Electron error
  call sites.
- Uses the current severity contract and existing main-to-renderer projection.
- Does not require SDK auto-capture.

Weaknesses:

- A logger call has no stable diagnostic code or typed operation today.
- The same logical failure can have a logger call and a separate UI call.
- Call-site grouping is less useful than owner-supplied classification.
- Existing misuse of error severity would become telemetry until audited.

### Alternative B: explicit typed failure occurrence

The owning layer creates one `FailureOccurrence` with a random event ID, closed
code, safe context, canonical app frames, and local-only cause. Logs, UI, and
transport receive projections of the same occurrence.

Strengths:

- One owner and one identity make duplication mechanically visible.
- The type system prevents arbitrary remote fields.
- Expected outcomes cannot masquerade as failures when the result model is
  explicit.
- Event grouping and triage stay stable across localization and rewritten
  messages.

Weaknesses:

- Migrating every existing call before first use would delay telemetry.
- Callers need a receipt when they also present a UI state.
- Third-party direct `console.error` still needs a last-resort path.

### Alternative C: red presentation requires a receipt

All red UI helpers and red console writers require a `FailureReceipt`. Static
architecture tests ban raw `color: 'error'`, direct `console.error`, and fatal
or runtime reports without a receipt.

Strengths:

- Directly enforces the user's observable rule.
- A red UI cannot silently miss Sentry.
- UI presentation cannot create a second event because it only accepts a
  receipt.

Weaknesses:

- Presentation is too late to own the cause.
- Existing generic UI libraries and state models need adapters.
- It does not classify main, worker, or server errors by itself.

### Selected design

Use Alternative B as the target model, Alternative A as a temporary
compatibility path, and Alternative C as the final static invariant.

This combination gives early coverage without making an interception hack the
permanent architecture. Logger fallback events use a generic code plus a safe
application call site. High-value owners move to specific codes first. The
fallback overload is removed only after the static migration report reaches
zero. UI enforcement starts in warning mode, then becomes blocking after the
known red surfaces are migrated or reclassified.

## Architecture

```text
failure owner
        |
        +--> create one FailureOccurrence
                |
                +--> local log projection with rich local-only details
                +--> UI projection with the same event ID
                +--> closed DiagnosticRecord
                        |
                        +--> policy gate
                        +--> occurrence dedupe and burst accounting
                        +--> runtime adapter
                                |
                                +--> Sentry transport
```

The architecture has two data planes:

1. The local plane may retain the current rich error, message, path, and UI
   details. Existing local redaction and retention continue to apply.
2. The remote plane starts from a new closed record. It never reuses or edits a
   local log line, UI description, console argument list, or serialized error.

The remote plane has one narrow seam. Feature code cannot import Sentry. Sentry
SDKs are replaceable transport adapters and do not own recovery, logging, UI,
consent, process hooks, or shutdown.

## Public failure interface

The target feature-facing interface is synchronous and never throws:

```ts
type FailureSeverity = 'error' | 'fatal';

type DiagnosticRuntime =
  | 'electron-main'
  | 'electron-renderer'
  | 'hosted-browser'
  | 'viewer-nitro'
  | 'landing-nitro'
  | 'browser-worker-parent'
  | 'electron-worker-parent'
  | 'electron-utility-parent';

type DiagnosticCode = keyof typeof DIAGNOSTIC_DEFINITIONS;

type DiagnosticContext<C extends DiagnosticCode> =
  (typeof DIAGNOSTIC_DEFINITIONS)[C]['context'];

interface LocalFailureDetail {
  source: string;
  message: string;
  cause?: unknown;
  data?: unknown;
}

interface CaptureFailureInput<C extends DiagnosticCode> {
  code: C;
  severity?: FailureSeverity;
  operation?: DiagnosticOperation;
  context: DiagnosticContext<C>;
  local: LocalFailureDetail;
}

interface FailureReceipt {
  eventId: DiagnosticEventId;
  code: DiagnosticCode;
  occurredAt: number;
  severity: FailureSeverity;
}

interface ExpectedOutcome {
  kind: 'expected';
  code:
    | 'canceled'
    | 'validation-rejected'
    | 'unsupported-input'
    | 'handled-absence'
    | 'temporarily-unavailable';
}

interface FailureReporter {
  capture<C extends DiagnosticCode>(
    input: CaptureFailureInput<C>,
  ): FailureReceipt;
}
```

`DIAGNOSTIC_DEFINITIONS` is the one registry for code, allowed context keys,
operation, grouping policy, and whether a source stack or a fresh call-site stack
is preferred. A context decoder accepts only exact keys and bounded enum,
boolean, or integer values. It rejects unknown keys at runtime even when a
renderer IPC payload bypasses TypeScript.

`ExpectedOutcome` is intentionally incompatible with `FailureReceipt`.
Warning and neutral presenters accept an expected outcome. Red presenters and
error loggers do not. This makes the difference between a handled refusal and a
defect a type-level decision instead of a copywriting convention.

`LocalFailureDetail` is never part of a shared transport contract. The reporter
sends it only to the runtime's local logger. The remote builder receives the
closed code, safe context, and parsed application frames.

The migration overloads are:

```ts
BrowserLogger.error(section, message, cause): FailureReceipt;
logger.error(message): FailureReceipt;
```

They create `UNCLASSIFIED_RENDERER_ERROR` or `UNCLASSIFIED_MAIN_ERROR`, use a
fresh call-site stack, and send no message or cause remotely. New and migrated
code uses the typed form. A provided receipt tells the local logger that the
failure already exists, so it must not create another one.

## Failure identity and deduplication

Each owner creates one random 128-bit `DiagnosticEventId`, formatted as 32
lowercase hexadecimal characters. It is an occurrence ID, not a user,
installation, device, or document ID. The same value becomes the Sentry event
ID and the local support ID.

The receipt follows every projection:

- Renderer local log entries may carry the event ID for correlation.
- The typed renderer diagnostic IPC carries the same ID.
- Main `ERROR` debug-log broadcasts carry a required closed failure reference
  beside the local message after migration. Warning and lower records do not
  need one.
- Runtime and fatal UI state store the ID rather than deriving identity from raw
  detail.
- Red toasts and inline failure components receive the receipt.

Remote deduplication has two layers:

1. A process-local recent-ID set rejects a second send of the same occurrence.
2. A per-code and canonical-frame burst controller sends the first occurrences,
   suppresses an exact loop after the cap, and later sends one summary with a
   `suppressedCount` clamped to 10,000.

Burst suppression never samples across different codes or different top
application frames. Every occurrence increments a local attempted counter.
Sentry receives either the occurrence or an aggregate count representing it.
The summary carries the same code and top canonical frame as the suppressed
occurrences so Sentry groups them together. It is emitted at most once per
suppression window for each code and frame pair. No installation identifier is
needed.

Sentry grouping uses runtime, diagnostic code, and the top canonical
application frame. It never uses localized messages or raw exception values.

## Remote diagnostic record

The renderer-to-main and pre-Sentry record contains only:

```ts
interface DiagnosticRecord<C extends DiagnosticCode = DiagnosticCode> {
  schemaVersion: 1;
  eventId: DiagnosticEventId;
  code: C;
  severity: FailureSeverity;
  runtime: DiagnosticRuntime;
  operation?: DiagnosticOperation;
  occurredAt: number;
  frames: readonly CanonicalAppFrame[];
  context: DiagnosticContext<C>;
}
```

The final Sentry event may contain:

- Schema version and event ID.
- Diagnostic code, severity, runtime, operation, release, dist, environment,
  application version, platform, architecture, and supported runtime major
  versions.
- A stable exception type and value derived from the diagnostic definition.
- Canonical application-owned stack frames with module, function, line, and
  column.
- Closed bounded context and `suppressedCount`.
- Sentry SDK metadata required to deliver and symbolicate the event.

The final event never contains:

- Raw exception or rejection messages.
- Raw stack strings, local variables, or source context lines.
- Console arguments, console messages, breadcrumbs, or local logs.
- UI title, description, localized copy, component state, DOM data, or
  screenshots.
- File names, paths, recent files, URLs, queries, fragments, or clipboard data.
- PDF, image, OCR, annotation, form, search, print, or export content.
- AI prompts, AI output, assistant transcript, or model telemetry.
- Request or response URL, route parameters, headers, cookies, body, IP, user,
  email, account, or stable device identifier.
- Attachments, minidumps, replay, spans, profiles, metrics, logs, or session
  health.

The sanitizer creates a new Sentry event. It does not delete fields from an
arbitrary event and hope the remainder is safe. The SDK-owning adapter repeats
the reconstruction in `beforeSend` as a final backstop and returns `null` for
an event without the EVB schema marker.

Application frame normalization keeps only repository-owned bundles and source
modules. It removes drive letters, home paths, `file:` origins, hostnames,
queries, and fragments. One pure function updates frame paths and
`debug_meta.images[].code_file` together. Symbolication tests prove that this
normalization still matches injected Debug IDs.

## Console policy

The console policy is deliberately narrow:

- `BrowserLogger.error` writes through a captured original console sink and
  reports the failure once.
- Application code does not call `console.error` directly. A static test
  enforces this outside the console adapter, tests, and approved bootstrap
  shims.
- A renderer console observer catches direct third-party or missed
  `console.error` calls. It ignores every argument, creates a fresh call-site
  stack, strips observer frames, and records `UNCLASSIFIED_CONSOLE_ERROR`.
- If the stack has application frames, the event keeps only those frames. An
  application frame is inside a repository-built bundle, including vendored
  dependencies shipped in that bundle such as pdf.js. A stack entirely outside
  EVB-shipped code, such as an extension, DevTools, or injected script,
  increments the local `frameless-dropped` counter and sends nothing.
- The reporter provides a synchronous suppression scope for an owner that must
  invoke an inherited framework handler. Console calls in that scope increment
  `owned-projection` and create no new occurrence.
- A reentrancy guard and captured raw console sink prevent Sentry transport
  failures from reporting themselves.
- Preload's red print of a main debug record occurs in Electron's isolated
  world, not the main-world console patched by the renderer observer. It is a
  presentation of an event main already owns. Preload has no reporter and no
  Sentry SDK.
- Main, Nitro, and landing direct `console.error` calls are replaced by the
  runtime failure reporter. Expected best-effort failures use warning.
- Sentry's CaptureConsole integration and console breadcrumbs stay disabled.

Tests already fail unexpected `console.error` calls. Development keeps that
behavior. Sentry uses a capture transport in tests and no production DSN in
development unless a maintainer deliberately runs an isolated canary.

### Development and automation logging

The Electron development runner is a separate diagnostic system. It captures
Electron stdout and stderr, page console arguments, page errors, failed
requests, response URLs, and DevTools events. It writes bounded session records
and terminal output under `.devkit`. Development launch also enables Electron
logging and stack dumps.

That channel stays local-only. It may contain document names, user paths,
network URLs, arbitrary console values, and raw exception text. No Sentry
adapter reads runner stdout, stderr, session logs, Puppeteer diagnostics, or
`.devkit` artifacts. A red line produced by the runner is evidence for a human
or a test, not a production `FailureOccurrence`.

App-owned failures observed during development still use the same receipt
contract before the runner projects them. This keeps error identity and
classification consistent between packaged and development builds while
preserving rich local evidence. Vite recovery messages, startup traces, and
automation-only control failures remain local unless their owning module emits
a typed product failure. Raw runner values are never copied into that failure.

## UI policy

Presentation never captures by itself. It requires a receipt:

```ts
interface FailurePresentation {
  failure: FailureReceipt;
  title: string;
  description?: string;
}

presentFailureToast(presentation): void;
reportRuntimeError(presentation): void;
setFatalRuntimeError(presentation): void;
```

The strings are local-only. Presenters append or expose a short form of the
event ID so a screenshot contains an exact support reference. The complete copy
action includes the ID and local details. The label is `Error ID`, not `Sentry
report received`, because consent, transport, or Sentry availability may prevent
delivery.

The final `IDebugLogEntry` contract uses a closed `failureRef` for `ERROR`
records:

```ts
interface DebugLogFailureRef {
  eventId: DiagnosticEventId;
  code: DiagnosticCode;
  severity: FailureSeverity;
  operation?: DiagnosticOperation;
}
```

`runtimeErrorLogStream.client.ts` presents that reference and never captures it.
An `ERROR` record without `failureRef` is allowed only while the compatibility
migration is active. The static architecture gate rejects it at the Phase 2 exit.

Typed main IPC failure responses also carry `failureRef`. A renderer that shows
a red toast or inline error for a main-owned failure reuses that reference and
never creates a renderer occurrence. This applies whether the main error also
arrives through `debug:log` or only through the direct IPC response.

The migration sequence is:

1. Add receipt-aware overloads to fatal state, runtime reports, and the shared
   toast helper.
2. Convert surfaces that already have an owning logger call to reuse its
   receipt.
3. Add an owner capture for UI-only actual faults.
4. Reclassify expected refusal, input, cancellation, and absence to warning or
   neutral.
5. Replace direct `useToast().add({color: 'error'})` with the shared presenter.
6. Make static checks blocking for raw red presentation and receipt-free fatal
   or runtime reports.

Component-level UAlerts receive failure presentation state from their
controller. They do not call the reporter in `watch`, render, mount, or error
boundary hooks. This prevents rerendering from creating duplicate events.

## Runtime design

### Electron main

Main owns one adapter and the Sentry client. Initialization happens after the
user-data path exists and the minimal persisted diagnostics preference can be
read, but before normal window bootstrap. Startup failures before that point
remain local.

Immediately after the immutable preference is read, main installs an
`uncaughtExceptionMonitor` observer owned by the diagnostic adapter. The
preference reader is a new synchronous parser for that one settings field. It
does not call the existing asynchronous `loadSettings()` path and treats a
missing, corrupt, partial, or unknown value as `unknown`.

When the preference is granted, the monitor synchronously replaces one fixed
marker file with a closed `MAIN_STARTUP_CRASH` record containing event ID, code,
canonical frames, timestamp, release, and dist. It contains no message, cause,
or arbitrary context. The monitor performs no network operation, does not call
`preventDefault`, alter `process.exitCode`, install an `uncaughtException`
recovery handler, or compete with the shutdown coordinator. Node and Electron
keep their default fail-fast behavior.

On the next launch, after normal adapter initialization, main sends the marker
once only if the preference is still granted, then deletes it in every case.
This single post-consent startup marker is the only persisted diagnostic record
and is not a queue. A crash before the preference reader runs, after denial, or
while the marker is being written remains local by design. The product never
weakens fail-fast semantics to gain telemetry.

Main captures its process, renderer-process, worker-parent, utility-parent,
native-helper, update, persistence, and shutdown seams. Existing expected
teardown and cancellation classifiers remain authoritative.

Electron main uses `@sentry/node`, not `@sentry/electron/main`. It sets
`defaultIntegrations: false`, `skipOpenTelemetrySetup: true`,
`sendClientReports: false`, and a non-persisting transport. EVB supplies the
closed Electron context explicitly: app version, platform, architecture, and
Electron, Chromium, and Node major versions. The Electron SDK is excluded
because its main client owns offline persistence, renderer envelope IPC, and
Electron-derived release behavior outside the EVB contract.

Main receives renderer diagnostics through a new typed IPC channel. It checks
the trusted sender, exact schema, size, frame paths, rate, event ID, code, and
context. It reconstructs the event. A raw Sentry envelope never crosses IPC.

### Electron preload

Preload exposes only:

- An immutable startup diagnostics-policy snapshot.
- A typed send method for a sanitized renderer `DiagnosticRecord`.
- Existing debug-log event delivery with optional failure ID and code.

It has no Sentry package, DSN, event queue, or generic envelope bridge.

### Electron renderer

The renderer has no Sentry SDK. Its reporter builds a closed record and sends it
to main only when the immutable startup policy allows reporting. It continues
to write the rich local renderer log through the existing channel.

Vue, window, and rejection handling remains in
`rendererErrorGuard.client.ts`. That guard creates one failure, passes the
receipt to local logging and the runtime card, and then invokes the previous Vue
handler inside the synchronous suppression scope. A default Vue
`console.error` is therefore an owned projection, not a second occurrence.

### Hosted browser

The hosted browser uses the same failure model and a deferred browser transport.
It reads the persisted diagnostics preference synchronously before importing a
Sentry package or constructing a client. Unknown and denied consent make zero
diagnostic network requests.

The browser sends directly to the one exact Sentry EU ingest origin in the DSN.
The production CSP adds only that origin. A same-origin proxy is rejected
because it would put EVB and Vercel in the envelope path and could copy events
into server logs.

### Viewer Nitro

One EVB Nitro plugin owns uncaught server errors and explicit caught failures in
server endpoints. It uses a generic code for an uncaught error or a specific
code for known endpoint operations. It never reads request values into the
record. Request, transaction, route parameter, URL, header, cookie, body, IP,
and identity integrations remain off.

Nitro may run default-on under legitimate interests only after the legal and
account gates pass. A first-party opt-out cookie or equivalent online objection
control suppresses request-associated diagnostic events. EVB also provides a
privacy contact for server events that cannot be associated with a retained
identity.

### Landing Nitro

The landing site has no browser Sentry SDK, DSN, or Sentry project in the first
release. The exhausted release-catalog fallback that returns a 503 is
`temporarily-unavailable`, not a product defect, so
`landing/server/api/releases/latest.get.ts` logs it at warning. Its best-effort
analytics paths also remain warning and do not report.

Landing Nitro keeps the local reporter seam and `landing-nitro` diagnostic
runtime so a future actual defect has an owner. The adapter is no-op until a
separate landing project is justified and passes the same legitimate-interests,
request-stripping, account, and source-map gates as viewer Nitro. The static
acknowledgement makes no Sentry request.

### Workers and utility processes

Parents capture the outcome. Workers and utility processes do not initialize
Sentry. Existing error-reported markers and cancellation classifiers feed the
same occurrence ID so a worker error and its rejected wrapper do not both send.
Logger-edge fallback and failure reporters inside workers and utility processes
are local-only. The parent seam owns the remote occurrence. An unsupported
child bundle remains local until its parent can supply a reportable application
frame and its private source-map canary passes.

## Consent and opt-out policy

The architecture separates technical capability from the policy that may ship:

| Runtime | Technical modes | Current ship policy |
| --- | --- | --- |
| Electron direct distribution | disabled or consent-required | Consent-required for the first release. No default-on client build is in scope. Any future default-on design requires a named, written review for every intended jurisdiction before design work starts. |
| Microsoft Store Electron | disabled or consent-required | Consent-required. Store Policy 10.5.2 requires express in-product permission before publishing customer personal information to an outside service. |
| Hosted browser | disabled or consent-required | Consent-required for the first global EEA-accessible deployment. No default-on client mode is in scope. |
| Viewer Nitro | disabled or legitimate-interests with opt-out | Default-on only after LIA, notice, DPA, account, retention, and objection gates. |
| Landing Nitro | disabled or legitimate-interests with opt-out | Disabled in the first release. A future project requires the same gates as viewer Nitro. |

Do not select a client policy from IP geolocation, locale, timezone, OS region,
download host, or Store detection beyond the signed Store build flag. Those
signals do not establish the applicable law or the user's location.

Client settings use:

```ts
type ClientDiagnosticsPreference = 'unknown' | 'granted' | 'denied';
```

Missing or invalid values become `unknown`, which is off. Keep the field in
settings schema version 2 as a backward-compatible addition. Older builds
ignore it. The synchronous browser and Electron startup readers parse only this
field and do not load the full UI settings system.

The diagnostics preference is never mirrored into browser bootstrap cookies or
another request. Hosted browser code reads it from local storage only.

The control uses positive language:

> Send privacy-sanitized error diagnostics
>
> Send error codes, app version, platform, and EVB Viewer application stack
> frames to Sentry. Documents, filenames, paths, document text, annotations,
> searches, screenshots, local logs, and account information are not sent.

The control does not mention training because training is not a purpose. The
privacy notice separately says Sentry AI features are disabled and EVB does not
use diagnostic events to train models.

For an unknown client preference, the first red failure may show a non-blocking
choice beside the error:

- `Send this error and future privacy-sanitized diagnostics` is the affirmative
  action.
- Dismissal sends nothing and leaves the preference unknown.
- `Do not send diagnostics` stores denied.
- The current closed record may remain only in that live error presentation. If
  the user affirmatively grants while it is still present, the one-shot adapter
  may send it immediately and persist granted for future errors.
- This live first-error record is never persisted, placed in an offline queue,
  or uploaded after a later unrelated grant. Dismissal, denial, navigation, or
  app exit discards it.

The Settings control remains available at all times. Revocation first swaps the
reporter to no-op and the transport to a dropper, discards queued work, then
disables the client. It must send zero close-time envelopes. If an SDK cannot
prove that behavior, revocation requires restart and never calls a flushing
close path.

The notice states that turning reporting off stops future events and cannot
recall events already received or already in flight. It gives a route for access
or deletion requests using an Error ID.

## Sentry projects and release identity

Create one project per independently deployed artifact after account hardening:

| Project | Runtime | Release | Dist examples |
| --- | --- | --- | --- |
| `evb-viewer-desktop` | Electron main plus typed renderer records | `evb-viewer-desktop@<version>` | `macos-arm64`, `macos-x64`, `windows-x64`, `linux-x64` |
| `evb-viewer-web` | Hosted viewer browser and viewer Nitro | `evb-viewer-web@<version-or-deployment>` | `production`, `preview-<build-id>` |

The landing project is deferred. Its only current red server path is the
release-catalog 503, which is reclassified as expected upstream unavailability.
Do not mix a future landing event into `evb-viewer-web`. Create
`evb-viewer-site` only after an actual landing defect exists and the separate
deployment, source-map, lawful-basis, and alert lifecycle justifies it.

Use explicit `production`, `preview`, `development`, and `test` environments.
No mutable `latest` release exists. CI computes release and dist once and passes
the values unchanged to the SDK, map upload, canary, receipt, package, and
deployment.

## SDK and transport policy

The implementation spike pins exact mutually compatible SDK and CLI versions
for the installed Nuxt and Electron versions. Feature code and contracts import
no Sentry package.

Every SDK-owning runtime sets `defaultIntegrations: false` and
`sendClientReports: false`. Electron main also sets
`skipOpenTelemetrySetup: true`. Each adapter uses a non-persisting transport and
adds only the minimum event transport and stack support proved by
captured-envelope tests.
It does not install:

- Vue, Nuxt, Nitro, process, Electron renderer, preload, console, DOM, request,
  HTTP, navigation, or global unhandled-error integrations.
- Breadcrumbs of any kind.
- Replay, tracing, profiles, logs, metrics, sessions, feedback, attachments,
  minidumps, ANR, local variables, or context lines.
- User, request, cookie, header, URL, query, AI, database, or GraphQL data
  collection.

Set `sendDefaultPii: false`, but do not treat that option as the safety boundary.
The closed builder, no-default integration set, final reconstruction, Sentry
account controls, and captured-envelope tests are the boundary.

Client reports remain disabled because they are additional envelope items with
outcome counts and may be emitted during close or visibility changes. Only one
EVB `DiagnosticRecord` may produce one Sentry event item.

Sentry transport failure logs a bounded local warning through an unobserved raw
sink. It never changes startup, editing, save, print, update, recovery, or
shutdown behavior and never creates a new error occurrence.

## Private source maps

Useful code-only diagnostics still need symbolicated application frames. Private
source maps are therefore a telemetry release gate.

The exact order is:

```text
freeze commit, version, release, dist, and policy
        -> run non-artifact quality gates
        -> build final JavaScript with private maps and sources
        -> perform all minification and post-build transforms
        -> inject Sentry Debug IDs into final JavaScript and maps
        -> copy maps and sources to a private stage before pruning
        -> prune maps from public output
        -> compute strict build receipts from injected public bytes
        -> upload private artifacts
        -> package or deploy the exact injected bytes
        -> verify package or served-byte parity
        -> verify release files and symbolicated canary events
        -> scan public artifacts for maps, source, and secrets
```

Debug ID injection mutates JavaScript. It must happen before
`scripts/release/build-receipt.mjs` hashes its desktop inputs: `dist-electron`,
`nuxt-output`, generated Electron Builder resources, the native manifest, and
the manifest's native staging roots. The private manifest records the SHA-256
of every injected file. The viewer Vercel output is not a receipt input. Its
separate parity proof compares the private manifest with local and served
`.vercel/output` bytes.

`scripts/prune-build-artifacts.mjs` deletes build maps. Map staging must happen
before it runs. `scripts/build-electron.mjs` emits maps only when
`EVB_ELECTRON_SOURCEMAP=1`; release builds must extend this to every reportable
main, preload if needed for mapping only, renderer, worker-parent, utility, and
server bundle. No public `.map` ships.

For the viewer Vercel deployment, build `.vercel/output` locally, inject and
stage maps, and deploy the exact output with `vercel --prebuilt`. Apply the same
flow to landing only if its deferred project is later created. Source-archive
deployment would allow Vercel to rebuild different JavaScript after maps were
uploaded.

The 2026-09-04 Preview proof uploaded release `evb-viewer-web@0.1.450` with
dist `preview-local` in strict validation mode. The private inventory contained
473 mapped bundles, 16 small generated facades whose exact paths were proved by
the Nuxt client manifest, and 1,373 project sources. Vercel reported the
prebuilt deployment Ready. A single authenticated Vercel batch then fetched
every served browser bundle, and every hash matched the private manifest. No
public source map shipped. This proves upload acceptance and exact-byte web
deployment. It does not replace the still-pending Debug ID symbolication
canary or any desktop distribution canary.

Every supported bundle gets a canary. The event must show the original EVB file,
function, line, release, and dist. Sentry's source-map debug endpoint must
confirm Debug ID matching. Upload maps before any canary event because Sentry
does not retroactively symbolicate an already received event.

If upload or verification fails, either repair it or rebuild the same product
with diagnostics disabled and a new receipt. Sentry may not block a
telemetry-disabled product release. A telemetry-enabled artifact with broken
symbolication may not ship.

## Account hardening sequence

Perform these actions in order, with screenshots or API exports that contain no
credentials:

1. Use the sole owner's connected Google account for routine sign-in. Record
   that personal Gmail cannot configure organization SSO and that Sentry offers
   no password-removal control. Sentry-native and organization 2FA remain off
   by explicit owner decision for this route; Google account recovery is the
   operative recovery boundary.
2. Disable Generative AI Features and leave Seer unconfigured.
3. Disable Shared Issues, join requests, open team membership, and member
   invitations.
4. Limit project creation, event deletion, and alert or monitor editing to the
   minimum owner or manager roles.
5. Raise attachment and debug-file access to the minimum practical role.
6. Enable Enhanced Privacy, required Data Scrubber, required default scrubbers,
   and IP address storage prevention.
7. Keep native crash-report and minidump storage at zero.
8. Add targeted global scrub rules for forbidden keys. Do not globally erase
   canonical frame fields needed for grouping and Debug IDs.
9. Execute and retain Sentry's DPA and complete the EVB privacy notice and
   legitimate-interests assessment.
10. Create the two projects with restricted client keys and exact web origins.
11. Create a least-privilege organization token for releases and source maps.
12. Upload and verify private maps, then disable JavaScript source fetching.
13. Document Sentry's platform event retention, currently 90 days unless the
    plan exposes a shorter control. Delete resolved issues during weekly triage.
14. Keep pay-as-you-go disabled and add quota alerts.

Sentry's server-side scrubber is a backstop. It is never permission to send a
raw error and rely on later deletion.

## Acknowledgement design

Use this factual English copy:

> Thank you to Sentry for supporting EVB Viewer through its open-source
> program. [Learn about Sentry for Open Source](https://sentry.io/for/open-source/).

The approval email explicitly asked EVB Viewer to help spread the word and
linked Sentry's branding page. Preserve that private approval record. The copy
does not claim endorsement, partnership, or that the app is powered by Sentry.

Use a repository-owned copy of the official wordmark. Do not hotlink it, load a
Sentry script, add a tracking pixel, recolor it, distort it, crop it, or combine
it with the EVB Viewer logo.

Landing placement uses one shared acknowledgement component in both footer
paths:

- The compact home-page footer.
- `landing/app/components/SiteFooter.vue` for other pages.

App placement uses one app-rendered About and Acknowledgements page containing:

- App name and version.
- License and third-party notices links.
- The localized Sentry acknowledgement and local official asset.
- A privacy-adjacent sentence and link to diagnostics settings.

Suggested privacy-adjacent copy:

> The Sentry acknowledgement is bundled with EVB Viewer and does not contact
> Sentry. Error diagnostics are controlled separately in Privacy settings.

Open the page from Help and from the relevant Settings entry. Electron opens the
external Sentry link through the existing safe shell capability. The hosted
viewer uses a normal secure external link. Do not navigate the document viewer
to a remote origin.

The acknowledgement is translated through the shared typed locale source for
all supported locales. Tests cover both landing footers, the app page, keyboard
focus, contrast, narrow layout, offline behavior, local assets, and zero Sentry
requests before a click. It may ship before telemetry and does not depend on a
DSN or diagnostics preference.

## Privacy notice requirements

Before any event ships, the first-layer and full notices must identify:

- EVB as controller and Sentry as processor.
- Error diagnosis as the only purpose.
- The lawful basis for each runtime and the right to withdraw consent or object.
- Every allowed field and the excluded data categories.
- Sentry's EU data region, subprocessors, transfers, 90-day platform event
  retention unless Sentry exposes a shorter control, and weekly deletion of
  resolved issues.
- The fact that ingress observes a network source IP even though EVB prevents
  Sentry from storing it.
- Access, deletion, restriction, objection, and contact routes.
- That turning reporting off stops future events but cannot recall an event
  already received.
- That Sentry AI features are disabled and EVB does not use diagnostics for
  training.

Do not call the events anonymous. An event timestamp, source IP at ingress, and
support ID can make a record linkable even without a user ID.

The root privacy page and landing privacy page must use one typed translation
source and prove key parity across every supported locale.

## Rollout plan

### Phase 0: acknowledge and harden

- Add the local official branding assets and provenance note.
- Add the shared landing acknowledgement to both footer paths.
- Add the app About and Acknowledgements page.
- Complete account hardening steps 1 through 9.
- Complete privacy copy, DPA, and the Nitro legitimate-interests assessment.

Exit gate: acknowledgement works offline, account defaults are safe, legal
documents are approved, and no telemetry project or event exists.

### Phase 1: build the failure core without Sentry transport

- Add the diagnostic registry, typed occurrence, random event ID, closed record
  builder, frame normalizer, local health counters, and no-op policy adapter.
- Add receipt-aware runtime, fatal, toast, and inline presentation helpers.
- Add typed renderer diagnostic IPC with strict decoder and rate limit.
- Add capture-transport tests with forbidden sentinels.
- Add static warnings for raw red UI, direct console error, direct Sentry import,
  and receipt-free presentation.

Exit gate: synthetic failures create one local occurrence and one safe captured
record. No production SDK or DSN exists.

### Phase 2: make red semantic

- Audit all 76 renderer error calls, 115 Electron `.error(` call sites, 24 red
  presentations, runtime and fatal calls, and server console errors.
- Give high-value startup, save, open, render, worker, update, print, OCR, DjVu,
  scan-cleanup, and assistant owners specific codes.
- Enable logger fallback for unmigrated real errors.
- Reclassify expected refusal, cancellation, unsupported input, handled absence,
  and ordinary offline state to warning or neutral.
- Reuse one receipt where a failure is logged and shown.
- Consolidate `did-fail-load`, initial `loadURL`, renderer-ready rejection, and
  bootstrap failure into one owner and one occurrence ID.
- Remove or downgrade preload-local red console output that is only Vite
  recovery or development control flow. Keep the main `debug:log` red print as
  a projection of the main-owned receipt.
- Keep raw Electron-runner stdout, stderr, page diagnostics, URLs, and `.devkit`
  session logs outside every Sentry adapter.
- Make the static red and direct-console checks blocking.

Exit gate: every remaining red presentation has a receipt, every red console
path has one owner, expected cases create no remote record, and known duplicate
paths produce one occurrence.

### Phase 3: create projects and prove build artifacts

- Finish account hardening and create the selected projects.
- Pin compatible SDK and CLI versions.
- Implement manual transport adapters with all automatic integrations off.
- Add private map generation, injection, staging, upload, receipts, and canaries
  for desktop and viewer bundles. Add landing server artifacts only if a later
  recorded decision creates `evb-viewer-site`.
- Add exact browser CSP ingest origins and package boundary scans.

Exit gate: test projects or capture transports show safe, symbolicated, unique
events. Production DSNs remain disabled.

### Phase 4: Nitro canary

- Enable viewer Nitro after the LIA and notice gates. Exercise landing Nitro
  only if a later recorded decision creates its project.
- Prove one uncaught 500 and each explicit server code arrives once.
- Prove request, URL, transaction, headers, cookies, body, IP, and identity are
  absent.
- Prove the online objection path suppresses associated reports.

Exit gate: one week of preview and production canary data is safe, low-noise,
symbolicated, and actionable.

### Phase 5: desktop and browser consent canary

- Enable a signed desktop preview and hosted-browser preview.
- Prove unknown and denied make zero diagnostic requests.
- Prove grant-time initialization emits exactly one envelope containing exactly
  one event item for the still-live occurrence, then permits future occurrences.
- Prove revocation sends no close-time or queued envelope.
- Prove main, renderer, worker, fatal, UI-only, and direct-console canaries each
  produce one event with the same Error ID shown locally.
- Prove all supported desktop packages contain no web DSN or web ingest host.

Exit gate: consent, privacy, dedupe, source maps, update, relaunch, recovery, and
shutdown canaries pass on every shipping platform.

### Phase 6: production operation

- Enable production client DSNs only in artifacts that passed the receipt and
  canary gates.
- Configure the small alert set and weekly triage.
- Review event usefulness, dropped reasons, burst summaries, grouping,
  symbolication, privacy sentinels, and quota after one and four weeks.
- Remove the legacy logger overload only when no unclassified app-owned calls
  remain.

Exit gate: four weeks of operation meet every success measure below.

## Verification matrix

| Area | Required proof |
| --- | --- |
| Closed builder | Property tests inject forbidden strings and objects at every input depth. No captured envelope contains them. |
| Code registry | Type tests and runtime decoders reject unknown codes, context keys, values, frames, event IDs, and schema versions. |
| Static boundary | Only three runtime adapter roots import a Sentry SDK. Two exact release tools may invoke the pinned CLI for injection and upload, and one exact verification tool may read the separate read-only verification token and query the API. None may import a client SDK, read a DSN, call capture APIs, or construct events. All other product code, scripts, runners, gates, and tools are rejected. |
| Red invariant | Raw red toast or alert creation, direct application `console.error`, and receipt-free runtime or fatal presentation fail the architecture test. |
| Renderer ownership | One guarded Vue error writes one local log, one typed IPC record, one UI report, and one Sentry event. The inherited Vue console call is counted as `owned-projection` and creates no occurrence. |
| Main ownership | One main `ERROR` writes one local log and one Sentry event, then may appear in every renderer without another send. |
| Main IPC receipt | A main-owned IPC failure returns `failureRef`; every renderer presentation reuses it and creates no renderer occurrence. |
| Renderer log direction | Renderer local error reaches main file logging and never echoes into the main debug stream. |
| Preload projection | The isolated-world red print in `installDebugLogListener.ts` creates no main-world renderer occurrence. |
| Fatal paths | Bootstrap and bridge-missing fatal states show an Error ID and create one event when policy allows. |
| UI-only paths | Every confirmed inline, toast, panel, and page error has an owner receipt. Rerendering does not send again. |
| Expected paths | Cancellation, expected teardown, unsupported input, selection limits, stale recent files, and normal offline states send no event. |
| Console fallback | Raw console arguments contain forbidden sentinels but the event contains only code and safe app frames. A wholly frameless call increments `frameless-dropped` and sends nothing. Reentrancy creates no loop. |
| Burst control | Every attempted occurrence is counted; exact loops obey cap, each code and frame pair emits at most one summary per window, and `suppressedCount` clamps at 10,000 without a device ID. |
| Client consent | Unknown and denied make zero SDK import, client, queue, and network activity. Affirmative action is recorded. |
| Revocation | Dropper is installed before queue disposal and SDK disable. `sendClientReports: false` is verified, and no close-time, visibility-change, or client-report envelope is observed. |
| Nitro | Synthetic 500 and explicit endpoint errors arrive once with no request, route, URL, transaction, header, cookie, body, IP, or user data. |
| Source maps | Debug endpoint and canaries show original app file, function, line, release, and dist for every reportable bundle. |
| Build identity | Desktop receipt inputs match injected package bytes. The viewer's private manifest matches local and served prebuilt bytes. |
| Public artifacts | Packages and deployments contain no maps, sources, staging directory, auth token, or wrong-runtime DSN. |
| Account | Evidence proves AI off, the recorded Google-login decision and Sentry limitations, restricted membership and roles, enhanced privacy, scrubbing, IP prevention, source fetching off, retention, and no pay-as-you-go. |
| Shutdown | Local preservation and log flush keep their current deadlines. Sentry is best effort and never delays recovery relaunch or system shutdown beyond its small assigned bound. |
| Acknowledgement | Both landing footers and app page show localized local assets, work offline, and create no Sentry request before a click. |
| Deletion | Removing Sentry packages and transport adapters leaves local logs, error UI, recovery, save, print, update, and product behavior intact. |

## Operational model

Start with four alert classes:

- A new or regressed fatal production issue.
- A new production diagnostic code.
- A production code whose rate exceeds the expected burst threshold.
- Platform-supported quota notifications. This account exposes `80% and 100%`
  or `100%`, and the stricter available `80% and 100%` setting is enabled.
  The historical 50/75/90 points are not available in the current account UI.

Do not page on preview, tests, cancellation, expected teardown, validation,
unsupported input, or ordinary offline behavior.

The maintainer reviews Sentry weekly and after each release:

1. Confirm production environment, release, code, and application frame.
2. Confirm the privacy schema and symbolication canary.
3. Merge issues only when code and stack support one root cause.
4. Reproduce from repository evidence. A Sentry event is a lead, not proof.
5. Create a GitHub issue manually when actionable. Include code, release,
   platform, safe stack, frequency, Error ID, and reproduction status.
6. Link the issue and resolve Sentry only after a shipped fix stays clean.
7. Delete resolved Sentry issues during each weekly triage.
8. Treat any forbidden field as a privacy incident, not a useful lucky detail.

Do not enable automatic GitHub issue creation or automatic resolution in the
first release.

Each runtime writes a local health snapshot containing only mode,
initialization count, attempted, accepted, duplicate, burst-suppressed, policy-
dropped, schema-dropped, frameless-dropped, owned-projection,
transport-failed, and last drop reason. It contains no event values and never
goes to Sentry.

## Rollback and incident response

Hosted browser and Nitro disable through a deployment flag and exact prebuilt
redeploy. Desktop policy in an installed package is not an instant kill switch.
For desktop, disable the Sentry project or client key immediately to reject
ingress, then ship a diagnostics-disabled update. Installed clients may still
attempt requests until they update or revoke consent, and the incident record
must say so.

For a privacy incident:

1. Disable the affected project or deployment.
2. Publish a desktop disabling update if desktop is affected.
3. Preserve a minimal incident record without copying the sensitive payload.
4. Delete or quarantine affected events under the approved procedure.
5. Rotate client and CI keys if exposure is possible.
6. Fix the missing code, decoder, integration, or account control and add a
   sentinel regression.
7. Re-enable only after capture-envelope and live canary proof.

For source-map failure, disable telemetry in the affected artifact or rebuild
after corrected upload. Do not roll back unrelated product fixes only because
Sentry is unavailable.

For noise or quota risk, disable the offending code or runtime adapter, keep
other actual errors at full first-occurrence coverage, and repair classification
or burst policy before restoring it.

## Success measures

The first production release succeeds when:

- Every red UI and red console occurrence enters the local failure gate.
- Every reportable occurrence has one Error ID and one owner.
- One logical failure creates at most one Sentry event, with bounded repeat
  accounting.
- Every accepted event has a known code and schema.
- No accepted event contains a forbidden sentinel.
- Every event with application frames is symbolicated.
- Expected outcomes create no red UI, red console, or Sentry event.
- A maintainer can turn an event into a reproducible issue without asking the
  user for a vague screenshot or document content.
- A user screenshot that still arrives contains an exact Error ID.
- Sentry outage, denial, revocation, or removal does not change product behavior.
- Sentry AI remains disabled and diagnostics are never used for training.

## Implementation proofs that do not change the architecture

The implementation spike must settle these package-specific details with tests:

1. Which exact Sentry browser, Node, core, and CLI versions coexist
   with the installed Nuxt and Electron dependency graph.
2. Confirm that the pinned Node client with `defaultIntegrations: false`,
   `skipOpenTelemetrySetup: true`, `sendClientReports: false`, and the custom
   non-persisting transport registers no process handlers or global patches. If
   it does, use `@sentry/core`'s server runtime client with `createTransport`.
3. Which supported stack parser can produce canonical frames without exposing
   raw values or relying on unstable internal exports.
4. How browser Debug ID metadata is read when the renderer has no Sentry SDK.
5. Prove that the one-shot first-error consent path initializes after grant and
   emits exactly one envelope with one event item, without a pre-consent queue,
   client report, or revocation flush.
6. Which Nitro hook registers exactly once in normal, packaged, and Vercel
   prebuilt output.
7. Confirm Sentry's platform event retention, currently 90 days unless the plan
   exposes a shorter control, document it in the notice, and prove weekly
   deletion of resolved issues.
8. Prove that the synchronous startup preference reader and single marker write
   survive missing, corrupt, partial, and newer settings, complete without
   changing exit code or fail-fast timing, and delete the marker after the next
   launch regardless of send policy or outcome.
9. How the consolidated window-load owner carries one occurrence ID through
   `did-fail-load`, `loadURL` rejection, renderer readiness, and bootstrap
   failure without hiding a distinct second fault.

Until those proofs, account, legal, privacy, source-map, and captured-envelope
gates pass, production DSNs remain disabled.

## Adversarial audit

A prior read-only architecture audit reviewed this completed ledger, the legal
companion, the superseded design, and the relevant repository paths on
2026-09-01. The verdict was `APPROVE WITH REQUIRED CHANGES`.

All binding rulings are incorporated above:

1. Electron and hosted-browser clients require opt-in in the first release.
   Default-on client design is closed until named per-jurisdiction legal review.
2. A console error with no EVB-shipped application frame is counted locally and
   dropped remotely.
3. Exact loops may aggregate after every occurrence enters the local gate. The
   summary preserves code and frame identity and clamps its count.
4. Hosted browser events go directly to the exact Sentry EU ingest origin.
5. The first release uses two projects. Landing stays local-only because its
   release-catalog 503 is expected upstream unavailability.
6. Affirmative grant may send the still-live closed first-error record as one
   envelope with one event item.
7. Electron main uses a Node-family client with no default integrations,
   OpenTelemetry setup, client reports, or persistent transport.
8. Early fatal startup does no in-process network send. A granted preference
   permits one closed marker for one next-launch send and unconditional deletion.
9. Development and automation logs stay local. Static boundaries include all
   scripts and runners.
10. Main IPC responses carry failure references, child reporters remain local,
    and inherited console projections use a synchronous suppression scope.
11. Every Sentry-owning runtime disables SDK client-report envelopes.
12. The notice and operating procedure use Sentry's actual 90-day platform
    retention unless a shorter control becomes available, with weekly deletion
    of resolved issues.
