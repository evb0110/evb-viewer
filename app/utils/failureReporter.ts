import type {
    captureException,
    getClient,
} from '@sentry/browser';
import type {
    CaptureFailureInput,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import {
    parseClientDiagnosticsPreference,
    type TClientDiagnosticsPreference,
} from '@contracts/diagnostics/diagnosticsPreference';
import {
    beforeSendSentryEvent,
    SENTRY_EXCLUDED_INTEGRATIONS,
} from '@contracts/diagnostics/scrubSentryEvent';
import { createEpochMs } from '@contracts/timestamps';
import { isRecord } from '@contracts/runtimeGuards';
import {
    getRawElectronPlatformApi,
    hasElectronPlatformBridge,
} from '@app/utils/electronPlatformBridge';
import { safeGetLocalStorageItem } from '@app/utils/localStorage';
import { BROWSER_SETTINGS_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

/** A report held back until the user answers the first-error consent prompt. */
export interface ILiveDiagnosticLease {
    readonly failure: FailureReceipt;
    readonly isLive: boolean;
    resendOnceAfterGrant(): boolean;
    discard(): void;
}

export interface IPresentedFailureCapture {
    failure: FailureReceipt;
    pendingDiagnostic?: ILiveDiagnosticLease;
}

/** The hosted browser build's Sentry settings. Electron renderers send through main instead. */
export interface IHostedSentryConfig {
    dsn: string;
    release: string;
    environment: string;
}

interface ISentrySdk {
    captureException: typeof captureException;
    getClient: typeof getClient;
}

let preference: TClientDiagnosticsPreference = readStartupPreference();
let hostedConfig: IHostedSentryConfig | null = null;
// The SDK stays out of the initial renderer chunk: it is imported only after
// consent, and failures before that keep a local Error ID and are not sent.
let sdk: ISentrySdk | null = null;
let sdkLoad: Promise<void> | null = null;
let suppressionDepth = 0;

function isElectronRenderer() {
    return hasElectronPlatformBridge();
}

function readStartupPreference(): TClientDiagnosticsPreference {
    if (typeof window === 'undefined') {
        return 'unknown';
    }
    const startupPolicy = getRawElectronPlatformApi()?.diagnostics.startupPolicy;
    if (startupPolicy) {
        return startupPolicy.mode;
    }
    try {
        const parsed: unknown = JSON.parse(safeGetLocalStorageItem(BROWSER_SETTINGS_STORAGE_KEY) ?? 'null');
        return isRecord(parsed) ? parseClientDiagnosticsPreference(parsed.clientDiagnosticsPreference) : 'unknown';
    } catch {
        return 'unknown';
    }
}

// Read after the import resolves, so a revoke during the load still wins.
function sdkOptions() {
    return {
        enabled: preference === 'granted',
        sendDefaultPii: false,
        integrations: <T extends {name: string}>(defaults: T[]) => defaults.filter(
            integration => !SENTRY_EXCLUDED_INTEGRATIONS.has(integration.name),
        ),
        beforeSend: beforeSendSentryEvent,
        beforeBreadcrumb: () => null,
    };
}

async function loadSdk() {
    if (isElectronRenderer()) {
        const Sentry = await import('@sentry/electron/renderer');
        Sentry.init(sdkOptions());
        sdk = Sentry;
        return;
    }
    if (hostedConfig?.dsn) {
        const Sentry = await import('@sentry/browser');
        Sentry.init({
            ...sdkOptions(),
            ...hostedConfig,
        });
        sdk = Sentry;
    }
}

function applyPreference() {
    const client = sdk?.getClient();
    if (client) {
        client.getOptions().enabled = preference === 'granted';
        return;
    }
    if (preference === 'granted' && sdkLoad === null) {
        sdkLoad = loadSdk().catch(() => {
            sdkLoad = null;
        });
    }
}

/** Called once by the diagnostics plugin. Consent off never loads an SDK. */
export function initializeRendererDiagnostics(config: IHostedSentryConfig | null = null) {
    hostedConfig = config;
    applyPreference();
}

export function setRendererDiagnosticsPreference(value: unknown) {
    preference = parseClientDiagnosticsPreference(value);
    applyPreference();
}

export function getRendererDiagnosticsPreference() {
    return preference;
}

function createEventId() {
    return globalThis.crypto.randomUUID().replaceAll('-', '');
}

/** The Error ID is chosen here so a held report can be resent under the ID the user already saw. */
function sendToSentry(input: CaptureFailureInput, eventId = createEventId()) {
    const cause = input.local.cause;
    sdk?.captureException(cause instanceof Error ? cause : new Error(input.local.message), {
        event_id: eventId,
        captureContext: {
            level: input.severity ?? 'error',
            tags: {diagnostic_code: input.code},
            fingerprint: [
                '{{ default }}',
                input.code,
            ],
        },
    });
    return eventId;
}

/** Sends the failure to Sentry when consent allows it. Callers log it locally with the returned receipt. */
export function captureRendererFailure(input: CaptureFailureInput): FailureReceipt {
    return {
        eventId: suppressionDepth > 0 ? createEventId() : sendToSentry(input),
        code: input.code,
        occurredAt: createEpochMs(Date.now()),
        severity: input.severity ?? 'error',
    };
}

/**
 * Captures a failure the UI shows. While consent is unanswered, the report is
 * held so the prompt can send it once, with the same Error ID, after a grant.
 */
export function captureFailureForPresentation(input: CaptureFailureInput): IPresentedFailureCapture {
    const failure = captureRendererFailure(input);
    if (suppressionDepth > 0 || preference !== 'unknown') {
        return {failure};
    }
    let live = true;
    return {
        failure,
        pendingDiagnostic: {
            failure,
            get isLive() {
                return live && preference !== 'denied';
            },
            resendOnceAfterGrant() {
                if (!live || preference !== 'granted') {
                    return false;
                }
                live = false;
                void (sdkLoad ?? Promise.resolve()).then(() => sendToSentry(input, failure.eventId));
                return true;
            },
            discard() {
                live = false;
            },
        },
    };
}

/** Runs a callback whose own captures stay local, for handlers chained behind one that already reported. */
export function withSuppressedCapture<T>(callback: () => T): T {
    suppressionDepth += 1;
    try {
        return callback();
    } finally {
        suppressionDepth -= 1;
    }
}
