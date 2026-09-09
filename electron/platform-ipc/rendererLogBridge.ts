import { getErrorMessage } from '@electron/utils/error';
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
import { createLogger } from '@electron/utils/createLogger';
import { redactElectronLogText } from '@electron/utils/redactElectronLogText';

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

interface IRendererLogSerializeState {
    remainingNodes: number;
    seen: WeakSet<object>;
}

const RENDERER_LOG_NOT_PRIMITIVE = Symbol('renderer-log-not-primitive');

function normalizeRendererLogPrimitive(value: unknown) {
    if (value === null || value === undefined) {
        return null;
    }

    const valueType = typeof value;
    if (valueType === 'string') {
        return clampString(value, RENDERER_LOG_MAX_DATA_CHARS);
    }
    if (valueType === 'number' || valueType === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return `${value.toString()}n`;
    }
    if (typeof value === 'symbol') {
        return value.toString();
    }
    if (typeof value === 'function') {
        const functionName = value.name;
        return `[Function ${functionName || 'anonymous'}]`;
    }

    return RENDERER_LOG_NOT_PRIMITIVE;
}

function normalizeRendererLogSpecialObject(value: object, depth: number) {
    if (Array.isArray(value) && depth >= 1) {
        return `[Array(${value.length})]`;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof RegExp) {
        return String(value);
    }
    if (value instanceof Error) {
        const normalizedError: Record<string, unknown> = {
            name: value.name,
            message: getErrorMessage(value),
        };
        if (depth === 0) {
            normalizedError.stack = clampString(value.stack, RENDERER_LOG_MAX_MESSAGE_CHARS);
        }
        return normalizedError;
    }
    if (ArrayBuffer.isView(value)) {
        const typedArray = value;
        return `[${typedArray.constructor.name}(${typedArray.byteLength})]`;
    }
    if (value instanceof ArrayBuffer) {
        return `[ArrayBuffer(${value.byteLength})]`;
    }

    return undefined;
}

function normalizeRendererLogArray(
    value: unknown[],
    depth: number,
    state: IRendererLogSerializeState,
) {
    const normalizedItems = value
        .slice(0, RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS)
        .map(item => normalizeRendererLogData(item, depth + 1, state));
    if (value.length > RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS) {
        normalizedItems.push(`[+${value.length - RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS} more items]`);
    }
    return normalizedItems;
}

function normalizeRendererLogPlainObject(
    value: Record<PropertyKey, unknown>,
    depth: number,
    state: IRendererLogSerializeState,
) {
    const normalizedObject: Record<string, unknown> = {};
    const entries = Object.entries(value);
    const maxKeys = Math.min(entries.length, RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS);
    for (let index = 0; index < maxKeys; index += 1) {
        const entry = entries[index];
        if (!entry) {
            continue;
        }
        const [
            key,
            itemValue,
        ] = entry;
        normalizedObject[key] = normalizeRendererLogData(itemValue, depth + 1, state);
    }
    if (entries.length > RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS) {
        normalizedObject.__truncatedKeys = entries.length - RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS;
    }
    return normalizedObject;
}

function normalizeRendererLogData(
    value: unknown,
    depth: number,
    state: IRendererLogSerializeState,
): unknown {
    if (state.remainingNodes <= 0) {
        return '[Truncated]';
    }

    const normalizedPrimitive = normalizeRendererLogPrimitive(value);
    if (normalizedPrimitive !== RENDERER_LOG_NOT_PRIMITIVE) {
        return normalizedPrimitive;
    }

    if (value === null || typeof value !== 'object') {
        return String(value);
    }

    const normalizedSpecialObject = normalizeRendererLogSpecialObject(value, depth);
    if (normalizedSpecialObject !== undefined) {
        return normalizedSpecialObject;
    }
    if (depth >= 1) {
        return '[Object]';
    }

    if (state.seen.has(value)) {
        return '[Circular]';
    }
    state.seen.add(value);
    state.remainingNodes -= 1;

    try {
        if (Array.isArray(value)) {
            return normalizeRendererLogArray(value, depth, state);
        }

        return isRecord(value)
            ? normalizeRendererLogPlainObject(value, depth, state)
            : '[Object]';
    } finally {
        state.seen.delete(value);
    }
}

function stringifyRendererLogData(data: unknown) {
    if (data === undefined) {
        return '';
    }

    let serialized: string;
    try {
        const normalized = normalizeRendererLogData(data, 0, {
            remainingNodes: RENDERER_LOG_SERIALIZE_MAX_NODES,
            seen: new WeakSet<object>(),
        });
        serialized = JSON.stringify(normalized);
    } catch {
        serialized = clampString(
            typeof data === 'object' && data !== null
                ? '[unserializable object]'
                : stringifyJson(data) ?? '<unserializable value>',
            RENDERER_LOG_MAX_DATA_CHARS,
        );
    }

    if (!serialized) {
        serialized = '';
    }
    serialized = redactElectronLogText(serialized);

    if (serialized.length > RENDERER_LOG_MAX_DATA_CHARS) {
        const originalLength = serialized.length;
        serialized = `${serialized.slice(0, RENDERER_LOG_MAX_DATA_CHARS)}…(truncated ${originalLength - RENDERER_LOG_MAX_DATA_CHARS} chars)`;
    }
    return ` data=${serialized}`;
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
            rendererLogger.warn(
                `[renderer:${webContentsId}] Dropped ${state.droppedLogs} renderer log message(s) due to rate limiting`,
            );
            state.droppedLogs = 0;
            state.lastDropNoticeAt = now;
        }
        rendererLogRateStateBySender.set(webContentsId, state);
        return true;
    }

    state.droppedLogs += 1;
    if (now - state.lastDropNoticeAt >= RENDERER_LOG_DROP_NOTICE_INTERVAL_MS) {
        rendererLogger.warn(
            `[renderer:${webContentsId}] Renderer log channel is rate-limited (limit ${RENDERER_LOG_RATE_LIMIT_PER_SECOND}/s, burst ${RENDERER_LOG_RATE_LIMIT_BURST})`,
        );
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
    const cleanup = () => {
        rendererLogRateStateBySender.delete(senderId);
        rendererLogCleanupRegisteredBySender.delete(senderId);
        sender.removeListener('destroyed', cleanup);
        sender.removeListener('render-process-gone', cleanup);
    };
    sender.once('destroyed', cleanup);
    sender.once('render-process-gone', cleanup);
}

interface INormalizedRendererLogEntry {
    level: TRendererLogLevel;
    section: string;
    message: string;
    timestamp: string;
    serializedData: string;
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
    return {
        level: normalizeRendererLogLevel(readRendererLogField(payload, 'level')),
        section: normalizeRendererLogSection(readRendererLogField(payload, 'section')),
        message: normalizeRendererLogMessage(readRendererLogField(payload, 'message')),
        timestamp: normalizeRendererLogTimestamp(readRendererLogField(payload, 'timestamp')),
        serializedData: stringifyRendererLogData(readRendererLogField(payload, 'data')),
        ...(failureRef ? {failureRef} : {}),
    };
}

function formatRendererLogLine(webContentsId: number, entry: INormalizedRendererLogEntry) {
    return `[renderer:${webContentsId}] [${entry.timestamp}] [${entry.section}] ${entry.message}`
        + entry.serializedData;
}

function dispatchRendererLogLine(entry: INormalizedRendererLogEntry, line: string) {
    const {level} = entry;
    if (level === 'debug') {
        rendererLogger.debug(line);
        return;
    }
    if (level === 'warn') {
        rendererLogger.warn(line);
        return;
    }
    if (level === 'error') {
        rendererLogger.error(
            line,
            entry.failureRef ?? {
                code: 'MAIN_RENDERER_LOG_BRIDGE_FAILED',
                context: {},
            },
        );
        return;
    }
    rendererLogger.info(line);
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

        const entry = normalizeRendererLogEntry(payload);
        dispatchRendererLogLine(entry, formatRendererLogLine(webContentsId, entry));
    }

    registerListener(CORE_IPC_SEND_CHANNELS.rendererLog, handleRendererLog);
}
