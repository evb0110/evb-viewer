import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import {dirname} from 'node:path';
import {
    open,
    rm,
    statfs,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import {
    captureWorkingCopyAdmissionSnapshot,
    createOriginalFileExpectationFromStat,
    getWorkingCopyBackingEntry,
    normalizePathForLookup,
    runWithWorkingCopyRegistrationFence,
    transitionWorkingCopyBackingState,
    workingCopyAdmissionSnapshotsMatch,
    type IWorkingCopyAdmissionSnapshot,
    type IWorkingCopyOriginalEntry,
    type IWorkingCopyOriginalFileExpectation,
    type TWorkingCopyBackingErrorCode,
} from '@electron/file-access/workingCopyStore';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import { mainJobBroker } from '@electron/resources/jobBroker';
import { atomicReplace } from '@electron/utils/atomicReplace';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const MATERIALIZATION_CHUNK_BYTES = 1024 * 1024;
const logger = createLogger('working-copy-materialization');

export type TWorkingCopyMaterializationReason =
    | 'background'
    | 'first-mutation'
    | 'save'
    | 'serialized-persistence'
    | 'native-mutation'
    | 'page-operation'
    | 'ocr-persist'
    | 'scan-cleanup'
    | 'print-external'
    | 'checkpoint-recovery';

export type TWorkingCopyMaterializationErrorCode = TWorkingCopyBackingErrorCode;

export interface IWorkingCopyMaterializationProgress {
    bytesCopied: number;
    documentRef: string;
    errorCode?: TWorkingCopyMaterializationErrorCode;
    operationId: string;
    percent: number;
    phase: 'checking-source' | 'copying' | 'finalizing';
    reason: TWorkingCopyMaterializationReason;
    status: 'running' | 'completed' | 'cancelled' | 'failed';
    totalBytes: number;
}

export interface IEnsureWorkingCopyMaterializedOptions {
    ownerWebContentsId?: number;
    reason: Exclude<TWorkingCopyMaterializationReason, 'background'>;
    signal?: AbortSignal;
}

interface IWorkingCopyMaterializationResult {
    logicalRef: string;
    physicalWorkingCopyPath: string;
    sourceFingerprint: string;
}

export class WorkingCopyMaterializationError extends Error {
    readonly code: TWorkingCopyMaterializationErrorCode;
    readonly retryable: boolean;

    constructor(
        code: TWorkingCopyMaterializationErrorCode,
        message: string,
        options: {
            cause?: unknown;
            retryable?: boolean;
        } = {},
    ) {
        super(message, options.cause === undefined ? undefined : {cause: options.cause});
        this.name = 'WorkingCopyMaterializationError';
        this.code = code;
        this.retryable = options.retryable ?? false;
    }
}

interface IMaterializationFlight {
    admissionSnapshot: IWorkingCopyAdmissionSnapshot;
    backgroundLease: boolean;
    bytesCopied: number;
    controller: AbortController;
    demandWaiters: number;
    key: string;
    logicalRef: string;
    operationId: string;
    originalPath: string;
    percent: number;
    promise: Promise<IWorkingCopyMaterializationResult>;
    reason: TWorkingCopyMaterializationReason;
    registrationId: number;
    totalBytes: number;
}

type TBackingSwapCacheInvalidator = (
    logicalRef: string,
    previousPhysicalPath: string,
) => Promise<void> | void;

const flights = new Map<string, IMaterializationFlight>();
const progressListeners = new Set<(progress: IWorkingCopyMaterializationProgress) => void>();
const backingSwapCacheInvalidators = new Set<TBackingSwapCacheInvalidator>();

function createFlightKey(logicalRef: string, registrationId: number) {
    return `${normalizePathForLookup(logicalRef) || logicalRef}\0${registrationId}`;
}

function throwIfAborted(signal: AbortSignal) {
    if (!signal.aborted) {
        return;
    }
    throw new WorkingCopyMaterializationError(
        'WORKING_COPY_MATERIALIZATION_CANCELLED',
        'Working-copy materialization was cancelled',
        {
            cause: signal.reason,
            retryable: true,
        },
    );
}

function isSourceUnavailableError(error: unknown) {
    if (!isErrnoException(error)) {
        return false;
    }
    return error.code === 'ENOENT'
        || error.code === 'ENODEV'
        || error.code === 'ENXIO'
        || error.code === 'EACCES'
        || error.code === 'EPERM';
}

function normalizeMaterializationError(error: unknown) {
    if (error instanceof WorkingCopyMaterializationError) {
        return error;
    }
    if (isErrnoException(error) && error.code === 'ENOSPC') {
        return new WorkingCopyMaterializationError(
            'WORKING_COPY_MATERIALIZATION_NO_SPACE',
            'Not enough disk space to prepare the working copy',
            {
                cause: error,
                retryable: true,
            },
        );
    }
    if (isSourceUnavailableError(error)) {
        return new WorkingCopyMaterializationError(
            'SOURCE_BACKING_UNAVAILABLE',
            'The original document is unavailable',
            {cause: error},
        );
    }
    return new WorkingCopyMaterializationError(
        'WORKING_COPY_MATERIALIZATION_FAILED',
        'Failed to prepare the working copy',
        {
            cause: error,
            retryable: true,
        },
    );
}

function emitProgress(
    flight: IMaterializationFlight,
    progress: Omit<IWorkingCopyMaterializationProgress, 'documentRef' | 'operationId' | 'reason' | 'totalBytes'>,
) {
    flight.bytesCopied = Math.max(flight.bytesCopied, progress.bytesCopied);
    flight.percent = Math.max(flight.percent, progress.percent);
    const event: IWorkingCopyMaterializationProgress = {
        ...progress,
        bytesCopied: flight.bytesCopied,
        documentRef: flight.logicalRef,
        operationId: flight.operationId,
        percent: flight.percent,
        reason: flight.reason,
        totalBytes: flight.totalBytes,
    };
    for (const listener of progressListeners) {
        try {
            listener(event);
        } catch (error) {
            logger.debug(`Working-copy materialization progress listener failed: ${getErrorMessage(error)}`);
        }
    }
}

function progressPercent(bytesCopied: number, totalBytes: number) {
    if (totalBytes === 0) {
        return 100;
    }
    return Math.min(100, Math.floor((bytesCopied / totalBytes) * 100));
}

function yieldBetweenChunks() {
    return new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

async function assertSourceSnapshot(
    originalPath: string,
    admissionSnapshot: IWorkingCopyAdmissionSnapshot,
) {
    let currentSnapshot: IWorkingCopyAdmissionSnapshot;
    try {
        currentSnapshot = await captureWorkingCopyAdmissionSnapshot(originalPath);
    } catch (error) {
        throw new WorkingCopyMaterializationError(
            'SOURCE_BACKING_UNAVAILABLE',
            'The original document is unavailable',
            {cause: error},
        );
    }
    if (!workingCopyAdmissionSnapshotsMatch(currentSnapshot, admissionSnapshot)) {
        throw new WorkingCopyMaterializationError(
            'SOURCE_BACKING_CHANGED',
            'The original document changed after it was opened',
        );
    }
}

async function assertSourceHandleSnapshot(
    sourceHandle: FileHandle,
    admissionSnapshot: IWorkingCopyAdmissionSnapshot,
) {
    let sourceStat: Awaited<ReturnType<FileHandle['stat']>>;
    try {
        sourceStat = await sourceHandle.stat({bigint: true});
    } catch (error) {
        throw new WorkingCopyMaterializationError(
            'SOURCE_BACKING_UNAVAILABLE',
            'The original document is unavailable',
            {cause: error},
        );
    }
    if (
        !sourceStat.isFile()
        || sourceStat.size !== admissionSnapshot.size
        || sourceStat.mtimeNs !== admissionSnapshot.mtimeNs
    ) {
        throw new WorkingCopyMaterializationError(
            'SOURCE_BACKING_CHANGED',
            'The original document changed after it was opened',
        );
    }
}

async function writeAll(
    outputHandle: FileHandle,
    buffer: Buffer,
    length: number,
    position: number,
) {
    let written = 0;
    while (written < length) {
        const result = await outputHandle.write(
            buffer,
            written,
            length - written,
            position + written,
        );
        if (result.bytesWritten < 1) {
            throw new Error('Working-copy materialization write made no progress');
        }
        written += result.bytesWritten;
    }
}

async function hashMaterializedTarget(
    targetPath: string,
    size: number,
    signal: AbortSignal,
) {
    const hash = createOriginalFileContentFingerprintHash(size);
    const handle = await open(targetPath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(Math.min(MATERIALIZATION_CHUNK_BYTES, Math.max(size, 1)));
        let offset = 0;
        while (offset < size) {
            throwIfAborted(signal);
            const length = Math.min(buffer.byteLength, size - offset);
            const result = await handle.read(buffer, 0, length, offset);
            if (result.bytesRead !== length) {
                throw new WorkingCopyMaterializationError(
                    'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
                    'Materialized working copy has an unexpected byte count',
                    {retryable: true},
                );
            }
            hash.update(buffer.subarray(0, length));
            offset += length;
            if (offset < size) {
                await yieldBetweenChunks();
            }
        }
        return `sha256-full-v1:${hash.digest('hex')}`;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

async function invalidateBackingSwapCaches(flight: IMaterializationFlight) {
    for (const invalidator of backingSwapCacheInvalidators) {
        await invalidator(flight.logicalRef, flight.originalPath);
    }
}

async function publishMaterializedTarget(
    flight: IMaterializationFlight,
    tempPath: string,
    sourceFileExpectation: IWorkingCopyOriginalFileExpectation,
    sourceFingerprint: string,
) {
    const publication = await runWithWorkingCopyRegistrationFence(
        flight.logicalRef,
        flight.registrationId,
        async (entry) => {
            if (
                entry.backingState !== 'materializing'
                || !entry.admissionSnapshot
                || !workingCopyAdmissionSnapshotsMatch(entry.admissionSnapshot, flight.admissionSnapshot)
            ) {
                throw new WorkingCopyMaterializationError(
                    'WORKING_COPY_REGISTRATION_CHANGED',
                    'Working-copy registration changed during materialization',
                );
            }

            await invalidateBackingSwapCaches(flight);
            await assertSourceSnapshot(flight.originalPath, flight.admissionSnapshot);
            throwIfAborted(flight.controller.signal);
            await atomicReplace(tempPath, flight.logicalRef, {markMutationCommitStarted: false});
            entry.backingState = 'materialized';
            entry.originalFileExpectation = {
                ...sourceFileExpectation,
                contentFingerprint: sourceFingerprint,
            };
            delete entry.sourceBackingErrorCode;
        },
    );
    if (!publication.matched) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_REGISTRATION_CHANGED',
            'Working-copy registration changed during materialization',
        );
    }
}

async function copyAndPublishFlight(flight: IMaterializationFlight) {
    const signal = flight.controller.signal;
    const tempPath = `${flight.logicalRef}.materializing-${flight.operationId}-${randomUUID()}`;
    let sourceHandle: FileHandle | null = null;
    let outputHandle: FileHandle | null = null;
    let published = false;
    try {
        emitProgress(flight, {
            bytesCopied: 0,
            percent: 0,
            phase: 'checking-source',
            status: 'running',
        });
        throwIfAborted(signal);
        await assertSourceSnapshot(flight.originalPath, flight.admissionSnapshot);
        const filesystem = await statfs(dirname(flight.logicalRef), {bigint: true});
        const availableBytes = filesystem.bavail * filesystem.bsize;
        if (availableBytes < flight.admissionSnapshot.size) {
            throw new WorkingCopyMaterializationError(
                'WORKING_COPY_MATERIALIZATION_NO_SPACE',
                'Not enough disk space to prepare the working copy',
                {retryable: true},
            );
        }
        sourceHandle = await open(flight.originalPath, 'r');
        await assertSourceHandleSnapshot(sourceHandle, flight.admissionSnapshot);
        outputHandle = await open(tempPath, 'wx');

        const hash = createOriginalFileContentFingerprintHash(flight.totalBytes);
        const buffer = Buffer.allocUnsafe(Math.min(
            MATERIALIZATION_CHUNK_BYTES,
            Math.max(flight.totalBytes, 1),
        ));
        let bytesCopied = 0;
        emitProgress(flight, {
            bytesCopied,
            percent: progressPercent(bytesCopied, flight.totalBytes),
            phase: 'copying',
            status: 'running',
        });
        while (bytesCopied < flight.totalBytes) {
            throwIfAborted(signal);
            const length = Math.min(buffer.byteLength, flight.totalBytes - bytesCopied);
            const result = await sourceHandle.read(buffer, 0, length, bytesCopied);
            if (result.bytesRead !== length) {
                throw new WorkingCopyMaterializationError(
                    'SOURCE_BACKING_CHANGED',
                    'The original document changed while it was being materialized',
                );
            }
            await writeAll(outputHandle, buffer, length, bytesCopied);
            hash.update(buffer.subarray(0, length));
            bytesCopied += length;
            emitProgress(flight, {
                bytesCopied,
                percent: progressPercent(bytesCopied, flight.totalBytes),
                phase: 'copying',
                status: 'running',
            });
            if (bytesCopied < flight.totalBytes) {
                await yieldBetweenChunks();
            }
        }

        await assertSourceHandleSnapshot(sourceHandle, flight.admissionSnapshot);
        const sourceFileExpectation = createOriginalFileExpectationFromStat(
            await sourceHandle.stat({bigint: true}),
        );
        // Release the original as soon as its bytes are copied: on Windows an
        // open handle makes another program's rename-replace fail, and the
        // hashing and publication below read only the working copy.
        await sourceHandle.close();
        sourceHandle = null;
        await assertSourceSnapshot(flight.originalPath, flight.admissionSnapshot);
        const outputStat = await outputHandle.stat({bigint: true});
        if (!outputStat.isFile() || outputStat.size !== flight.admissionSnapshot.size) {
            throw new WorkingCopyMaterializationError(
                'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
                'Materialized working copy has an unexpected byte count',
                {retryable: true},
            );
        }
        await outputHandle.close();
        outputHandle = null;
        const sourceFingerprint = `sha256-full-v1:${hash.digest('hex')}`;
        const targetFingerprint = await hashMaterializedTarget(tempPath, flight.totalBytes, signal);
        if (targetFingerprint !== sourceFingerprint) {
            throw new WorkingCopyMaterializationError(
                'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
                'Materialized working copy failed hash verification',
                {retryable: true},
            );
        }

        emitProgress(flight, {
            bytesCopied: flight.totalBytes,
            percent: 100,
            phase: 'finalizing',
            status: 'running',
        });
        await publishMaterializedTarget(flight, tempPath, sourceFileExpectation, sourceFingerprint);
        published = true;
        emitProgress(flight, {
            bytesCopied: flight.totalBytes,
            percent: 100,
            phase: 'finalizing',
            status: 'completed',
        });
        return {
            logicalRef: flight.logicalRef,
            physicalWorkingCopyPath: flight.logicalRef,
            sourceFingerprint,
        };
    } catch (error) {
        const materializationError = normalizeMaterializationError(error);
        transitionWorkingCopyBackingState(
            flight.logicalRef,
            flight.registrationId,
            'lazy-original',
            {
                expectedBackingState: 'materializing',
                sourceBackingErrorCode: materializationError.code,
            },
        );
        emitProgress(flight, {
            bytesCopied: 0,
            errorCode: materializationError.code,
            percent: 0,
            phase: 'finalizing',
            status: materializationError.code === 'WORKING_COPY_MATERIALIZATION_CANCELLED'
                ? 'cancelled'
                : 'failed',
        });
        throw materializationError;
    } finally {
        await Promise.all([
            sourceHandle?.close().catch(() => undefined),
            outputHandle?.close().catch(() => undefined),
        ]);
        if (!published) {
            await rm(tempPath, {force: true}).catch(() => undefined);
        }
    }
}

function createFlight(
    logicalRef: string,
    entry: IWorkingCopyOriginalEntry,
    reason: TWorkingCopyMaterializationReason,
    backgroundLease: boolean,
) {
    if (!entry.admissionSnapshot) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_MATERIALIZATION_FAILED',
            'Lazy working copy has no admission snapshot',
        );
    }
    if (entry.admissionSnapshot.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_MATERIALIZATION_FAILED',
            'Working-copy source is too large to materialize safely',
        );
    }

    const key = createFlightKey(logicalRef, entry.registrationId);
    const lifecycleOperation = registerMainOperation({
        kind: 'abortable-work',
        ...(entry.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: entry.ownerWebContentsId}),
        workingCopyPath: logicalRef,
    });
    const controller = new AbortController();
    lifecycleOperation.signal.addEventListener('abort', () => {
        controller.abort(lifecycleOperation.signal.reason);
    }, {once: true});
    const flight: IMaterializationFlight = {
        admissionSnapshot: entry.admissionSnapshot,
        backgroundLease,
        bytesCopied: 0,
        controller,
        demandWaiters: 0,
        key,
        logicalRef,
        operationId: lifecycleOperation.id,
        originalPath: entry.originalPath,
        percent: 0,
        promise: Promise.resolve(null as never),
        reason,
        registrationId: entry.registrationId,
        totalBytes: Number(entry.admissionSnapshot.size),
    };
    flights.set(key, flight);
    if (!transitionWorkingCopyBackingState(
        logicalRef,
        entry.registrationId,
        'materializing',
        {
            expectedBackingState: 'lazy-original',
            sourceBackingErrorCode: null,
        },
    )) {
        flights.delete(key);
        lifecycleOperation.complete();
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_REGISTRATION_CHANGED',
            'Working-copy registration changed before materialization started',
        );
    }
    flight.promise = copyAndPublishFlight(flight)
        .finally(() => {
            flight.backgroundLease = false;
            if (flights.get(key) === flight) {
                flights.delete(key);
            }
            lifecycleOperation.complete();
        });
    void flight.promise.catch(() => undefined);
    return flight;
}

function getOrCreateFlight(
    logicalRef: string,
    ownerWebContentsId: number | undefined,
    reason: TWorkingCopyMaterializationReason,
    backgroundLease: boolean,
) {
    const entry = getWorkingCopyBackingEntry(logicalRef, ownerWebContentsId);
    if (!entry) {
        throw new Error('Working copy path is not managed by this owner');
    }
    if (
        entry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
        || entry.sourceBackingErrorCode === 'SOURCE_BACKING_UNAVAILABLE'
    ) {
        throw new WorkingCopyMaterializationError(
            entry.sourceBackingErrorCode,
            entry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
                ? 'The original document changed after it was opened'
                : 'The original document is unavailable',
        );
    }
    const key = createFlightKey(logicalRef, entry.registrationId);
    const existingFlight = flights.get(key);
    if (existingFlight) {
        if (backgroundLease) {
            existingFlight.backgroundLease = true;
        }
        return existingFlight;
    }
    // A registration left materializing without a flight behind it is the
    // remains of a run that died; recover it rather than refusing forever.
    if (entry.backingState === 'materializing') {
        transitionWorkingCopyBackingState(
            logicalRef,
            entry.registrationId,
            'lazy-original',
            {expectedBackingState: 'materializing'},
        );
    }
    return createFlight(logicalRef, entry, reason, backgroundLease);
}

function alreadyMaterializedResult(
    logicalRef: string,
    ownerWebContentsId?: number,
): IWorkingCopyMaterializationResult | null {
    const entry = getWorkingCopyBackingEntry(logicalRef, ownerWebContentsId);
    if (!entry) {
        throw new Error('Working copy path is not managed by this owner');
    }
    if (
        entry.backingState === 'cloned'
        || entry.backingState === 'eager'
        || entry.backingState === 'materialized'
    ) {
        try {
            if (!statSync(logicalRef).isFile()) {
                throw new Error('Managed working-copy backing is not a regular file');
            }
        } catch (error) {
            throw new WorkingCopyMaterializationError(
                'WORKING_COPY_MATERIALIZATION_FAILED',
                'Managed working-copy backing is unavailable',
                {cause: error},
            );
        }
        return {
            logicalRef,
            physicalWorkingCopyPath: logicalRef,
            sourceFingerprint: entry.originalFileExpectation?.contentFingerprint ?? '',
        };
    }
    return null;
}

function waitForFlight(
    flight: IMaterializationFlight,
    options: IEnsureWorkingCopyMaterializedOptions,
) {
    const demandOperation = registerMainOperation({
        kind: 'critical-write',
        ...(options.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: options.ownerWebContentsId}),
        workingCopyPath: flight.logicalRef,
    });
    flight.demandWaiters += 1;

    return new Promise<IWorkingCopyMaterializationResult>((resolve, reject) => {
        let settled = false;
        const signals = [
            demandOperation.signal,
            ...(options.signal ? [options.signal] : []),
        ];
        const settle = (
            operation: () => void,
        ) => {
            if (settled) {
                return;
            }
            settled = true;
            for (const signal of signals) {
                signal.removeEventListener('abort', handleAbort);
            }
            flight.demandWaiters -= 1;
            demandOperation.complete();
            // A flight belongs to whoever is still waiting for it. Copying a
            // large original is work nobody has asked for once the last waiter
            // is gone, so it stops there — and a caller that arrives while it is
            // stopping starts a fresh flight rather than adopting this one's
            // cancellation, which is what used to leave the viewer blank or
            // stuck at 0%.
            if (
                flight.demandWaiters === 0
                && !flight.backgroundLease
                && flights.get(flight.key) === flight
                && !flight.controller.signal.aborted
            ) {
                flight.controller.abort(new Error('All materialization waiters cancelled'));
            }
            operation();
        };
        const handleAbort = () => {
            settle(() => reject(new WorkingCopyMaterializationError(
                'WORKING_COPY_MATERIALIZATION_CANCELLED',
                'Working-copy materialization waiter was cancelled',
                {retryable: true},
            )));
        };
        for (const signal of signals) {
            if (signal.aborted) {
                handleAbort();
                return;
            }
            signal.addEventListener('abort', handleAbort, {once: true});
        }
        flight.promise.then(
            result => settle(() => resolve(result)),
            error => settle(() => reject(error)),
        );
    });
}

/** The registration's materialized result, or a flight that is not tearing down. */
async function getMaterializedOrLiveFlight(
    logicalRef: string,
    ownerWebContentsId: number | undefined,
    reason: TWorkingCopyMaterializationReason,
    backgroundLease: boolean,
) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const existingResult = alreadyMaterializedResult(logicalRef, ownerWebContentsId);
        if (existingResult) {
            return existingResult;
        }
        const flight = getOrCreateFlight(logicalRef, ownerWebContentsId, reason, backgroundLease);
        // A flight that is already tearing down has nothing to hand this
        // caller. Wait for it to release the registration and start a new one,
        // instead of adopting its cancellation as this request's answer.
        if (flight.controller.signal.aborted) {
            await flight.promise.catch(() => undefined);
            continue;
        }
        return flight;
    }
    throw new WorkingCopyMaterializationError(
        'WORKING_COPY_MATERIALIZATION_FAILED',
        'Working-copy materialization could not be restarted',
        {retryable: true},
    );
}

export async function ensureWorkingCopyMaterialized(
    logicalRef: string,
    options: IEnsureWorkingCopyMaterializedOptions,
) {
    const normalizedRef = typeof logicalRef === 'string' ? logicalRef.trim() : '';
    if (!normalizedRef) {
        throw new Error('Invalid working copy path');
    }
    const materialized = await getMaterializedOrLiveFlight(
        normalizedRef,
        options.ownerWebContentsId,
        options.reason,
        false,
    );
    return 'controller' in materialized ? waitForFlight(materialized, options) : materialized;
}

/**
 * Prewarms a lazy copy so the document stops depending on its original. The
 * copy is optional I/O, so it waits for the broker's background budget, one
 * per window at a time. Nothing waits for that admission: a caller that needs
 * the bytes starts its own flight, which the prewarm then keeps alive.
 */
export function startBackgroundWorkingCopyMaterialization(
    logicalRef: string,
    ownerWebContentsId?: number,
) {
    const existingResult = alreadyMaterializedResult(logicalRef, ownerWebContentsId);
    if (existingResult) {
        return null;
    }
    const admission = registerMainOperation({
        kind: 'abortable-work',
        ...(ownerWebContentsId === undefined ? {} : {ownerWebContentsId}),
        workingCopyPath: logicalRef,
    });
    const promise = mainJobBroker.acquire({
        ownerId: `working-copy-materialization:${ownerWebContentsId ?? 'main'}`,
        kind: 'working-copy-materialization',
        priority: 'background',
        perOwnerLimit: 1,
        signal: admission.signal,
        resources: {
            cpuTokens: 0,
            estimatedResidentBytes: 2 * MATERIALIZATION_CHUNK_BYTES,
            nativeProcesses: 0,
            ioWeight: 1,
        },
    })
        .finally(() => {
            admission.complete();
        })
        .then(async (lease) => {
            try {
                const materialized = await getMaterializedOrLiveFlight(logicalRef, ownerWebContentsId, 'background', true);
                return 'controller' in materialized ? await materialized.promise : materialized;
            } finally {
                lease.release();
            }
        });
    return {promise};
}

export function cancelWorkingCopyMaterialization(operationId: string, reason = 'Materialization cancelled') {
    const flight = [...flights.values()].find(candidate => candidate.operationId === operationId);
    if (!flight || flight.controller.signal.aborted) {
        return false;
    }
    flight.controller.abort(new Error(reason));
    return true;
}

export function onWorkingCopyMaterializationProgress(
    listener: (progress: IWorkingCopyMaterializationProgress) => void,
) {
    progressListeners.add(listener);
    return () => {
        progressListeners.delete(listener);
    };
}

export function onWorkingCopyBackingSwapCacheInvalidation(
    invalidator: TBackingSwapCacheInvalidator,
) {
    backingSwapCacheInvalidators.add(invalidator);
    return () => {
        backingSwapCacheInvalidators.delete(invalidator);
    };
}

export function getWorkingCopyMaterializationFlightCountForTests() {
    return flights.size;
}
