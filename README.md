# Electron + Nuxt PDF Viewer

PDF viewer built with Nuxt (SPA) running inside Electron.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ELECTRON MAIN PROCESS                    │
│                                                             │
│   In dev:  Loads http://localhost:3235                      │
│   In prod: Spawns Nuxt server, then loads from it           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    NUXT SPA SERVER                          │
│                                                             │
│   Serves the Nuxt app (ssr: false)                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    BROWSER WINDOW                           │
│                                                             │
│   Loads the Nuxt SPA and runs the UI                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Usage

```bash
# Install dependencies
pnpm install

# Development (runs Nuxt dev server + Electron)
pnpm dev

# Build for production
pnpm build

# Run production build
pnpm start
```

## Key Files

- `nuxt.config.ts` - SPA mode (`ssr: false`) and dev port `3235`
- `electron/main.ts` - Electron main process
- `app/pages/index.vue` - Main viewer UI

## OCR Performance (optional)

The OCR pipeline runs native Tesseract processes. You can tune parallelism via env vars:

- `OCR_CONCURRENCY` - Max pages processed in parallel (default: `min(cpuCount, 8)`)
- `OCR_TESSERACT_THREADS` - Thread limit passed to Tesseract via `OMP_*` env vars (default: `floor(cpuCount / OCR_CONCURRENCY)`)
