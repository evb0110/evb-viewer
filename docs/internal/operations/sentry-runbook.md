# Sentry operations runbook

Agents handling a bare `check Sentry` or `verify Sentry` request start with
[sentry-agent-check.md](./sentry-agent-check.md). Account settings live in
[sentry-account-controls.md](./sentry-account-controls.md).

Do not record credential values, event payloads, private Sentry URLs, user
content, document names, local paths, or screenshots in this file, a GitHub
issue, or a report.

## How reporting works

- Desktop uses `@sentry/electron`. Electron main loads the SDK only after the
  user grants diagnostics consent (`clientDiagnosticsPreference: 'granted'`)
  and a DSN was compiled in from `SENTRY_DESKTOP_DSN`. Revoking consent sets the
  client's `enabled` option to false; nothing is sent afterwards. Renderers load
  `@sentry/electron/renderer` on the same condition and send through main over
  the SDK's IPC bridge (`import '@sentry/electron/preload'` in the preload).
- The hosted browser build loads `@sentry/browser` on the same consent, with
  `SENTRY_BROWSER_DSN` from the Vercel build environment. The web service sends
  no server-side reports.
- Every client uses the one scrubber in
  `packages/contracts/diagnostics/scrubSentryEvent.ts` as `beforeSend`. It keeps
  an allowlist of event fields, reduces frames to app-relative paths, removes
  local paths, file names, URLs and quoted text from messages, and drops
  breadcrumbs, request, user and extra data and every attachment (so native
  crash minidumps never leave the machine; the crash event itself is sent).
- Call sites report through `BrowserLogger.error(..., {code})` in the renderer
  and `logger.error(msg, {code, cause})` in main. The code is sent as the
  `diagnostic_code` tag and added to the fingerprint. The event ID is the
  Error ID the UI shows.
- A JavaScript exception thrown in main before the app installs its fatal
  handlers is written to `startup-crash-marker.json` in the user data folder
  and sent on the next launch, with consent.

## Source maps

Release builds with `SENTRY_AUTH_TOKEN` emit hidden source maps. The
`Upload Sentry source maps` workflow step runs
`node scripts/release/upload-sentry-sourcemaps.mjs dist-electron nuxt-output/public`
before packaging: `sentry-cli sourcemaps inject` adds Debug IDs to the bundles,
`sentry-cli sourcemaps upload` uploads the maps, and the script deletes the
maps. A web deploy through `pnpm run deploy:web:prod` with `SENTRY_AUTH_TOKEN`
and `SENTRY_BROWSER_DSN` set builds locally and runs the same script on
`.vercel/output/static`.

## Alerts

These alert classes exist in both projects and are owned by the repository
owner. The repository does not declare alert rules; change them only under an
explicit instruction.

| Alert class | Filter | Trigger |
| --- | --- | --- |
| New or regressed fatal | `environment:production`, level `fatal` | First new or regressed issue |
| New diagnostic code | `environment:production`, `diagnostic_code` present | New issue or regression |
| Code rate | `environment:production`, `diagnostic_code` present | More than 20 events in one issue within five minutes |
| Quota | Organization usage | Error-quota notifications at 80 and 100 percent; pay-as-you-go disabled |

The issue alerts still exclude events tagged `evb_canary` or `evb_probe` from
the retired canary tooling. Current events never carry those tags.

## Triage

1. List unresolved production issues read-only (see the agent check).
2. Confirm the top in-app frame is an EVB source file, function and line.
3. If any field outside the scrubber's allowlist appears, stop and follow the
   privacy incident procedure.
4. Reproduce from repository code, tests, or a synthetic fixture before filing
   a GitHub issue. Include the diagnostic code, release, platform, a safe frame
   summary, frequency and Error ID, never event content.
5. Resolve a Sentry issue only after its fix ships, and only under an explicit
   instruction.

## Privacy incident response

A local path, file name, URL, document text, user-authored text, request or
identity field, attachment, or any field the scrubber does not allowlist is a
privacy incident.

1. Disable reporting as below. Inspect no more events than needed.
2. Keep only the event ID, diagnostic code, release and dates for the record.
3. Delete the affected events and issues in Sentry.
4. Rotate the affected DSN key, and the upload token if it may be exposed.
5. Fix the scrubber and add the leaked shape to its unit test.

## Disable reporting

1. Remove `SENTRY_DESKTOP_DSN` from the release build secrets and
   `SENTRY_BROWSER_DSN` from the Vercel environments.
2. Rebuild desktop artifacts and redeploy the viewer. Disabling or rotating the
   Sentry client key also stops already shipped clients.
3. A missing DSN is the safe state: the SDK is never loaded and Error IDs,
   local logs and the failure UI keep working.

## Credential rotation

Create the replacement key or token in Sentry, store it in the same GitHub or
Vercel scope, build or deploy a preview, then revoke the old credential. Never
pass a token on a command line or print it in a log.
