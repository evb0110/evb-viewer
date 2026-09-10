import type {DiagnosticCode} from '@contracts/diagnostics/diagnosticCodes';
import {
    createDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    createDiagnosticFallbackEventId,
    createSafeDiagnosticEventId,
    safeDiagnosticNow,
} from '@contracts/diagnostics/diagnosticReporterIdentity';
import {
    decodeDiagnosticRecord,
    type DiagnosticRecord,
    type DiagnosticRuntime,
} from '@contracts/diagnostics/diagnosticRecord';
import type {
    CaptureFailureInput,
    FailureReceipt,
    LocalFailureDetail,
} from '@contracts/diagnostics/failureReceipt';
import {buildDiagnosticRecord} from '@contracts/diagnostics/buildDiagnosticRecord';
import {
    createDiagnosticBurstAdmissionReserver,
    createDiagnosticFailureReceipt,
    createDiagnosticBurstDecider,
    getDiagnosticBurstKey,
} from '@contracts/diagnostics/diagnosticReporterShared';
import { getOptionalFunction } from '@app/services/pdfjs/runtime';
import { parseClientDiagnosticsPreference } from '@contracts/diagnostics/diagnosticsPreference';
import { DIAGNOSTICS_MAX_SUPPRESSED_COUNT } from '@contracts/diagnostics/diagnosticsCapability';
import { isRecord } from '@contracts/runtimeGuards';
import { safeGetLocalStorageItem } from '@app/utils/localStorage';
import { BROWSER_SETTINGS_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

export type TRendererDiagnosticsHost = 'electron' | 'hosted-browser';
export type TRendererDiagnosticsPreference = ReturnType<typeof parseClientDiagnosticsPreference>;

export type TRendererDiagnosticsDropReason =
    | 'owned-projection'
    | 'policy-dropped'
    | 'duplicate'
    | 'burst-suppressed'
    | 'schema-dropped'
    | 'frameless-dropped'
    | 'transport-failed';

export interface IRendererDiagnosticsHealthSnapshot {
    mode: TRendererDiagnosticsPreference;
    initializationCount: number;
    attempted: number;
    accepted: number;
    duplicate: number;
    burstSuppressed: number;
    policyDropped: number;
    schemaDropped: number;
    framelessDropped: number;
    ownedProjection: number;
    transportFailed: number;
    lastDropReason: TRendererDiagnosticsDropReason | null;
}

/** The only Electron boundary this reporter knows. Preload wiring belongs to SEN-CORE-09. */
export type TRendererDiagnosticSender = (record: DiagnosticRecord, suppressedCount?: number) => unknown;

export interface IHostedDiagnosticsTransport {send: (record: DiagnosticRecord, suppressedCount?: number) => unknown;}

export interface IRendererFailureReporterOptions {
    host?: TRendererDiagnosticsHost;
    preference?: unknown;
    now?: () => number;
    createEventId?: () => DiagnosticEventId;
    burstLimit?: number;
    burstWindowMs?: number;
    recentIdWindowMs?: number;
    electronSender?: TRendererDiagnosticSender;
    readHostedPreference?: () => unknown;
    loadHostedTransport?: () => IHostedDiagnosticsTransport | Promise<IHostedDiagnosticsTransport>;
    localSink?: (detail: LocalFailureDetail, receipt: FailureReceipt) => void;
    rawWarningSink?: (message: string) => void;
}

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

export interface IRendererFailureReporter {
    capture<C extends DiagnosticCode>(
        input: CaptureFailureInput<C>,
        options?: IRendererFailureCaptureOptions,
    ): FailureReceipt;
    captureForPresentation<C extends DiagnosticCode>(
        input: CaptureFailureInput<C>,
        options?: IRendererFailureCaptureOptions,
    ): IPresentedFailureCapture;
    captureRecord(value: unknown): FailureReceipt;
    getHealthSnapshot(): IRendererDiagnosticsHealthSnapshot;
    getPreference(): TRendererDiagnosticsPreference;
    getGeneration(): number;
    setPreference(preference: unknown): void;
    withSuppressedCapture<T>(callback: () => T): T;
    /** Adds late-bound integration callbacks without resetting reporter state. */
    fillMissingOptions(options: IRendererFailureReporterOptions): void;
    dispose(): void;
}

export interface IRendererFailureCaptureOptions {
    localAlreadyRecorded?: boolean;
    runtime?: 'browser-worker-parent';
}

export const RENDERER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT = DIAGNOSTICS_MAX_SUPPRESSED_COUNT;
export const RENDERER_DIAGNOSTICS_DEFAULT_BURST_LIMIT = 20;
export const RENDERER_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS = 60_000;
export const RENDERER_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS = 10 * 60_000;

const RENDERER_DIAGNOSTICS_MAX_RECENT_IDS = 4_096;
const RENDERER_DIAGNOSTICS_MAX_BURST_KEYS = 1_024;
const RENDERER_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES = [
    'app/utils/failureReporter.ts',
    'app/utils/browserLogger.ts',
] as const;
const MAX_TRANSPORT_WARNING_LENGTH = 512;

interface IBurstState {
    sentCount: number;
    startedAt: number;
    suppressedCount: number;
}

interface IHealthState extends IRendererDiagnosticsHealthSnapshot {}

let fallbackEventIdCounter = 0;
let rendererFailureReporter: IRendererFailureReporter | null = null;
let pendingRendererDiagnosticsPreference: TRendererDiagnosticsPreference | null = null;

function normalizePreference(value: unknown): TRendererDiagnosticsPreference {
    return parseClientDiagnosticsPreference(value);
}

export function readHostedDiagnosticsPreferenceSync(): TRendererDiagnosticsPreference {
    const rawSettings = safeGetLocalStorageItem(BROWSER_SETTINGS_STORAGE_KEY);
    if (rawSettings === null) {
        return 'unknown';
    }

    try {
        const parsed: unknown = JSON.parse(rawSettings);
        return isRecord(parsed)
            ? parseClientDiagnosticsPreference(parsed.clientDiagnosticsPreference)
            : 'unknown';
    } catch {
        return 'unknown';
    }
}

function normalizePositiveInteger(value: unknown, fallback: number) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0
        ? value
        : fallback;
}

function increment(value: number) {
    return value >= Number.MAX_SAFE_INTEGER
        ? Number.MAX_SAFE_INTEGER
        : value + 1;
}

function nextFallbackEventIdCounter() {
    fallbackEventIdCounter = (fallbackEventIdCounter + 1) >>> 0;
    return fallbackEventIdCounter;
}

const createFallbackEventId = () => createDiagnosticFallbackEventId(nextFallbackEventIdCounter);

function buildRendererDiagnosticRecord(
    input: CaptureFailureInput,
    runtime: DiagnosticRuntime,
    eventId: DiagnosticEventId,
    occurredAt: number,
) {
    return buildDiagnosticRecord(input, eventId, occurredAt, {
        fallbackCode: 'UNCLASSIFIED_RENDERER_ERROR',
        fallbackOperation: 'renderer-error',
        internalFrameSuffixes: RENDERER_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES,
        runtime,
    });
}

function createHealthState(): IHealthState {
    return {
        mode: 'unknown',
        initializationCount: 1,
        attempted: 0,
        accepted: 0,
        duplicate: 0,
        burstSuppressed: 0,
        policyDropped: 0,
        schemaDropped: 0,
        framelessDropped: 0,
        ownedProjection: 0,
        transportFailed: 0,
        lastDropReason: null,
    };
}

function serializeHealthState(state: IHealthState): IRendererDiagnosticsHealthSnapshot {
    return Object.freeze({...state});
}

function resolveRuntime(host: TRendererDiagnosticsHost): DiagnosticRuntime {
    return host === 'electron' ? 'electron-renderer' : 'hosted-browser';
}

export function detectRendererDiagnosticsHost(): TRendererDiagnosticsHost {
    try {
        const rendererWindow: unknown = Reflect.get(globalThis, 'window');
        if (rendererWindow === null || typeof rendererWindow !== 'object') {
            return 'hosted-browser';
        }
        const electronApi: unknown = Reflect.get(rendererWindow, 'electronAPI');
        return electronApi !== null && typeof electronApi === 'object'
            ? 'electron'
            : 'hosted-browser';
    } catch {
        return 'hosted-browser';
    }
}

function getElectronDiagnosticSender(): TRendererDiagnosticSender | null {
    try {
        const rendererWindow: unknown = Reflect.get(globalThis, 'window');
        if (rendererWindow === null || typeof rendererWindow !== 'object') {
            return null;
        }
        const electronApi: unknown = Reflect.get(rendererWindow, 'electronAPI');
        if (electronApi === null || typeof electronApi !== 'object') {
            return null;
        }
        const diagnostics: unknown = Reflect.get(electronApi, 'diagnostics');
        if (diagnostics === null || typeof diagnostics !== 'object') {
            return null;
        }
        const sender = getOptionalFunction<[DiagnosticRecord, number | undefined]>(diagnostics, 'sendRecord');
        if (!sender) {
            return null;
        }
        return (record, suppressedCount) => sender.call(diagnostics, record, suppressedCount);
    } catch {
        return null;
    }
}

function readElectronDiagnosticsPreferenceSync(): TRendererDiagnosticsPreference {
    try {
        const rendererWindow: unknown = Reflect.get(globalThis, 'window');
        if (rendererWindow === null || typeof rendererWindow !== 'object') {
            return 'unknown';
        }
        const electronApi: unknown = Reflect.get(rendererWindow, 'electronAPI');
        if (electronApi === null || typeof electronApi !== 'object') {
            return 'unknown';
        }
        const diagnostics: unknown = Reflect.get(electronApi, 'diagnostics');
        if (diagnostics === null || typeof diagnostics !== 'object') {
            return 'unknown';
        }
        const startupPolicy: unknown = Reflect.get(diagnostics, 'startupPolicy');
        if (startupPolicy === null || typeof startupPolicy !== 'object') {
            return 'unknown';
        }
        return normalizePreference(Reflect.get(startupPolicy, 'mode'));
    } catch {
        return 'unknown';
    }
}

export function createRendererFailureReporter(
    options: IRendererFailureReporterOptions = {},
): IRendererFailureReporter {
    const host = options.host ?? 'hosted-browser';
    const now = options.now ?? Date.now;
    const createEventId = options.createEventId ?? createDiagnosticEventId;
    const burstLimit = normalizePositiveInteger(
        options.burstLimit,
        RENDERER_DIAGNOSTICS_DEFAULT_BURST_LIMIT,
    );
    const burstWindowMs = normalizePositiveInteger(
        options.burstWindowMs,
        RENDERER_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS,
    );
    const recentIdWindowMs = normalizePositiveInteger(
        options.recentIdWindowMs,
        RENDERER_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS,
    );
    const initialPreference = normalizePreference(
        options.preference
            ?? (host === 'electron' ? readElectronDiagnosticsPreferenceSync() : 'unknown'),
    );
    const health = createHealthState();
    health.mode = initialPreference;
    const recentIds = new Map<DiagnosticEventId, number>();
    const burstStates = new Map<string, IBurstState>();
    let electronSender = options.electronSender;
    let hostedTransportLoad: Promise<IHostedDiagnosticsTransport> | null = null;
    let readHostedPreference = options.readHostedPreference;
    let loadHostedTransport = options.loadHostedTransport;
    let localSink = options.localSink;
    let rawWarningSink = options.rawWarningSink;
    let suppressionDepth = 0;
    let warningInProgress = false;
    let preference = initialPreference;
    let preferencePinned = options.preference !== undefined || host === 'electron';
    let generation = 0;
    let disposed = false;
    const dropLiveSender: TRendererDiagnosticSender = () => undefined;
    let liveSender: TRendererDiagnosticSender = preference === 'granted'
        ? sendLiveRecord
        : dropLiveSender;

    function applyPreference(value: unknown, pin: boolean) {
        const nextPreference = normalizePreference(value);
        const wasGranted = preference === 'granted';
        if (nextPreference !== 'granted') {
            // Drop the live path before changing any state that an async
            // continuation can observe. The generation fences already-started
            // hosted loads after this pointer swap.
            liveSender = dropLiveSender;
            if (preference !== nextPreference) {
                generation = increment(generation);
            }
            if (wasGranted || preference !== nextPreference) {
                hostedTransportLoad = null;
            }
        } else {
            liveSender = sendLiveRecord;
        }
        preference = nextPreference;
        health.mode = nextPreference;
        if (pin) {
            preferencePinned = true;
            pendingRendererDiagnosticsPreference = nextPreference;
        }
    }

    function syncHostedPreference() {
        if (host !== 'hosted-browser') {
            return;
        }

        let nextPreference: TRendererDiagnosticsPreference;
        try {
            nextPreference = normalizePreference(
                readHostedPreference
                    ? readHostedPreference()
                    : readHostedDiagnosticsPreferenceSync(),
            );
        } catch {
            nextPreference = 'unknown';
        }
        if (nextPreference !== 'granted' || !preferencePinned) {
            applyPreference(nextPreference, false);
        }
    }

    function onHostedSettingsChanged(event?: Event) {
        if (disposed || host !== 'hosted-browser') {
            return;
        }
        if (
            event?.type === 'storage'
            && (event as StorageEvent).key !== null
            && (event as StorageEvent).key !== BROWSER_SETTINGS_STORAGE_KEY
        ) {
            return;
        }
        syncHostedPreference();
    }

    function addHostedPreferenceListeners() {
        if (
            host !== 'hosted-browser'
            || typeof window === 'undefined'
            || typeof window.addEventListener !== 'function'
        ) {
            return;
        }
        window.addEventListener('storage', onHostedSettingsChanged);
        window.addEventListener('focus', onHostedSettingsChanged);
        window.addEventListener('pageshow', onHostedSettingsChanged);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onHostedSettingsChanged);
        }
    }

    function removeHostedPreferenceListeners() {
        if (
            host !== 'hosted-browser'
            || typeof window === 'undefined'
            || typeof window.removeEventListener !== 'function'
        ) {
            return;
        }
        window.removeEventListener('storage', onHostedSettingsChanged);
        window.removeEventListener('focus', onHostedSettingsChanged);
        window.removeEventListener('pageshow', onHostedSettingsChanged);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onHostedSettingsChanged);
        }
    }

    function setDropReason(reason: TRendererDiagnosticsDropReason) {
        health.lastDropReason = reason;
    }

    function pruneRecentIds(currentTime: number) {
        for (const [
            eventId,
            reservedAt,
        ] of recentIds) {
            if (currentTime - reservedAt >= recentIdWindowMs) {
                recentIds.delete(eventId);
            }
        }
        while (recentIds.size > RENDERER_DIAGNOSTICS_MAX_RECENT_IDS) {
            const oldestEventId = recentIds.keys().next().value;
            if (oldestEventId === undefined) {
                break;
            }
            recentIds.delete(oldestEventId);
        }
    }

    function pruneBurstStates() {
        while (burstStates.size > RENDERER_DIAGNOSTICS_MAX_BURST_KEYS) {
            const oldestKey = burstStates.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            burstStates.delete(oldestKey);
        }
    }

    function writeRawTransportWarning(record: DiagnosticRecord) {
        if (warningInProgress || !rawWarningSink) {
            return;
        }
        warningInProgress = true;
        try {
            const message = `Diagnostics transport failed for ${record.code} (${record.eventId})`;
            rawWarningSink(message.slice(0, MAX_TRANSPORT_WARNING_LENGTH));
        } catch {
            // The raw sink is intentionally unobserved. It must not become another occurrence.
        } finally {
            warningInProgress = false;
        }
    }

    function recordLocalDetail(detail: LocalFailureDetail, receipt: FailureReceipt) {
        try {
            localSink?.(detail, receipt);
        } catch {
            // Local logging cannot break the originating failure owner.
        }
    }

    const decideBurst = createDiagnosticBurstDecider({
        burstStates,
        burstLimit,
        burstWindowMs,
        maxSuppressedCount: RENDERER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
        pruneBurstStates,
        onSuppressed: () => {
            health.burstSuppressed = increment(health.burstSuppressed);
            setDropReason('burst-suppressed');
        },
    });

    const reserveAdmission = createDiagnosticBurstAdmissionReserver({
        burstStates,
        recentIds,
        pruneRecentIds,
        increment,
    });

    function markAccepted() {
        health.accepted = increment(health.accepted);
    }

    function reportTransportFailure(record: DiagnosticRecord) {
        health.transportFailed = increment(health.transportFailed);
        setDropReason('transport-failed');
        writeRawTransportWarning(record);
    }

    function reportTransportResult(
        result: unknown,
        record: DiagnosticRecord,
        isCurrent: () => boolean = () => true,
    ) {
        try {
            if (
                result === null
                || (typeof result !== 'object' && typeof result !== 'function')
                || typeof (result as {then?: unknown}).then !== 'function'
            ) {
                if (!isCurrent()) {
                    return;
                }
                if (result === false) {
                    reportTransportFailure(record);
                } else {
                    markAccepted();
                }
                return;
            }
            const pending: Promise<unknown> = Promise.resolve(result);
            void pending.then(
                resolved => {
                    if (!isCurrent()) {
                        return;
                    }
                    if (resolved === false) {
                        reportTransportFailure(record);
                    } else {
                        markAccepted();
                    }
                },
                () => {
                    if (isCurrent()) {
                        reportTransportFailure(record);
                    }
                },
            );
        } catch {
            if (isCurrent()) {
                reportTransportFailure(record);
            }
        }
    }

    function sendElectronRecord(record: DiagnosticRecord, suppressedCount: number) {
        try {
            const sender = electronSender ?? getElectronDiagnosticSender();
            if (!sender) {
                return false;
            }
            const result = suppressedCount > 0
                ? sender(record, suppressedCount)
                : sender(record);
            reportTransportResult(result, record);
            return true;
        } catch {
            return false;
        }
    }

    function sendHostedRecord(
        record: DiagnosticRecord,
        suppressedCount: number,
        generationAtAdmission = generation,
    ) {
        if (hostedTransportLoad === null) {
            try {
                const loaded = loadHostedTransport?.();
                if (!loaded) {
                    reportTransportFailure(record);
                    return false;
                }
                hostedTransportLoad = Promise.resolve(loaded);
            } catch {
                reportTransportFailure(record);
                return false;
            }
        }

        const transportLoad = hostedTransportLoad;
        void transportLoad.then((transport) => {
            // Storage events can be delayed or missed. Re-read persisted consent
            // at the last synchronous point before admitting the request.
            syncHostedPreference();
            if (
                generationAtAdmission !== generation
                || preference !== 'granted'
                || liveSender !== sendLiveRecord
            ) {
                return;
            }
            try {
                const result = suppressedCount > 0
                    ? transport.send(record, suppressedCount)
                    : transport.send(record);
                reportTransportResult(
                    result,
                    record,
                    () => generationAtAdmission === generation
                        && preference === 'granted'
                        && liveSender === sendLiveRecord,
                );
            } catch {
                if (generationAtAdmission === generation && preference.valueOf() === 'granted') {
                    reportTransportFailure(record);
                }
            }
        }, () => {
            if (hostedTransportLoad === transportLoad) {
                hostedTransportLoad = null;
            }
            if (generationAtAdmission === generation && preference === 'granted') {
                reportTransportFailure(record);
            }
        });
        return true;
    }

    function sendLiveRecord(record: DiagnosticRecord, suppressedCount = 0) {
        return host === 'electron'
            ? sendElectronRecord(record, suppressedCount)
            : sendHostedRecord(record, suppressedCount, generation);
    }

    function reserveResend(record: DiagnosticRecord, currentTime: number) {
        const key = getDiagnosticBurstKey(record);
        if (!burstStates.has(key)) {
            burstStates.set(key, {
                sentCount: 0,
                startedAt: currentTime,
                suppressedCount: 0,
            });
            pruneBurstStates();
        }
        reserveAdmission(record, currentTime, {key});
    }

    function resendClosedRecord(record: DiagnosticRecord, generationAtCapture: number) {
        if (
            generationAtCapture !== generation
            || preference !== 'granted'
            || liveSender === dropLiveSender
        ) {
            return false;
        }

        health.attempted = increment(health.attempted);
        const currentTime = safeDiagnosticNow(now);
        pruneRecentIds(currentTime);
        reserveResend(record, currentTime);
        const result = liveSender(record);
        if (result === false) {
            if (host === 'electron') {
                reportTransportFailure(record);
            }
            return false;
        }
        return true;
    }

    function processRecord(
        record: DiagnosticRecord,
        detail: LocalFailureDetail,
        captureOptions: IRendererFailureCaptureOptions = {},
    ): FailureReceipt {
        const receipt = createDiagnosticFailureReceipt(record);
        if (disposed) {
            return receipt;
        }
        if (suppressionDepth > 0) {
            health.ownedProjection = increment(health.ownedProjection);
            setDropReason('owned-projection');
            return receipt;
        }

        health.attempted = increment(health.attempted);
        if (!captureOptions.localAlreadyRecorded) {
            recordLocalDetail(detail, receipt);
        }

        syncHostedPreference();
        if (
            host !== 'electron'
            && (preference !== 'granted' || liveSender === dropLiveSender)
        ) {
            health.policyDropped = increment(health.policyDropped);
            setDropReason('policy-dropped');
            return receipt;
        }

        const currentTime = safeDiagnosticNow(now);
        pruneRecentIds(currentTime);
        if (recentIds.has(record.eventId)) {
            health.duplicate = increment(health.duplicate);
            setDropReason('duplicate');
            return receipt;
        }

        const decision = decideBurst(record, currentTime);
        if (!decision.send) {
            return receipt;
        }

        if (host === 'electron') {
            reserveAdmission(record, currentTime, decision);
            if (!sendElectronRecord(record, decision.suppressedCount)) {
                reportTransportFailure(record);
                return receipt;
            }
            return receipt;
        }

        reserveAdmission(record, currentTime, decision);
        sendHostedRecord(record, decision.suppressedCount, generation);
        return receipt;
    }

    function buildCaptureRecord<C extends DiagnosticCode>(
        input: CaptureFailureInput<C>,
        captureOptions: IRendererFailureCaptureOptions,
    ) {
        const runtime = captureOptions.runtime ?? resolveRuntime(host);
        try {
            return {
                detail: input.local,
                record: buildRendererDiagnosticRecord(
                    input,
                    runtime,
                    createSafeDiagnosticEventId(createEventId, createFallbackEventId),
                    safeDiagnosticNow(now),
                ),
            };
        } catch {
            return {
                detail: {
                    source: 'failure-reporter',
                    message: 'Renderer failure reporter fallback',
                },
                record: buildRendererDiagnosticRecord(
                    {} as CaptureFailureInput,
                    runtime,
                    createFallbackEventId(),
                    safeDiagnosticNow(now),
                ),
            };
        }
    }

    function createLiveDiagnosticLease(
        record: DiagnosticRecord,
        failure: FailureReceipt,
        generationAtCapture: number,
    ): ILiveDiagnosticLease {
        let retainedRecord: DiagnosticRecord | null = record;
        let live = true;

        return {
            failure,
            get isLive() {
                return live
                    && retainedRecord !== null
                    && generation === generationAtCapture
                    && (preference === 'unknown' || preference === 'granted');
            },
            resendOnceAfterGrant() {
                if (
                    !live
                    || retainedRecord === null
                    || generation !== generationAtCapture
                    || preference !== 'granted'
                ) {
                    return false;
                }

                const recordToResend = retainedRecord;
                retainedRecord = null;
                live = false;
                return resendClosedRecord(recordToResend, generationAtCapture);
            },
            discard() {
                retainedRecord = null;
                live = false;
            },
        };
    }

    addHostedPreferenceListeners();

    return {
        capture: <C extends DiagnosticCode>(
            input: CaptureFailureInput<C>,
            captureOptions: IRendererFailureCaptureOptions = {},
        ) => {
            const capture = buildCaptureRecord(input, captureOptions);
            return processRecord(capture.record, capture.detail, captureOptions);
        },
        captureForPresentation: <C extends DiagnosticCode>(
            input: CaptureFailureInput<C>,
            captureOptions: IRendererFailureCaptureOptions = {},
        ) => {
            const capture = buildCaptureRecord(input, captureOptions);
            const failure = processRecord(capture.record, capture.detail, captureOptions);
            const runtime = captureOptions.runtime ?? resolveRuntime(host);
            if (
                suppressionDepth > 0
                || preference !== 'unknown'
                || runtime !== resolveRuntime(host)
            ) {
                return {failure};
            }

            return {
                failure,
                pendingDiagnostic: createLiveDiagnosticLease(
                    capture.record,
                    failure,
                    generation,
                ),
            };
        },
        captureRecord: (value) => {
            try {
                const record = decodeDiagnosticRecord(value);
                if (record !== null && record.runtime === resolveRuntime(host)) {
                    return processRecord(record, {
                        source: 'failure-reporter',
                        message: 'Captured closed renderer record',
                    });
                }
            } catch {
                // Malformed external input is counted below and never reaches a transport.
            }

            health.attempted = increment(health.attempted);
            health.schemaDropped = increment(health.schemaDropped);
            setDropReason('schema-dropped');
            const record = buildRendererDiagnosticRecord(
                {} as CaptureFailureInput,
                resolveRuntime(host),
                createSafeDiagnosticEventId(createEventId, createFallbackEventId),
                safeDiagnosticNow(now),
            );
            return createDiagnosticFailureReceipt(record);
        },
        getHealthSnapshot: () => serializeHealthState(health),
        getPreference: () => preference,
        getGeneration: () => generation,
        setPreference: (value: unknown) => {
            applyPreference(value, true);
        },
        withSuppressedCapture: <T>(callback: () => T) => {
            suppressionDepth = increment(suppressionDepth);
            try {
                return callback();
            } finally {
                suppressionDepth = Math.max(0, suppressionDepth - 1);
            }
        },
        fillMissingOptions: (lateOptions) => {
            health.initializationCount = increment(health.initializationCount);
            if (lateOptions.preference !== undefined) {
                applyPreference(lateOptions.preference, true);
            }
            electronSender ??= lateOptions.electronSender;
            readHostedPreference ??= lateOptions.readHostedPreference;
            loadHostedTransport ??= lateOptions.loadHostedTransport;
            localSink ??= lateOptions.localSink;
            rawWarningSink ??= lateOptions.rawWarningSink;
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            removeHostedPreferenceListeners();
            hostedTransportLoad = null;
            liveSender = dropLiveSender;
            generation = increment(generation);
        },
    };
}

export function initializeRendererFailureReporter(
    options: IRendererFailureReporterOptions = {},
) {
    if (rendererFailureReporter) {
        rendererFailureReporter.fillMissingOptions(options);
        return rendererFailureReporter;
    }
    rendererFailureReporter = createRendererFailureReporter(
        pendingRendererDiagnosticsPreference !== null && options.preference === undefined
            ? {
                ...options,
                preference: pendingRendererDiagnosticsPreference,
            }
            : options,
    );
    return rendererFailureReporter;
}

export function getRendererFailureReporter() {
    return rendererFailureReporter;
}

export function setRendererDiagnosticsPreference(preference: unknown) {
    const normalizedPreference = normalizePreference(preference);
    pendingRendererDiagnosticsPreference = normalizedPreference;
    rendererFailureReporter?.setPreference(normalizedPreference);
}

export function captureRendererFailure<C extends DiagnosticCode>(
    input: CaptureFailureInput<C>,
    options?: IRendererFailureCaptureOptions,
): FailureReceipt | undefined {
    return rendererFailureReporter?.capture(input, options);
}
