# EVB Viewer Landing

Nuxt marketing and download site for EVB Viewer web and desktop entry points.

## What it does

- Presents EVB Viewer as both a browser app and a desktop app
- Fetches latest desktop release assets from GitHub at `/api/releases/latest`
- Detects user platform and architecture from browser user agent
- Suggests the most likely desktop installer automatically
- Lets users pick any other desktop build manually
- Includes feature overview and end-user documentation
- Plays a film recorded from the real desktop app beside the downloads

## Configuration

The landing runtime reads these environment variables at runtime:

- `NUXT_GITHUB_OWNER` (default: `evb0110`)
- `NUXT_GITHUB_REPO` (default: `evb-viewer`)
- `NUXT_GITHUB_API_BASE` (default: `https://api.github.com`)
- `NUXT_GITHUB_TOKEN` (optional; recommended to raise GitHub API limits)

Page views and installer downloads go to Vercel Web Analytics. Setup and use:
[Vercel deploy, Analytics](../docs/contributing/vercel-deploy.md#analytics).

## Film

The home page film is recorded from the real app, not drawn by hand, the same way as the EVB Player landing. `recorder/` drives a packaged EVB Viewer build with Playwright, captures each state as SVG with dom-to-svg, and writes each locale/theme variant to `public/films/viewer/<locale>-<theme>/` with a manifest at `app/films/manifests/viewer.<locale>.<theme>.json`. Page images and fonts are shared by all variants in `public/films/viewer/images/` and `public/films/viewer/fonts/`. `app/films/makeRealFilm.tsx` plays the selected recording with Remotion, adding the pointer, clicks and camera moves. The page loads only the manifest for the visitor's language and color mode; a missing recording falls back to English in the same theme, then English dark.

The flow in `recorder/flows/viewer.mjs` opens `recorder/documents/noldeke-1880-raw-scan.pdf` (four pages of Theodor Nöldeke, *Kurzgefasste syrische Grammatik*, Leipzig 1880, which is in the public domain), cleans it up, runs OCR on every page in German and searches the new text layer. It reads every label from the app's own messages, so one flow records all nine interface languages.

To record again after the interface changes, extract a Linux release build and run the recorder on a private X server, from this directory:

```bash
gh release download -R evb0110/evb-viewer -p 'EVB-Viewer-*-amd64.deb' -D ../.devkit/films
dpkg-deb -x ../.devkit/films/EVB-Viewer-*-amd64.deb ../.devkit/films/app
xvfb-run -a -s '-screen 0 1600x1000x24' node recorder/record.mjs viewer --app "../.devkit/films/app/opt/EVB Viewer/evb-viewer"
# One locale, one theme, or both:
xvfb-run -a -s '-screen 0 1600x1000x24' node recorder/record.mjs viewer --app "…" --locale ru --theme dark
```

Each run uses a fresh profile with the chosen theme and locale in `settings.json` and the German OCR model from `resources/tesseract/tessdata`. The recorder stops with an error unless the window is exactly 1280×800, since a smaller window leaves blank strips in the film. QA screenshots of every state go to `../.devkit/films/qa/`.

## Local development

From the repository root:

```bash
pnpm install
pnpm --dir landing run dev
```

## Vercel deployment

The landing app is part of the root pnpm workspace. Configure its Vercel
project with `landing` as the Root Directory while keeping the repository root
as the source context, so `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and the
shared packages under `packages/` are available during installation and build.

```bash
pnpm install --frozen-lockfile
pnpm --dir landing run build
pnpm run deploy:landing:prod
```

Optional environment variables on Vercel:

```bash
vercel env add NUXT_GITHUB_OWNER
vercel env add NUXT_GITHUB_REPO
vercel env add NUXT_GITHUB_TOKEN
```

## License

[MIT](./LICENSE) Copyright © 2026 Eugene Barsky
