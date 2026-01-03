# Electron + Nuxt SSR Stub

Barebones example of running Nuxt with SSR inside Electron.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ELECTRON MAIN PROCESS                    │
│                                                             │
│   In dev:  Just loads http://localhost:3000                 │
│   In prod: Spawns Nuxt server, then loads from it          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    NUXT SSR SERVER                          │
│                                                             │
│   1. Receives request                                       │
│   2. Fetches data (server/api/heavy-data.ts)               │
│   3. Renders Vue components to HTML                         │
│   4. Returns fully rendered HTML                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    BROWSER WINDOW                           │
│                                                             │
│   Receives complete HTML with data already rendered         │
│   User sees content immediately (no loading spinner)        │
│   Then Vue hydrates for interactivity                       │
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

- `nuxt.config.ts` - SSR is enabled with `ssr: true`
- `electron/main.ts` - Electron main process
- `pages/index.vue` - Demo page with SSR data fetching
- `server/api/heavy-data.ts` - API route (runs during SSR)

## SSR Demo

The `/api/heavy-data` endpoint has a 500ms delay. With SSR:
- User sees data immediately (no loading state)
- The delay happens server-side before HTML is sent

Without SSR (SPA mode), user would see:
1. Blank page
2. Loading spinner
3. Data appears after 500ms
