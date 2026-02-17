# EVB Viewer Landing

Nuxt landing site for EVB Viewer desktop releases.

## What it does

- Fetches latest release assets from GitHub at `/api/releases/latest`
- Detects user platform and architecture from browser user agent
- Suggests the best installer automatically
- Lets users pick any other installer manually
- Includes feature overview and documentation/source links

## Configuration

The release API reads these environment variables at runtime:

- `NUXT_GITHUB_OWNER` (default: `evb0110`)
- `NUXT_GITHUB_REPO` (default: `electron-nuxt`)
- `NUXT_GITHUB_API_BASE` (default: `https://api.github.com`)
- `NUXT_GITHUB_TOKEN` (optional; recommended to raise GitHub API limits)

## Local development

```bash
pnpm install
pnpm dev
```

## Deploy with Vercel CLI

From `landing/`:

```bash
pnpm install
pnpm build
vercel deploy
vercel deploy --prod
```

Optional environment variables on Vercel:

```bash
vercel env add NUXT_GITHUB_OWNER
vercel env add NUXT_GITHUB_REPO
vercel env add NUXT_GITHUB_TOKEN
```

## License

[MIT](./LICENSE) Copyright © 2026 Eugene Barsky
