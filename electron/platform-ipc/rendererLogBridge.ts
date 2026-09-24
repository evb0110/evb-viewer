import { clamp } from 'es-toolkit/math';
import type {
    IRendererLogEntry,
    TRendererLogLevel,
} from '@contracts/electronApiCommon';
import {
    decodeFailureReceipt,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import { isRecord } from '@contracts/runtimeGuards';
import {stringifyJson} from '@contracts/stringifyJson';
import { CORE_IPC_SEND_CHANNELS } from '@electron/platform-ipc/coreContract';
import {
    createLogger,
    redactLogData,
    writeLogRecord,
} from '@electron/utils/createLogger';
import {
    DEFAULT_LOG_DATA_LIMITS,
    toLogData,
    type ILogDataLimits,
    type TLogData,
} from '@contracts/logRecord';
import { redactElectronLogText } from '@electron/utils/redactElectronLogText';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';

interface IRendererLogRateState {
    tokens: number;
    lastRefillAt: number;
    droppedLogs: number;
    lastDropNoticeAt: number;
}

const rendererLogger = createLogger('renderer-bridge', {broadcastToRenderers: false});
const RENDERER_LOG_MAX_SECTION_CHARS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_MAX_SECTION_CHARS ?? '128', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 128;
    }
    return Math.min(parsed, 512);
})();
const RENDERER_LOG_MAX_MESSAGE_CHARS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_MAX_MESSAGE_CHARS ?? '2000', 10);
    if (!Number.isFinite(parsed) || parsed < 128) {
        return 2_000;
    }
    return Math.min(parsed, 16_000);
})();
const RENDERER_LOG_MAX_DATA_CHARS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_MAX_DATA_CHARS ?? '8000', 10);
    if (!Number.isFinite(parsed) || parsed < 256) {
        return 8_000;
    }
    return Math.min(parsed, 64_000);
})();
const RENDERER_LOG_SERIALIZE_MAX_NODES = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_SERIALIZE_MAX_NODES ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 256;
    }
    return Math.min(parsed, 8_192);
})();
const RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 4) {
        return 16;
    }
    return Math.min(parsed, 1_024);
})();
const RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 4) {
        return 16;
    }
    return Math.min(parsed, 2_048);
})();
const RENDERER_LOG_RATE_LIMIT_PER_SECOND = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_RATE_LIMIT_PER_SECOND ?? '60', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 60;
    }
    return Math.min(parsed, 5_000);
})();
const RENDERER_LOG_RATE_LIMIT_BURST = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_RATE_LIMIT_BURST ?? '120', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 120;
    }
    return Math.min(parsed, 10_000);
})();
const RENDERER_LOG_DROP_NOTICE_INTERVAL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_DROP_NOTICE_INTERVAL_MS ?? '5000', 10);
    if (!Number.isFinite(parsed) || parsed < 250) {
        return 5_000;
    }
    return parsed;
})();
const rendererLogRateStateBySender = new Map<number, IRendererLogRateState>();
const rendererLogCleanupRegisteredBySender = new Set<number>();
function clampString(value: unknown, maxChars: number, fallback = '') {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = redactElectronLogText(value).trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}…`;
}

const RENDERER_LOG_DATA_LIMITS: ILogDataLimits = {
    ...DEFAULT_LOG_DATA_LIMITS,
    maxNodes: RENDERER_LOG_SERIALIZE_MAX_NODES,
    maxArrayItems: RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS,
    maxObjectKeys: RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS,
};

function normalizeRendererLogData(data: unknown): TLogData | undefined {
    // The renderer is untrusted input: bound and redact at this boundary.
    const normalized = redactLogData(toLogData(data, RENDERER_LOG_DATA_LIMITS));
    if (!normalized) {
        return undefined;
    }
    const serialized = stringifyJson(normalized) ?? '';
    if (serialized.length <= RENDERER_LOG_MAX_DATA_CHARS) {
        return normalized;
    }
    return {
        truncated: `${serialized.slice(0, RENDERER_LOG_MAX_DATA_CHARS)}…`,
        originalChars: serialized.length,
    };
}

function consumeRendererLogRateToken(webContentsId: number) {
    const now = Date.now();
    const existingState = rendererLogRateStateBySender.get(webContentsId);
    const state: IRendererLogRateState = existingState ?? {
        tokens: RENDERER_LOG_RATE_LIMIT_BURST,
        lastRefillAt: now,
        droppedLogs: 0,
        lastDropNoticeAt: 0,
    };

    const elapsedMs = clamp(now - state.lastRefillAt, 0, Number.POSITIVE_INFINITY);
    const refill = (elapsedMs / 1_000) * RENDERER_LOG_RATE_LIMIT_PER_SECOND;
    state.tokens = clamp(state.tokens + refill, 0, RENDERER_LOG_RATE_LIMIT_BURST);
    state.lastRefillAt = now;

    if (state.tokens >= 1) {
        state.tokens -= 1;
        if (state.droppedLogs > 0 && now - state.lastDropNoticeAt >= RENDERER_LOG_DROP_NOTICE_INTERVAL_MS) {
            rendererLogger.warn('Dropped renderer log records due to rate limiting', {
                window: webContentsId,
                dropped: state.droppedLogs,
            });
            state.droppedLogs = 0;
            state.lastDropNoticeAt = now;
        }
        rendererLogRateStateBySender.set(webContentsId, state);
        return true;
    }

    state.droppedLogs += 1;
    if (now - state.lastDropNoticeAt >= RENDERER_LOG_DROP_NOTICE_INTERVAL_MS) {
        rendererLogger.warn('Renderer log channel is rate-limited', {
            window: webContentsId,
            limitPerSecond: RENDERER_LOG_RATE_LIMIT_PER_SECOND,
            burst: RENDERER_LOG_RATE_LIMIT_BURST,
        });
        state.lastDropNoticeAt = now;
    }
    rendererLogRateStateBySender.set(webContentsId, state);
    return false;
}

function registerRendererLogSenderCleanup(sender: Electron.WebContents) {
    const senderId = sender.id;
    if (rendererLogCleanupRegisteredBySender.has(senderId)) {
        return;
    }

    rendererLogCleanupRegisteredBySender.add(senderId);
    const stop = onSenderLifetimeEnd(sender, () => {
        stop();
        rendererLogRateStateBySender.delete(senderId);
        rendererLogCleanupRegisteredBySender.delete(senderId);
    });
}

interface INormalizedRendererLogEntry {
    level: TRendererLogLevel;
    section: string;
    message: string;
    timestamp: string;
    data?: TLogData;
    failureRef?: FailureReceipt;
}

const RENDERER_LOG_TIMESTAMP_MAX_CHARS = 128;
const RENDERER_LOG_LEVELS = [
    'debug',
    'info',
    'warn',
    'error',
] as const satisfies readonly TRendererLogLevel[];

function readRendererLogField(payload: unknown, key: string) {
    if (!isRecord(payload)) {
        return undefined;
    }
    return payload[key];
}

function isRendererLogLevel(value: unknown): value is TRendererLogLevel {
    return typeof value === 'string'
        && (RENDERER_LOG_LEVELS as readonly string[]).includes(value);
}

function normalizeRendererLogLevel(value: unknown): TRendererLogLevel {
    return isRendererLogLevel(value) ? value : 'info';
}

function normalizeRendererLogSection(value: unknown) {
    return clampString(value, RENDERER_LOG_MAX_SECTION_CHARS, 'unknown');
}

function normalizeRendererLogMessage(value: unknown) {
    return clampString(value, RENDERER_LOG_MAX_MESSAGE_CHARS, '<empty>');
}

function normalizeRendererLogTimestamp(value: unknown) {
    return clampString(value, RENDERER_LOG_TIMESTAMP_MAX_CHARS, new Date().toISOString());
}

export function normalizeRendererLogEntry(payload: unknown): INormalizedRendererLogEntry {
    const failureRef = decodeFailureReceipt(readRendererLogField(payload, 'failureRef'));
    const data = normalizeRendererLogData(readRendererLogField(payload, 'data'));
    return {
        level: normalizeRendererLogLevel(readRendererLogField(payload, 'level')),
        section: normalizeRendererLogSection(readRendererLogField(payload, 'section')),
        message: normalizeRendererLogMessage(readRendererLogField(payload, 'message')),
        timestamp: normalizeRendererLogTimestamp(readRendererLogField(payload, 'timestamp')),
        ...(data ? {data} : {}),
        ...(failureRef ? {failureRef} : {}),
    };
}

/**
 * Writes a renderer record into the shared app log as `proc: 'renderer'`.
 * It stays out of the stdout mirror because the dev launcher already reads the
 * renderer console over CDP; printing both would duplicate every line.
 */
function dispatchRendererLogRecord(webContentsId: number, entry: INormalizedRendererLogEntry) {
    let failureRef = entry.failureRef;
    if (entry.level === 'error' && !failureRef) {
        failureRef = rendererLogger.error(
            'Renderer error record arrived without a failure receipt',
            {code: 'MAIN_RENDERER_LOG_BRIDGE_FAILED'},
            {
                section: entry.section,
                window: webContentsId,
            },
        );
    }
    writeLogRecord({
        ts: entry.timestamp,
        level: entry.level,
        proc: 'renderer',
        scope: entry.section,
        msg: entry.message,
        data: entry.data,
        window: webContentsId,
        ...(failureRef ? {
            errorId: failureRef.eventId,
            code: failureRef.code,
        } : {}),
    }, {stdout: false});
}

export interface IRendererLogBridgeOptions {
    isTrustedSender: (
        sender: Electron.WebContents,
        senderFrame: Electron.WebFrameMain | null | undefined,
        channel: string,
    ) => boolean;
    registerListener: (
        channel: string,
        handler: (event: Electron.IpcMainEvent, payload: IRendererLogEntry) => void,
    ) => void;
}

export function registerRendererLogBridge(options: IRendererLogBridgeOptions) {
    const {
        isTrustedSender,
        registerListener,
    } = options;

    function handleRendererLog(event: Electron.IpcMainEvent, payload: IRendererLogEntry) {
        const webContentsId = event.sender.id;
        if (!isTrustedSender(event.sender, event.senderFrame, CORE_IPC_SEND_CHANNELS.rendererLog)) {
            return;
        }
        registerRendererLogSenderCleanup(event.sender);
        if (!consumeRendererLogRateToken(webContentsId)) {
            return;
        }

        dispatchRendererLogRecord(webContentsId, normalizeRendererLogEntry(payload));
    }

    registerListener(CORE_IPC_SEND_CHANNELS.rendererLog, handleRendererLog);
}
