import {isIP} from 'node:net';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';
import {runtimeConfig} from '@electron/runtimeConfig';

const __dirname = dirname(fileURLToPath(import.meta.url));
type TElectronAppPackagingState = Pick<typeof app, 'isPackaged'>;

export function resolveIsPackaged(electronApp: TElectronAppPackagingState = app) {
    return electronApp.isPackaged;
}

const isPackaged = resolveIsPackaged();
// An unpackaged run loads the Nuxt dev server unless it asks for the built
// renderer in nuxt-output/public, which is what the packaged app serves and
// what Electron E2E runs against.
const usesBuiltRenderer = isPackaged || runtimeConfig.builtRenderer;
const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = runtimeConfig.serverPort;
const DEFAULT_SERVER_PATH = normalizeServerPath(runtimeConfig.serverPath, '/electron');
const APP_PROTOCOL_ORIGIN = 'evb-viewer://app';
const DEFAULT_UPDATES_METADATA_URL = 'https://evb-viewer.com/api/releases/latest';
const DEFAULT_UPDATES_MIRROR_METADATA_URL = 'https://vps-420c0bae.vps.ovh.net/api/mss-backend/api/evb-viewer/channels/stable.json';
const DEFAULT_UPDATES_MIRROR_RELEASE_BASE_URL = 'https://vps-420c0bae.vps.ovh.net/api/mss-backend/api/evb-viewer/releases';
const DEFAULT_UPDATES_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_UPDATES_INITIAL_DELAY_MS = 2 * 60 * 1000;
let runtimeServerHost = DEFAULT_SERVER_HOST;
let runtimeServerPort = DEFAULT_SERVER_PORT;
let runtimeServerPath = DEFAULT_SERVER_PATH;

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

function normalizeServerPath(raw: string | undefined, fallback: string) {
    const trimmed = raw?.trim();
    if (!trimmed) {
        return fallback;
    }

    if (trimmed === '/') {
        return trimmed;
    }

    return trimmed.startsWith('/')
        ? trimmed
        : `/${trimmed}`;
}

function normalizeServerHost(raw: string | undefined, fallback: string) {
    const trimmed = raw?.trim();
    if (!trimmed) {
        return fallback;
    }

    if (!isLoopbackHost(trimmed)) {
        return fallback;
    }

    return trimmed;
}

function isLoopbackHost(host: string) {
    const normalized = host.toLowerCase();
    if (normalized === 'localhost') {
        return true;
    }

    const unbracketedHost = normalized.replace(/^\[|\]$/gu, '');
    const ipVersion = isIP(unbracketedHost);
    return (ipVersion === 4 && unbracketedHost.startsWith('127.'))
        || (ipVersion === 6 && unbracketedHost === '::1');
}

export const config = {
    isDev: !usesBuiltRenderer,
    isMac: process.platform === 'darwin',

    server: {
        get host() {
            return runtimeServerHost;
        },
        setHost(host: string) {
            runtimeServerHost = normalizeServerHost(host, DEFAULT_SERVER_HOST);
        },
        get port() {
            return runtimeServerPort;
        },
        setPort(port: number) {
            // Keep server URL mutable per-launch so packaged builds can avoid
            // attaching to pre-bound localhost ports owned by other processes.
            runtimeServerPort = parsePositiveInt(String(port), DEFAULT_SERVER_PORT);
        },
        get path() {
            return runtimeServerPath;
        },
        setPath(path: string) {
            runtimeServerPath = normalizeServerPath(path, DEFAULT_SERVER_PATH);
        },
        get url() {
            return `http://${this.host}:${this.port}${this.path}`;
        },
    },

    renderer: {
        protocolOrigin: APP_PROTOCOL_ORIGIN,
        get url() {
            return usesBuiltRenderer
                ? `${APP_PROTOCOL_ORIGIN}/electron`
                : config.server.url;
        },
        get trustedOrigin() {
            return usesBuiltRenderer
                ? APP_PROTOCOL_ORIGIN
                : new URL(config.server.url).origin;
        },
        get trustedUrl() {
            return this.url;
        },
        get staticRoot() {
            if (isPackaged) {
                return join(process.resourcesPath, 'app.asar', 'nuxt-output', 'public');
            }
            return join(__dirname, '../nuxt-output/public');
        },
    },

    window: {
        width: 900,
        height: 700,
        title: 'EVB Viewer',
        backgroundColor: '#ffffff',
    },

    updates: {
        metadataUrl: DEFAULT_UPDATES_METADATA_URL,
        mirrorMetadataUrl: DEFAULT_UPDATES_MIRROR_METADATA_URL,
        mirrorReleaseBaseUrl: DEFAULT_UPDATES_MIRROR_RELEASE_BASE_URL,
        pollIntervalMs: DEFAULT_UPDATES_POLL_INTERVAL_MS,
        initialDelayMs: DEFAULT_UPDATES_INITIAL_DELAY_MS,
    },

    automation: {
        noFocus: runtimeConfig.automationNoFocus,
        hideWindow: runtimeConfig.automationHideWindow,
    },
} as const;
