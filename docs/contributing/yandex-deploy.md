# Yandex web mirror

The browser application is mirrored at
<https://web-evb-viewer.website.yandexcloud.net/>. Yandex supplies HTTPS for
this hostname; no custom domain or separately provisioned certificate is needed.

## Redeploy

From a clean checkout of a commit whose `CI` workflow has passed:

```sh
pnpm run deploy:web:yandex:prod
```

Run this on macOS or Linux with Node 24, pnpm, Python 3, and an authenticated
GitHub CLI (`gh`). Wrap the command in `agent-env run --mem 4G --` when running
as an agent, as for other builds. The deployment builds in an isolated directory
under `.devkit/` and removes that directory on completion or failure.

The command reads `YANDEX_S3_ACCESS_KEY_ID` and `YANDEX_S3_SECRET_KEY` from the
environment or the ignored `.env.yandex.local` file. The existing MSS names
`MIRROR_S3_ACCESS_KEY_ID` and `MIRROR_S3_SECRET_KEY` also work. On a workstation
with the sibling MSS checkout, reuse its configuration without copying keys:

```sh
ln -s ../mss-backend/backend/.env .env.yandex.local
```

Create that link only if the local file does not already exist. Credentials
are used by the upload process and are never passed to the frontend build.
The build receives only explicitly allowed process, locale, proxy and TLS
certificate variables; shell tokens such as `GH_TOKEN` and `NPM_TOKEN` stay out.
Do not commit the configuration or put keys in command-line arguments.

To publish a separate mirror, use `--bucket=another-bucket-name`. Names must
contain lowercase letters, digits and hyphens, with no dots, for Yandex's
default HTTPS certificate. The credentials need bucket creation/website
configuration permissions for a new bucket, and object read/write/ACL permissions
for redeployment. An existing bucket must already identify itself as a Viewer
mirror through `mirror-manifest.json`; the command refuses unrelated buckets.

## What it publishes

- Only committed source from `HEAD`, using the existing web deployment exclusion
  policy. Local files, credentials, desktop resources and native sources stay out.
- Browser WASM downloaded from the successful CI run for that exact commit.
- The normal Nuxt/Vercel build's static output, after its existing asset and
  server boot checks pass. The mirror itself runs without a Node server.
- All pinned OCR models, checked against the registry's sizes and SHA-256 hashes.
  The staged browser build downloads them from the mirror's own origin.

Application assets upload before the home page. Existing hashed assets remain
available for open sessions. All public WASM and Nuxt JavaScript bytes are verified
before the home page changes, and the published home page is checked afterward.
If that final check fails, an existing previous home page is restored. This is
not a transactional rollback of every asset: unversioned assets may already have
changed. The per-bucket deployment lock serializes publishers on this workstation.

`mirror-manifest.json` records the revision, version, CI run and publication time.
Redeployment is manual; publishing to Vercel does not update Yandex automatically.

## Static hosting limits

The mirror disables Vercel analytics and marks its HTML `noindex`. It preserves
the build's Content Security Policy and referrer policy through HTML metadata.
Object Storage cannot reproduce arbitrary HTTP response headers, including
`frame-ancestors`, `X-Frame-Options` and cross-origin opener/resource policies.
If the browser app gains request-time server routes or requires those headers
for functionality, revisit static hosting before deploying that change.

After deployment, open a PDF, check rendered text and navigation, and save a
copy in a browser. Reachability from Russia requires a separate check from a
Russian connection; a successful deployment from another country does not prove it.
