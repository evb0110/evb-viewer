import {isIP} from 'node:net';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';

const __dirname = dirname(fileURLToPath(import.meta.url));
type TElectronAppPackagingState = Pick<typeof app, 'isPackaged'>;

export function resolveIsPackaged(electronApp: TElectronAppPackagingState = app) {
    return electronApp.isPackaged;
}

const isPackaged = resolveIsPackaged();
const DEFAULT_SERVER_HOST = normalizeServerHost(process.env.EVB_SERVER_HOST, '127.0.0.1');
const DEFAULT_SERVER_PORT = parsePositiveInt(process.env.EVB_SERVER_PORT, 3235);
const DEFAULT_SERVER_PATH = normalizeServerPath(process.env.EVB_SERVER_PATH, '/electron');
const APP_PROTOCOL_ORIGIN = 'evb-viewer://app';
const DEFAULT_UPDATES_METADATA_URL = 'https://evb-viewer.com/api/releases/latest';
const DEFAULT_UPDATES_MIRROR_METADATA_URL = 'https://vps-420c0bae.vps.ovh.net/api/mss-backend/api/evb-viewer/channels/stable.json';
const DEFAULT_UPDATES_MIRROR_RELEASE_BASE_URL = 'https://vps-420c0bae.vps.ovh.net/api/mss-backend/api/evb-viewer/releases';
// One week is the longest useful updater interval. It also leaves ample room
// below Node's signed 32-bit timer limit for the scheduler's poll jitter.
const UPDATER_INTERVAL_MAX_MS = 7 * 24 * 60 * 60 * 1000;
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

function parseUpdaterIntervalMs(raw: string | undefined, fallback: number) {
    if (!raw || !/^\d+$/.test(raw)) {
        return fallback;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= UPDATER_INTERVAL_MAX_MS
        ? parsed
        : fallback;
}

function normalizeUpdaterUrl(raw: string | undefined, fallback: string) {
    const trimmed = raw?.trim();
    const authorityMatch = trimmed?.match(/^https?:\/\/([^/?#]+)/iu);
    const hasAsciiWhitespaceOrControl = trimmed
        ? Array.from(trimmed).some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint <= 0x20 || codePoint === 0x7F;
        })
        : false;
    if (!trimmed || !authorityMatch || hasAsciiWhitespaceOrControl) {
        return fallback;
    }

    try {
        const parsed = new URL(trimmed);
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0) {
            return parsed.href;
        }
    } catch {
        // Fall through to the endpoint's own default.
    }

    return fallback;
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

    if (process.env.EVB_ALLOW_UNSAFE_REMOTE_DEV_SERVER !== '1' && !isLoopbackHost(trimmed)) {
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
    isDev: !isPackaged,
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
            return isPackaged
                ? `${APP_PROTOCOL_ORIGIN}/electron`
                : config.server.url;
        },
        get trustedOrigin() {
            return isPackaged
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
        metadataUrl: normalizeUpdaterUrl(
            process.env.EVB_UPDATES_METADATA_URL,
            DEFAULT_UPDATES_METADATA_URL,
        ),
        mirrorMetadataUrl: normalizeUpdaterUrl(
            process.env.EVB_UPDATES_MIRROR_METADATA_URL,
            DEFAULT_UPDATES_MIRROR_METADATA_URL,
        ),
        mirrorReleaseBaseUrl: normalizeUpdaterUrl(
            process.env.EVB_UPDATES_MIRROR_RELEASE_BASE_URL,
            DEFAULT_UPDATES_MIRROR_RELEASE_BASE_URL,
        ).replace(/\/+$/u, ''),
        pollIntervalMs: parseUpdaterIntervalMs(process.env.EVB_UPDATES_POLL_INTERVAL_MS, 6 * 60 * 60 * 1000),
        initialDelayMs: parseUpdaterIntervalMs(process.env.EVB_UPDATES_INITIAL_DELAY_MS, 2 * 60 * 1000),
    },

    automation: {
        noFocus: process.env.EVB_AUTOMATION_NO_FOCUS === '1',
        hideWindow: process.env.EVB_AUTOMATION_HIDE_WINDOW
            ? process.env.EVB_AUTOMATION_HIDE_WINDOW === '1'
            : process.env.EVB_AUTOMATION_NO_FOCUS === '1',
    },
} as const;
