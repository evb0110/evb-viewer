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
npm install

# Development (runs Nuxt dev server + Electron)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## Key Files

- `nuxt.config.ts` - SPA mode (`ssr: false`) and dev port `3235`
- `electron/main.ts` - Electron main process
- `app/pages/index.vue` - Main viewer UI
