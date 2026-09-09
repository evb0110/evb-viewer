import { getErrorMessage } from '@electron/utils/error';
import {
    readdir,
    rm,
    stat,
    statfs,
} from 'node:fs/promises';
import {
    basename,
    join,
} from 'node:path';
import {parseIntegerEnv} from '@electron/utils/parseIntegerEnv';

const DEFAULT_MAX_JOB_BYTES = parseIntegerEnv('EVB_OCR_JOB_MAX_TEMP_MB', 4_096, 1, 65_536) * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = parseIntegerEnv('EVB_OCR_MIN_FREE_SPACE_MB', 512, 1, 65_536) * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = parseIntegerEnv('EVB_OCR_STORAGE_POLL_MS', 250, 50, 5_000);

interface IOcrJobStorageBudgetOptions {
    abortController: AbortController;
    checkpointDir: string;
    maxBytes?: number;
    minFreeBytes?: number;
    pollIntervalMs?: number;
    sessionId: string;
    tempDir: string;
    inspect?: () => Promise<IOcrStorageSnapshot>;
    cleanupCheckpoint?: () => Promise<void>;
}

interface IOcrStorageSnapshot {
    availableBytes: number;
    usedBytes: number;
}

export class OcrStorageBudgetError extends Error {
    readonly code: 'OCR_STORAGE_QUOTA_EXCEEDED' | 'OCR_STORAGE_RESERVE_EXHAUSTED';

    constructor(code: OcrStorageBudgetError['code'], message: string) {
        super(message);
        this.name = 'OcrStorageBudgetError';
        this.code = code;
    }
}

function isDiskCapacityError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    if ('code' in error && (error.code === 'ENOSPC' || error.code === 'EDQUOT')) {
        return true;
    }
    return 'cause' in error && isDiskCapacityError(error.cause);
}

function isMissingPathError(error: unknown) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function isDiskCapacityMessage(message: string | undefined) {
    return message !== undefined && /(?:no space left|disk (?:full|quota)|quota exceeded|enospc|edquot)/iu.test(message);
}

export function isOcrStorageFailure(error: unknown): error is Error {
    return error instanceof OcrStorageBudgetError || isDiskCapacityError(error);
}

async function directoryBytes(path: string): Promise<number> {
    const entries = await readdir(path, {withFileTypes: true}).catch((error: unknown) => {
        if (isMissingPathError(error)) {
            return [];
        }
        throw error;
    });
    let total = 0;
    for (const entry of entries) {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) {
            total += await directoryBytes(entryPath);
            continue;
        }
        if (!entry.isFile()) continue;
        const fileStat = await stat(entryPath).catch((error: unknown) => {
            if (isMissingPathError(error)) {
                return null;
            }
            throw error;
        });
        total += fileStat?.size ?? 0;
    }
    return total;
}

async function inspectJobStorage(
    tempDir: string,
    sessionId: string,
    checkpointDir: string,
): Promise<IOcrStorageSnapshot> {
    const entries = await readdir(tempDir, {withFileTypes: true});
    let usedBytes = await directoryBytes(checkpointDir);
    for (const entry of entries) {
        if (!entry.name.startsWith(`${sessionId}-`)) continue;
        const entryPath = join(tempDir, entry.name);
        if (entry.isDirectory()) {
            usedBytes += await directoryBytes(entryPath);
        } else if (entry.isFile()) {
            const fileStat = await stat(entryPath).catch((error: unknown) => {
                if (isMissingPathError(error)) {
                    return null;
                }
                throw error;
            });
            usedBytes += fileStat?.size ?? 0;
        }
    }
    const filesystem = await statfs(tempDir, {bigint: true});
    const available = filesystem.bavail * filesystem.bsize;
    return {
        availableBytes: Number(available > BigInt(Number.MAX_SAFE_INTEGER)
            ? BigInt(Number.MAX_SAFE_INTEGER)
            : available),
        usedBytes,
    };
}

export function createOcrJobStorageBudget(options: IOcrJobStorageBudgetOptions) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_JOB_BYTES;
    const minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const inspect = options.inspect ?? (() => inspectJobStorage(
        options.tempDir,
        options.sessionId,
        options.checkpointDir,
    ));
    const cleanupCheckpoint = options.cleanupCheckpoint ?? (() => rm(options.checkpointDir, {
        recursive: true,
        force: true,
    }));
    let reservedBytes = 0;
    let violation: OcrStorageBudgetError | null = null;
    let stopped = false;
    let checkInFlight: Promise<void> | null = null;
    let reservationTail = Promise.resolve();

    const fail = (error: unknown) => {
        const normalized = error instanceof OcrStorageBudgetError
            ? error
            : new OcrStorageBudgetError(
                'OCR_STORAGE_RESERVE_EXHAUSTED',
                `OCR stopped because filesystem capacity could not be verified or allocated: ${getErrorMessage(error)}`,
            );
        violation ??= normalized;
        if (!options.abortController.signal.aborted) {
            options.abortController.abort(normalized);
        }
        return normalized;
    };

    const inspectAndAssert = async (additionalBytes = 0) => {
        if (violation) throw violation;
        let snapshot: IOcrStorageSnapshot;
        try {
            snapshot = await inspect();
        } catch (error) {
            throw fail(error);
        }
        const pendingBytes = reservedBytes;
        if (snapshot.usedBytes + pendingBytes + additionalBytes > maxBytes) {
            throw fail(new OcrStorageBudgetError(
                'OCR_STORAGE_QUOTA_EXCEEDED',
                `OCR temporary output exceeded the ${maxBytes}-byte aggregate job limit`,
            ));
        }
        if (snapshot.availableBytes - pendingBytes - additionalBytes < minFreeBytes) {
            throw fail(new OcrStorageBudgetError(
                'OCR_STORAGE_RESERVE_EXHAUSTED',
                `OCR stopped to preserve ${minFreeBytes} bytes of free filesystem space`,
            ));
        }
        return snapshot;
    };

    const checkContinuously = () => {
        if (stopped || checkInFlight) {
            return;
        }
        checkInFlight = inspectAndAssert()
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
                checkInFlight = null;
            });
    };
    const interval = setInterval(checkContinuously, pollIntervalMs);
    interval.unref();

    const reserve = async (bytes: number) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            throw new Error(`Invalid OCR storage reservation: ${bytes}`);
        }
        let releasePrevious!: () => void;
        const previous = reservationTail;
        reservationTail = new Promise<void>((resolve) => {
            releasePrevious = resolve;
        });
        await previous;
        try {
            await inspectAndAssert(bytes);
            reservedBytes += bytes;
        } finally {
            releasePrevious();
        }
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            reservedBytes -= bytes;
        };
    };

    return {
        get violation() {
            return violation;
        },
        assertWithinBudget: inspectAndAssert,
        async assertFailureWithinBudget(message: string | undefined) {
            if (violation) throw violation;
            if (isDiskCapacityMessage(message)) {
                throw fail(new Error(message));
            }
            await inspectAndAssert();
        },
        fail,
        reserve,
        async withReservation<T>(bytes: number, task: () => Promise<T>) {
            const release = await reserve(bytes);
            try {
                return await task();
            } finally {
                release();
            }
        },
        async stop() {
            stopped = true;
            clearInterval(interval);
            await checkInFlight;
            if (violation) {
                await cleanupCheckpoint().catch(() => undefined);
            }
        },
        describe() {
            return {
                checkpointDir: basename(options.checkpointDir),
                maxBytes,
                minFreeBytes,
                pollIntervalMs,
            };
        },
    };
}

export type TOcrJobStorageBudget = ReturnType<typeof createOcrJobStorageBudget>;
