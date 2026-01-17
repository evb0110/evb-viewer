/**
 * Browser-safe logging utility
 * Logs to console and can be easily grepped in browser devtools
 */

type TBrowserLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
type TLazyValue = unknown | (() => unknown);

const LOG_LEVELS: Record<TBrowserLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 50,
};

function normalizeLogLevel(value: unknown): TBrowserLogLevel | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toLowerCase();
    if (
        normalized === 'debug'
        || normalized === 'info'
        || normalized === 'warn'
        || normalized === 'error'
        || normalized === 'silent'
    ) {
        return normalized;
    }

    return null;
}

const DEFAULT_LOG_LEVEL: TBrowserLogLevel = import.meta.dev ? 'info' : 'warn';

const configuredLogLevel: TBrowserLogLevel = (() => {
    if (typeof window === 'undefined') {
        return DEFAULT_LOG_LEVEL;
    }

    try {
        const fromStorage = normalizeLogLevel(window.localStorage.getItem('electron-nuxt:log-level'));
        if (fromStorage) {
            return fromStorage;
        }
    } catch {
        // Ignore localStorage errors (privacy mode / disabled storage)
    }

    const maybeGlobal = normalizeLogLevel((window as unknown as { __logLevel?: unknown }).__logLevel);
    if (maybeGlobal) {
        return maybeGlobal;
    }

    return DEFAULT_LOG_LEVEL;
})();

function shouldLog(level: TBrowserLogLevel) {
    return LOG_LEVELS[level] >= LOG_LEVELS[configuredLogLevel];
}

export const BrowserLogger = {
    debug: (section: string, message: string, data?: TLazyValue) => {
        if (!shouldLog('debug')) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        const resolved = typeof data === 'function' ? data() : data;

        if (resolved !== undefined) {
            console.log(`${prefix} ${message}`, resolved);
        } else {
            console.log(`${prefix} ${message}`);
        }
    },

    info: (section: string, message: string, data?: TLazyValue) => {
        if (!shouldLog('info')) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        const resolved = typeof data === 'function' ? data() : data;

        if (resolved !== undefined) {
            console.info(`${prefix} ${message}`, resolved);
        } else {
            console.info(`${prefix} ${message}`);
        }
    },

    warn: (section: string, message: string, data?: TLazyValue) => {
        if (!shouldLog('warn')) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        const resolved = typeof data === 'function' ? data() : data;

        if (resolved !== undefined) {
            console.warn(`${prefix} ${message}`, resolved);
        } else {
            console.warn(`${prefix} ${message}`);
        }
    },

    error: (section: string, message: string, error?: TLazyValue) => {
        if (!shouldLog('error')) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        const resolved = typeof error === 'function' ? error() : error;

        if (resolved !== undefined) {
            console.error(`${prefix} ${message}`, resolved);
        } else {
            console.error(`${prefix} ${message}`);
        }
    },
};

export default BrowserLogger;
