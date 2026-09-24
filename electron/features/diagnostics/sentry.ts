import {
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { resolveApplicationVersion } from '@electron/appVersion';
import { getClient } from '@sentry/core';
import {
    parseClientDiagnosticsPreference,
    type TClientDiagnosticsPreference,
} from '@contracts/diagnostics/diagnosticsPreference';
import { beforeSendSentryEvent } from '@contracts/diagnostics/scrubSentryEvent';
import { captureMainFailure } from '@electron/utils/captureMainFailure';

declare const __EVB_SENTRY_DSN__: string | undefined;

const SENTRY_DSN = typeof __EVB_SENTRY_DSN__ === 'string' ? __EVB_SENTRY_DSN__ : '';
const STARTUP_CRASH_MARKER_FILE_NAME = 'startup-crash-marker.json';
// The app installs its own uncaught-exception and unhandled-rejection handlers,
// which report through the logger. Everything else in the SDK default set
// (breadcrumbs, screenshots, local variables, source context, sessions,
// tracing) is left out.
const MAIN_INTEGRATIONS = new Set([
    'Context',
    'ElectronContext',
    'EventFilters',
    'FunctionToString',
    'LinkedErrors',
    'NormalizePaths',
    'SentryMinidump',
]);

let preference: TClientDiagnosticsPreference = 'unknown';
let sdkLoad: Promise<void> | null = null;

function isReportingEnabled() {
    return preference === 'granted' && SENTRY_DSN !== '';
}

function markerPath() {
    return join(app.getPath('userData'), STARTUP_CRASH_MARKER_FILE_NAME);
}

async function loadSdk() {
    const Sentry = await import('@sentry/electron/main');
    Sentry.init({
        dsn: SENTRY_DSN,
        release: `evb-viewer-desktop@${resolveApplicationVersion(app)}`,
        environment: app.isPackaged ? 'production' : 'development',
        enabled: isReportingEnabled(),
        ipcMode: Sentry.IPCMode.Classic,
        sendDefaultPii: false,
        skipOpenTelemetrySetup: true,
        integrations: defaults => defaults.filter(integration => MAIN_INTEGRATIONS.has(integration.name)),
        beforeSend: beforeSendSentryEvent,
        beforeBreadcrumb: () => null,
    });
}

/** Starts the SDK on the first grant; later changes only toggle sending. Consent off never loads it. */
export function setMainDiagnosticsPreference(value: unknown) {
    preference = parseClientDiagnosticsPreference(value);
    const client = getClient();
    if (client) {
        client.getOptions().enabled = isReportingEnabled();
        return;
    }
    if (isReportingEnabled() && sdkLoad === null) {
        sdkLoad = loadSdk().catch(() => {
            sdkLoad = null;
        });
    }
}

export function getMainDiagnosticsPreference() {
    return preference;
}

/**
 * An exception thrown before the app installs its fatal handlers ends the
 * process before an asynchronous send can finish. With consent, the error is
 * written synchronously and reported on the next launch. Returns the disarm
 * function for the point where the app's own handler takes over.
 */
export function installStartupCrashMarker() {
    const monitor = (error: Error) => {
        if (!isReportingEnabled()) {
            return;
        }
        try {
            writeFileSync(markerPath(), JSON.stringify({
                name: error.name,
                message: error.message,
                stack: error.stack ?? '',
            }));
        } catch {
            // A marker is best effort; the crash itself proceeds unchanged.
        }
    };
    process.on('uncaughtExceptionMonitor', monitor);
    return () => {
        process.off('uncaughtExceptionMonitor', monitor);
    };
}

/** Runs once per launch in the primary instance: the marker is always removed, and sent only with consent. */
export function consumeStartupCrashMarker() {
    let marker: unknown;
    try {
        marker = JSON.parse(readFileSync(markerPath(), 'utf8'));
    } catch {
        return;
    } finally {
        rmSync(markerPath(), {force: true});
    }
    if (typeof marker !== 'object' || marker === null || sdkLoad === null) {
        return;
    }
    const {
        name,
        message,
        stack,
    } = marker as Record<string, unknown>;
    const error = new Error(typeof message === 'string' ? message : 'Startup crash');
    error.name = typeof name === 'string' ? name : 'Error';
    if (typeof stack === 'string' && stack !== '') {
        error.stack = stack;
    }
    void sdkLoad.then(() => captureMainFailure({
        code: 'MAIN_STARTUP_CRASH',
        message: error.message,
        cause: error,
        severity: 'fatal',
    }));
}
