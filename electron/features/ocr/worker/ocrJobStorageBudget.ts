import { getErrorMessage } from '@electron/utils/error';
import {
    opendir,
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
const CHECKPOINT_RECONCILIATION_BATCH_SIZE = 64;

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

export interface IOcrStorageReservation {
    readonly bytes: number;
    release: () => void;
}

interface IOcrCommittedCheckpointFile {
    path: string;
    bytes: number;
}

interface ICheckpointDirectoryCursor {
    epoch: number;
    stack: Array<{
        directory: TCheckpointDirectory;
        path: string;
    }>;
}

type TCheckpointDirectory = Awaited<ReturnType<typeof opendir>>;

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

export function isOcrStorageFailure(error: unknown): error is Error {
    return error instanceof OcrStorageBudgetError || isDiskCapacityError(error);
}

async function inspectLiveJobStorage(
    tempDir: string,
    sessionId: string,
): Promise<IOcrStorageSnapshot> {
    const entries = await readdir(tempDir, {withFileTypes: true});
    let usedBytes = 0;
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
    const inspect = options.inspect ?? (() => inspectLiveJobStorage(
        options.tempDir,
        options.sessionId,
    ));
    const cleanupCheckpoint = options.cleanupCheckpoint ?? (() => rm(options.checkpointDir, {
        recursive: true,
        force: true,
    }));
    let reservedBytes = 0;
    let committedBytes = 0;
    let violation: OcrStorageBudgetError | null = null;
    let stopped = false;
    let checkInFlight: Promise<void> | null = null;
    let reservationTail = Promise.resolve();
    let initialized = false;
    let reconciliationEpoch = 0;
    let reconciliationCursor: ICheckpointDirectoryCursor | null = null;
    let reconciliationStepInFlight: Promise<boolean> | null = null;
    const committedCheckpointFiles = new Map<string, {
        bytes: number;
        epoch: number;
    }>();

    const closeReconciliationCursor = async () => {
        const cursor = reconciliationCursor;
        reconciliationCursor = null;
        if (!cursor) {
            return;
        }
        await Promise.all(cursor.stack.map(({directory}) => directory.close().catch(() => undefined)));
    };

    const finishReconciliation = async (cursor: ICheckpointDirectoryCursor) => {
        for (const [
            filePath,
            file,
        ] of committedCheckpointFiles) {
            if (file.epoch !== cursor.epoch) {
                committedCheckpointFiles.delete(filePath);
                committedBytes -= file.bytes;
            }
        }
        initialized = true;
        await closeReconciliationCursor();
    };

    const reconcileCheckpointBatch = async (): Promise<boolean> => {
        if (reconciliationStepInFlight) {
            return reconciliationStepInFlight;
        }
        reconciliationStepInFlight = (async () => {
            if (!reconciliationCursor) {
                const directory = await opendir(options.checkpointDir).catch((error: unknown) => {
                    if (isMissingPathError(error)) {
                        committedCheckpointFiles.clear();
                        committedBytes = 0;
                        initialized = true;
                        return null;
                    }
                    throw error;
                });
                if (!directory) {
                    return true;
                }
                reconciliationCursor = {
                    epoch: reconciliationEpoch += 1,
                    stack: [{
                        directory,
                        path: options.checkpointDir,
                    }],
                };
            }

            const cursor = reconciliationCursor;
            if (!cursor) {
                return true;
            }
            let operations = 0;
            while (operations < CHECKPOINT_RECONCILIATION_BATCH_SIZE) {
                const current = cursor.stack.at(-1);
                if (!current) {
                    await finishReconciliation(cursor);
                    return true;
                }
                let entry;
                try {
                    entry = await current.directory.read();
                } catch (error) {
                    if (!isMissingPathError(error)) {
                        throw error;
                    }
                    entry = null;
                }
                operations++;
                if (!entry) {
                    await current.directory.close().catch(() => undefined);
                    cursor.stack.pop();
                    continue;
                }

                const entryPath = join(current.path, entry.name);
                if (entry.isDirectory()) {
                    const directory = await opendir(entryPath).catch((error: unknown) => {
                        if (isMissingPathError(error)) {
                            return null;
                        }
                        throw error;
                    });
                    if (directory) {
                        cursor.stack.push({
                            directory,
                            path: entryPath,
                        });
                    }
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }

                const fileStat = await stat(entryPath).catch((error: unknown) => {
                    if (isMissingPathError(error)) {
                        return null;
                    }
                    throw error;
                });
                if (!fileStat?.isFile()) {
                    const previous = committedCheckpointFiles.get(entryPath);
                    if (previous) {
                        committedCheckpointFiles.delete(entryPath);
                        committedBytes -= previous.bytes;
                    }
                    continue;
                }
                const previous = committedCheckpointFiles.get(entryPath);
                committedBytes += fileStat.size - (previous?.bytes ?? 0);
                committedCheckpointFiles.set(entryPath, {
                    bytes: fileStat.size,
                    epoch: cursor.epoch,
                });
            }
            return false;
        })().finally(() => {
            reconciliationStepInFlight = null;
        });
        return reconciliationStepInFlight;
    };

    const reconcileAllCheckpoints = async () => {
        let complete = false;
        while (!complete) {
            complete = await reconcileCheckpointBatch();
        }
    };

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
        if (!initialized) {
            try {
                await reconcileAllCheckpoints();
            } catch (error) {
                throw fail(error);
            }
        }
        let snapshot: IOcrStorageSnapshot;
        try {
            snapshot = await inspect();
        } catch (error) {
            throw fail(error);
        }
        const pendingBytes = reservedBytes;
        if (committedBytes + snapshot.usedBytes + pendingBytes + additionalBytes > maxBytes) {
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
        checkInFlight = (async () => {
            try {
                await reconcileCheckpointBatch();
                await inspectAndAssert();
            } catch (error) {
                fail(error);
            }
        })()
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
        const release = () => {
            if (released) {
                return;
            }
            released = true;
            reservedBytes -= bytes;
        };
        return {
            bytes,
            release,
        };
    };

    return {
        get violation() {
            return violation;
        },
        assertWithinBudget: inspectAndAssert,
        async reconcileCheckpoints() {
            if (violation) throw violation;
            try {
                await reconcileAllCheckpoints();
                await inspectAndAssert();
            } catch (error) {
                throw error instanceof OcrStorageBudgetError ? error : fail(error);
            }
        },
        commitCheckpoint(
            reservations: readonly IOcrStorageReservation[],
            checkpointFiles: readonly IOcrCommittedCheckpointFile[],
        ) {
            const bytes = checkpointFiles.reduce((total, file) => total + file.bytes, 0);
            if (!Number.isSafeInteger(bytes) || checkpointFiles.some(file => file.bytes < 0)) {
                throw new Error(`Invalid OCR committed checkpoint size: ${bytes}`);
            }
            if (new Set(checkpointFiles.map(file => file.path)).size !== checkpointFiles.length) {
                throw new Error('OCR checkpoint publication repeated a file');
            }
            if (reservations.length === 0) {
                throw new Error('OCR checkpoint publication requires a storage reservation');
            }
            if (new Set(reservations).size !== reservations.length) {
                throw new Error('OCR checkpoint publication repeated a storage reservation');
            }
            const reservedBytesForCheckpoint = reservations.reduce((total, reservation) => total + reservation.bytes, 0);
            if (bytes > reservedBytesForCheckpoint) {
                throw new Error(`OCR checkpoint bytes exceed reservations: ${bytes} > ${reservedBytesForCheckpoint}`);
            }
            for (const file of checkpointFiles) {
                const previous = committedCheckpointFiles.get(file.path);
                committedBytes += file.bytes - (previous?.bytes ?? 0);
                committedCheckpointFiles.set(file.path, {
                    bytes: file.bytes,
                    epoch: reconciliationCursor?.epoch ?? 0,
                });
            }
            reservations.forEach(reservation => reservation.release());
        },
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
                release.release();
            }
        },
        async stop() {
            stopped = true;
            clearInterval(interval);
            await checkInFlight;
            await reconciliationStepInFlight;
            await closeReconciliationCursor();
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
