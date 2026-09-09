import type { DiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';
import { decodeDiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';
import { decodeDiagnosticsSuppressedCount } from '@contracts/diagnostics/diagnosticsCapability';
import { CORE_IPC_SEND_CHANNELS } from '@electron/platform-ipc/coreContract';

const RENDERER_DIAGNOSTIC_MAX_PAYLOAD_BYTES = 16 * 1024;
const RENDERER_DIAGNOSTIC_RATE_PER_SECOND = 20;
const RENDERER_DIAGNOSTIC_RATE_BURST = 40;

interface IRendererDiagnosticBridgeHealthSnapshot {
    accepted: number;
    rateDropped: number;
    schemaDropped: number;
    untrustedDropped: number;
}

export interface IRendererDiagnosticBridgeOptions {
    captureRecord: (record: DiagnosticRecord, suppressedCount: number) => unknown;
    isTrustedSender: (
        sender: Electron.WebContents,
        senderFrame: Electron.WebFrameMain | null | undefined,
        channel: string,
    ) => boolean;
    now?: () => number;
    rateBurst?: number;
    ratePerSecond?: number;
    registerListener: (
        channel: string,
        handler: (event: Electron.IpcMainEvent, payload: unknown, suppressedCount?: unknown) => void,
    ) => void;
}

interface IRateState {
    lastRefillAt: number;
    tokens: number;
}

const IPC_RENDERER_RUNTIMES = new Set<DiagnosticRecord['runtime']>([
    'browser-worker-parent',
    'electron-renderer',
]);

function increment(value: number) {
    return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getPayloadBytes(value: unknown) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function safeNow(now: () => number) {
    try {
        const value = now();
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
        return 0;
    }
}

function readSender(event: unknown): Electron.WebContents | null {
    try {
        const sender = (event as {sender?: unknown} | null)?.sender;
        return typeof sender === 'object' && sender !== null ? sender as Electron.WebContents : null;
    } catch {
        return null;
    }
}

function readSenderId(sender: Electron.WebContents): number | null {
    try {
        return typeof sender.id === 'number' && Number.isSafeInteger(sender.id) ? sender.id : null;
    } catch {
        return null;
    }
}

export function registerRendererDiagnosticBridge(options: IRendererDiagnosticBridgeOptions) {
    const now = options.now ?? Date.now;
    const ratePerSecond = normalizePositiveInteger(options.ratePerSecond, RENDERER_DIAGNOSTIC_RATE_PER_SECOND);
    const rateBurst = normalizePositiveInteger(options.rateBurst, RENDERER_DIAGNOSTIC_RATE_BURST);
    const rateBySender = new Map<number, IRateState>();
    const cleanupRegistered = new Set<number>();
    const health: IRendererDiagnosticBridgeHealthSnapshot = {
        accepted: 0,
        rateDropped: 0,
        schemaDropped: 0,
        untrustedDropped: 0,
    };

    function consumeRateToken(senderId: number) {
        const currentTime = safeNow(now);
        const state = rateBySender.get(senderId) ?? {
            lastRefillAt: currentTime,
            tokens: rateBurst,
        };
        const elapsedMs = Math.max(0, currentTime - state.lastRefillAt);
        state.tokens = Math.min(rateBurst, state.tokens + elapsedMs / 1_000 * ratePerSecond);
        state.lastRefillAt = currentTime;
        if (state.tokens < 1) {
            rateBySender.set(senderId, state);
            return false;
        }
        state.tokens -= 1;
        rateBySender.set(senderId, state);
        return true;
    }

    function registerCleanup(sender: Electron.WebContents) {
        const senderId = readSenderId(sender);
        if (senderId === null || cleanupRegistered.has(senderId)) {
            return;
        }
        cleanupRegistered.add(senderId);
        const cleanup = () => {
            rateBySender.delete(senderId);
            cleanupRegistered.delete(senderId);
            try {
                sender.removeListener('destroyed', cleanup);
                sender.removeListener('render-process-gone', cleanup);
            } catch {
                // Sender teardown is best effort only.
            }
        };
        try {
            sender.once('destroyed', cleanup);
            sender.once('render-process-gone', cleanup);
        } catch {
            cleanup();
        }
    }

    function handle(event: Electron.IpcMainEvent, payload: unknown, suppressedCount?: unknown) {
        try {
            const sender = readSender(event);
            const senderId = sender === null ? null : readSenderId(sender);
            if (sender === null || senderId === null) {
                health.untrustedDropped = increment(health.untrustedDropped);
                return;
            }
            let trusted = false;
            try {
                trusted = options.isTrustedSender(
                    sender,
                    event.senderFrame,
                    CORE_IPC_SEND_CHANNELS.rendererDiagnostic,
                );
            } catch {
                trusted = false;
            }
            if (!trusted) {
                health.untrustedDropped = increment(health.untrustedDropped);
                return;
            }
            registerCleanup(sender);
            if (!consumeRateToken(senderId)) {
                health.rateDropped = increment(health.rateDropped);
                return;
            }
            if (getPayloadBytes(payload) > RENDERER_DIAGNOSTIC_MAX_PAYLOAD_BYTES) {
                health.schemaDropped = increment(health.schemaDropped);
                return;
            }
            const record = decodeDiagnosticRecord(payload);
            const decodedSuppressedCount = decodeDiagnosticsSuppressedCount(suppressedCount);
            if (
                record === null
                || !IPC_RENDERER_RUNTIMES.has(record.runtime)
                || decodedSuppressedCount === null
            ) {
                health.schemaDropped = increment(health.schemaDropped);
                return;
            }
            if (options.captureRecord(record, decodedSuppressedCount) !== false) {
                health.accepted = increment(health.accepted);
            }
        } catch {
            // The bridge never lets reporting disturb the renderer sender.
        }
    }

    options.registerListener(
        CORE_IPC_SEND_CHANNELS.rendererDiagnostic,
        handle,
    );

    return {getHealthSnapshot: (): IRendererDiagnosticBridgeHealthSnapshot => Object.freeze({...health})};
}
