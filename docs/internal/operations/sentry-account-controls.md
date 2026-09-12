# Sentry account controls

For an ambiguous `check Sentry` or `verify Sentry` request, start with
[sentry-agent-check.md](./sentry-agent-check.md). This file records account
state and policy; it is not a substitute for the read-only check procedure.

This file records the configuration EVB Viewer requires before diagnostics can
send production events. It contains setting names and policy decisions only.
Never add DSNs, tokens, project identifiers, private endpoints, screenshots, or
event contents.

The server-side scrubber is a backstop. Runtime adapters must still construct
every remote event from the closed diagnostic record and must never send a raw
error, message, path, URL, request, document value, or arbitrary object.

## Organization access

| Control | Required value | Verification |
| --- | --- | --- |
| Data storage region | European Union | Owner verified 2026-09-03 |
| Generative AI features | Disabled | Owner verified 2026-09-04 |
| Seer | Unconfigured | Owner verified 2026-09-03 |
| Shared issues | Disabled | Owner verified 2026-09-04 |
| Join requests | Disabled | Owner verified 2026-09-04 |
| Open team membership | Disabled | Owner verified 2026-09-04 |
| Member invitations | Disabled | Owner verified 2026-09-04 |
| Member project creation | Disabled | Owner verified 2026-09-04 |
| Member event deletion | Disabled | Owner verified 2026-09-04 |
| Member monitor and alert editing | Disabled | Owner verified 2026-09-04 |
| Attachment access | Owner | Owner verified 2026-09-04 |
| Debug-file access | Owner | Owner verified 2026-09-04 |
| Pay-as-you-go spending limit | Zero | Owner verified 2026-09-03 |
| Payment method | None required | Owner verified 2026-09-03 |

## Authentication and recovery

Google organization SSO and a connected Google login are separate Sentry
controls. The personal Google account works as the routine connected login, but
Sentry's Security page still exposes a password-change path and offers no
remove-password control. The organization SSO setup does not accept the
personal Gmail account. EVB therefore uses Google for routine login and treats
the Google account's recovery controls as the operative recovery boundary.
This is a recorded Sentry limitation, not a claim that the Sentry account is
passwordless.

| Control | Required value | Verification |
| --- | --- | --- |
| Sole owner access | Retained throughout migration | Owner verified 2026-09-04 |
| Connected Google login | Owner account only; routine sign-in path | Owner verified 2026-09-04 |
| Sentry password removal | Remove if the platform exposes a supported control | No removal control available, owner verified 2026-09-04 |
| Organization Google SSO | Configure only if the provider accepts the owner identity | Personal Gmail not accepted, owner verified 2026-09-04 |
| Sentry-native and organization 2FA | Disabled by explicit owner decision for the Google-login route | Owner verified 2026-09-04 |

## Privacy and scrubbing

| Control | Required value | Verification |
| --- | --- | --- |
| Enhanced Privacy | Enabled | Owner verified 2026-09-04 |
| Required Data Scrubber | Enabled | Owner verified 2026-09-04 |
| Required default scrubbers | Enabled | Owner verified 2026-09-04 |
| IP address storage | Prevented | Owner verified 2026-09-04 |
| JavaScript source fetching | Disabled in both projects | Owner verified 2026-09-04 |
| Minidump attachment storage | Disabled | Owner verified 2026-09-03 |
| Aggregated identifying service data use | Disabled | Owner verified 2026-09-03 |
| Global safe fields | Empty | Owner verified 2026-09-04 |
| Derived user geography | Removed with `[Remove] [Anything] from [$user.geo.**]` in both projects | Owner verified by post-change test events 2026-09-04 |

The verified global sensitive-field list is:

```text
message,error,stack,rawError,raw_error,rawMessage,raw_message,rawStack,raw_stack,
consoleArguments,console_arguments,uiCopy,ui_copy,filePath,file_path,documentName,
document_name,documentContent,document_content,documentText,document_text,aiText,
ai_text,request,user,identity,url,query,headers,cookies,body,referrer,prompt,
completion,breadcrumbs,attachments,minidump
```

It deliberately does not match these canonical diagnostic and symbolication
fields: `filename`, `module`, `function`, `lineno`, `colno`, `stacktrace`,
`frames`, `exception`, `value`, `release`, `dist`, `environment`, `fingerprint`,
`tags`, `contexts`, and `extra`.

## Projects and credentials

Create credentials only after the named runtime consumer exists. Record secret
names and their runtime purpose here, never their values.

| Item | Required state | Verification |
| --- | --- | --- |
| `evb-viewer-desktop` project | One key named `desktop-runtime` | Owner verified 2026-09-04 |
| `evb-viewer-web` project | Keys named `web-browser` and `web-nitro` | Owner verified 2026-09-04 |
| Browser allowed origins | Canonical production viewer and two viewer Vercel aliases | Owner verified 2026-09-04 |
| Source-map upload token | One token with `org:ci` only | Owner verified by successful strict upload 2026-09-04 |
| Source-map verification token | Separate read-only token with `project:read` and event-read access; never used for upload | Owner verified 2026-09-05; GitHub secret and local Keychain entry present, and the EU project API returned HTTP 200 |
| Desktop runtime secret | `SENTRY_DESKTOP_DSN` in GitHub Actions | Owner verified 2026-09-04 |
| Browser runtime secret | `SENTRY_BROWSER_DSN` in Vercel Preview and Production | Owner verified by exact production deployment 2026-09-05 |
| Browser canary secret | `SENTRY_BROWSER_DSN` in GitHub Actions | Owner verified 2026-09-04 |
| Nitro runtime secret | `SENTRY_NITRO_DSN` in Vercel Preview; runtime remains disabled | Owner verified 2026-09-04 |
| Release upload settings | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_DESKTOP_PROJECT`, and `SENTRY_WEB_PROJECT` in GitHub Actions | Owner verified 2026-09-04 |
| Release verification setting | `SENTRY_VERIFICATION_TOKEN` in GitHub Actions and the local private Sentry environment | Owner verified 2026-09-05; the local CLI loads the token from the `evb-viewer-sentry-verification-token` Keychain service |

## Retention and operations

| Control | Required value | Verification |
| --- | --- | --- |
| Platform event retention | Business-plan platform period is 90 days | Documented platform value; no shorter account control found 2026-09-04 |
| Resolved-issue deletion | Weekly operator procedure | First cycle found zero resolved issues to delete, verified 2026-09-05 |
| Quota alerts | Personal error-quota notifications at 80 and 100 percent; pay-as-you-go disabled | Owner verified 2026-09-05; the account UI offers only `100% and 80%` or `100%` |
| Source-map access review | Debug-file access Owner; source fetching disabled after upload | Owner verified 2026-09-04 |
| Removal procedure | Tested without sending a production event | Full macOS arm64 source-and-package removal rehearsal verified 2026-09-05; the runbook records the separate pre-existing renderer-settle test failure reproduced on the untouched baseline |

Sentry derived a user geography from ingress metadata on the first closed test
events even though IP storage was prevented and no user or request field was
sent. Both projects therefore use the explicit `$user.geo.**` removal rule.
Post-change desktop and browser test events contained no geography. This rule
is required and must survive account-control reviews.

The alert definitions, weekly deletion procedure, privacy incident response,
credential rotation, emergency disablement, canary evidence tables, and package
removal rehearsal are in `sentry-runbook.md`.

## Production activation record

Release `v0.1.453` is the current production viewer release with consent-gated
client diagnostics. The exact prebuilt output is deployed at the canonical
viewer alias. Its public JavaScript matches the private manifest and contains
no source maps. The exact production receipt contains 259 deterministic
source-map canaries, all verified through the source-map-debug and
processed-event checks. The earlier v0.1.452 `missing_source_content` result is
historical and does not describe the current release. Nitro runtime reporting
remains disabled pending its legal approval and observation gates. The review
and objection work stays open in [#222](https://github.com/evb0110/evb-viewer/issues/222),
enablement and canary work stays open in
[#261](https://github.com/evb0110/evb-viewer/issues/261), and dated observation
stays open in [#267](https://github.com/evb0110/evb-viewer/issues/267).

The live browser check on 2026-09-05 recorded no Sentry request before consent,
one event after the user granted the still-live report, no later event after
revocation, and no event after first-time denial. The viewer CSP contains one
EU Sentry ingest origin. The landing CSP contains none. Production deployment
`dpl_6mz6ywiVqcCUvraULktftokjSe9W` serves the bundled acknowledgement and
wordmark at `evb-viewer.com`; a fresh browser session made no Sentry request and
reported zero console errors or warnings.
