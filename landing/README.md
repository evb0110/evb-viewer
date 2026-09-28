# EVB Viewer Landing

Nuxt marketing and download site for EVB Viewer web and desktop entry points.

## What it does

- Presents EVB Viewer as both a browser app and a desktop app
- Fetches latest desktop release assets from GitHub at `/api/releases/latest`
- Detects user platform and architecture from browser user agent
- Suggests the most likely desktop installer automatically
- Lets users pick any other desktop build manually
- Includes feature overview and end-user documentation
- Plays a video of the real desktop app, rendered with Remotion, beside the downloads

## Configuration

The landing runtime reads these environment variables at runtime:

- `NUXT_GITHUB_OWNER` (default: `evb0110`)
- `NUXT_GITHUB_REPO` (default: `evb-viewer`)
- `NUXT_GITHUB_API_BASE` (default: `https://api.github.com`)
- `NUXT_GITHUB_TOKEN` (optional; recommended to raise GitHub API limits)

Page views and installer downloads go to Vercel Web Analytics. Setup and use:
[Vercel deploy, Analytics](../docs/contributing/vercel-deploy.md#analytics).

## Film

The home page film is recorded from the real app, not drawn by hand, and turned into a video with Remotion.

1. `recorder/record.mjs` drives a packaged EVB Viewer build with Playwright and captures each state of the flow as SVG with dom-to-svg. Each locale/theme variant goes to `../.devkit/films/capture/films/viewer/<locale>-<theme>/`, with a manifest in `../.devkit/films/capture/manifests/`; page images and fonts are shared by all variants. The captures are render inputs and are not committed.
2. `recorder/render.mjs` renders `recorder/film/makeRealFilm.tsx`, a Remotion composition that sequences the states and adds the pointer, clicks and camera moves, to `public/films/viewer/<locale>-<theme>.mp4` at 1920×1200, with a poster (`-poster.jpg`) and a still for visitors who prefer reduced motion (`-still.jpg`). It lists the variants in `app/films/viewer.json`.

The page plays the video for the visitor's language and color mode and falls back to English in the same theme, then any English one. Playing a video instead of swapping large SVG snapshots in the page keeps the browser from repainting the whole film at every state change, which flickered in desktop Chrome.

The flow in `recorder/flows/viewer.mjs` opens `recorder/documents/noldeke-1880-raw-scan.pdf` (four pages of Theodor Nöldeke, *Kurzgefasste syrische Grammatik*, Leipzig 1880, which is in the public domain), cleans it up, runs OCR on every page in German and searches the new text layer. It reads every label from the app's own messages, so one flow records all nine interface languages.

To record and render again after the interface changes, extract a Linux release build and run, from this directory:

```bash
gh release download -R evb0110/evb-viewer -p 'EVB-Viewer-*-amd64.deb' -D ../.devkit/films
dpkg-deb -x ../.devkit/films/EVB-Viewer-*-amd64.deb ../.devkit/films/app
xvfb-run -a -s '-screen 0 1600x1000x24' node recorder/record.mjs viewer --app "../.devkit/films/app/opt/EVB Viewer/evb-viewer"
node recorder/render.mjs viewer
# Either script takes --locale <code> and --theme <light|dark> to redo part of the set.
```

Each recording uses a fresh profile with the chosen theme and locale in `settings.json` and the German OCR model from `resources/tesseract/tessdata`. The recorder stops with an error unless the window is exactly 1280×800, since a smaller window leaves blank strips in the film. QA screenshots of every state go to `../.devkit/films/qa/`. The first render downloads Remotion's headless Chrome; rendering takes a few minutes per variant.

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
