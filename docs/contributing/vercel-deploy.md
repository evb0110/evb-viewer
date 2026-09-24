# Vercel Deployment

## Project

- Vercel project name: `evb-viewer-web`
- Runtime target: prerendered Nuxt web app with client-side runtime personalization

## Repo Configuration

- Configure build and framework settings in the Vercel dashboard or API:
- Framework preset: `Nuxt.js`
- Build command: leave unset so Vercel uses the repo default `pnpm build`
- Output directory: leave unset
- Install command: leave unset unless Vercel auto-detection regresses; the default `pnpm install` is compatible with `pnpm-lock.yaml` and `pnpm-workspace.yaml`
- Development command: optional `pnpm dev:web`

## Notes

- This deploy path is for the browser app, not the Electron shell.
- The generated app serves the web workspace at `/`.
- Electron-only routes such as `/electron` are not part of the intended Vercel product surface.
- Keep `/` prerendered for production Vercel builds. Browser settings, recent files, and install-hint visibility are seeded from client-readable cookies/local runtime storage after the static shell loads; do not reintroduce request-time SSR for that personalization path.
- `nuxt.config.ts` writes Nitro output to `.vercel/output` for Vercel-hosted builds and local `vercel build`, which lets Vercel consume the Build Output API artifact while Electron and release flows keep using `nuxt-output/`.
- Browser Rust/WASM builds are not committed. `pnpm deploy:web` uploads the local `public/wasm/` files (run `pnpm build` or `node scripts/ensure-wasm-artifacts.mjs` first), and `pnpm build` verifies they are present in `.vercel/output/static/wasm/` during Vercel builds.
- Desktop release artifacts are intentionally written to `release/`, not `dist/`, so they cannot be mistaken for web output during Vercel deploys.
- Local Vercel link metadata lives in `.vercel/` and is gitignored.
- Vercel needs the root workspace package and the shared packages under `packages/`. The landing app is in the same workspace but remains excluded from this browser-app deploy source.
- `pnpm run check:static:assets` verifies the local deploy source stays below Vercel upload limits and that Electron, native, fixture, coverage, and other local-only paths remain excluded.

## Suggested Dashboard Settings

- Project name: `evb-viewer-web`
- Root directory: repository root
- Package manager: `pnpm`
- Production branch: `main`

## Local Verification

- `pnpm build`
- `vercel build`
- `pnpm run deploy:web:prod`

## Analytics

Both Vercel projects (browser viewer and landing) use Vercel Web Analytics. The data lives in Vercel; this repository stores none. The desktop app sends no analytics.

### Turning it on

1. In the Vercel dashboard, open each project, then Analytics, and select Enable. Vercel then serves the collector at `/_vercel/insights/*` on that project's domains. Ignore the dashboard's "Get Started" install steps: the package is already installed (a client plugin in the browser app, the Nuxt module on the landing site), and the page stays on those steps until the first visit is recorded.
2. Browser viewer only: add `NUXT_PUBLIC_ANALYTICS_ENABLED=1` to the project's Production environment variables, then redeploy with `pnpm run deploy:web:prod`. The flag is read at build time, so an existing deployment does not pick it up. Leave it unset for Preview so preview traffic is not counted.
3. The landing site needs no flag; its analytics module is always installed and starts reporting once step 1 is done.
4. Check it: open the production site in a normal browser window (ad blockers hide the request), and confirm a request to `/_vercel/insights/view` in the network panel. The visit appears in the dashboard within a minute or so.

### What is collected

- Page views, with query strings and fragments stripped before sending. The browser app never loads the script inside Electron.
- Browser app custom events: `document_opened` (document kind and open method) and `browser_install_hint_interacted`.
- Landing custom event: `download` for GitHub and mirror installer links.
- Custom events need a Vercel Pro or Enterprise plan. The projects are on Hobby, so the dashboard shows page views only; the events are still sent and cost nothing.

### Reading it

Open the project in Vercel, then Analytics. Filter by path, country, device or referrer; custom events are under Events. For questions such as "how many downloads per platform last week", open the `download` event and break it down by its properties.

### Adding an event

Call `trackWebEvent(name, properties)` from `app/utils/trackWebEvent.ts` in the browser app, or `track` from `@vercel/analytics` on the landing site. Properties must not contain file names, paths, document text or other personal data. List the new event in this section and in the privacy text (`packages/i18n-core/privacyMessages.ts` and the landing privacy page).

## Private Email CLI Deploys

- Keep Git commits authored with the GitHub no-reply address to avoid leaking a personal email in public repositories.
- Never invoke `vercel`, `vercel deploy`, or `vercel --prod` directly from this checkout. Use `pnpm run deploy:web:prod` for the browser viewer, `pnpm run deploy:landing:prod` for the landing app, or their non-`:prod` counterparts for previews.
- The repository-owned deploy command copies the source tree into a temporary directory without `.git`, preserves `.vercel/project.json`, and runs a normal remote `vercel deploy` from that clean source tree.
- It passes `--archive=tgz` by default so Vercel receives a tarball upload instead of counting each source file against the direct upload item limit.
- Its temporary source copy omits local-only directories and environment files before upload, preserves `packages/`, removes the excluded landing app from the copied workspace manifest, and removes `.vercelignore` entries that point at omitted paths. This keeps the pruned workspace installable and avoids Vercel archive-mode `ENOENT` failures.
- This avoids sending the commit author email in Vercel CLI Git metadata, which prevents Vercel from treating the GitHub no-reply address as a separate team collaborator.
- Because Vercel still performs the build remotely, Production/Preview environment variables and normal alias behavior match dashboard or Git-backed deploys.
- If an upload fails due to a transient network error, rerun the same package command.

The landing target keeps the root workspace manifests and shared `packages/`,
includes `landing/`, and substitutes `landing/.vercel/project.json` into the
sanitized source root. The Vercel project must keep `landing` configured as its
Root Directory.
