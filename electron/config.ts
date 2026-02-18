import { app } from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parsePositiveInt(raw: string | undefined, fallback: number) {
    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return parsed;
}

export const config = {
    isDev: !app.isPackaged,
    isMac: process.platform === 'darwin',

    server: {
        port: 3235,
        get url() {
            return `http://localhost:${this.port}`;
        },
        get entryPath() {
            if (app.isPackaged) {
                // Keep Nuxt server inside app.asar so Node ESM can resolve
                // bare package imports from app.asar/node_modules.
                const asarPath = join(process.resourcesPath, 'app.asar', 'nuxt-output', 'server', 'index.mjs');
                if (existsSync(asarPath)) {
                    return asarPath;
                }

                // Legacy fallback for older builds that unpacked Nuxt output.
                const unpackedPath = join(process.resourcesPath, 'app.asar.unpacked', 'nuxt-output', 'server', 'index.mjs');
                if (existsSync(unpackedPath)) {
                    return unpackedPath;
                }

                // Fallback for legacy non-asar layouts.
                return join(process.resourcesPath, 'nuxt-output', 'server', 'index.mjs');
            }

            return join(__dirname, '../nuxt-output/server/index.mjs');
        },
    },

    window: {
        width: 900,
        height: 700,
        title: 'EVB Viewer',
        backgroundColor: '#ffffff',
    },

    updates: {
        metadataUrl: process.env.EVB_UPDATES_METADATA_URL || 'https://evb-viewer.vercel.app/api/releases/latest',
        pollIntervalMs: parsePositiveInt(process.env.EVB_UPDATES_POLL_INTERVAL_MS, 6 * 60 * 60 * 1000),
        initialDelayMs: parsePositiveInt(process.env.EVB_UPDATES_INITIAL_DELAY_MS, 2 * 60 * 1000),
    },
} as const;
