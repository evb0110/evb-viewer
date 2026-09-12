import {
    readdir,
    rm,
    stat,
} from 'fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    clearRetiredWorkingCopyOriginals,
    forgetRetiredWorkingCopyOriginal,
    forgetWorkingCopyOriginalPath,
    getWorkingCopyOwnerWebContentsId,
    hasWorkingCopyRecoveryClaim,
    normalizePathForLookup,
    rememberRetiredWorkingCopyOriginal,
    runWithWorkingCopyRegistrationFence,
    workingCopyMap,
    type IWorkingCopyOriginalEntry,
} from '@electron/file-access/workingCopyStore';
import {
    isWorkingCopyDirectoryName,
    safeRemoveDirectory,
} from '@electron/file-access/workingCopyDirectory';
import {
    getAppTempDir,
    getLegacyAppTempDirPath,
} from '@electron/utils/appTempDir';
import { drainWorkingCopyMutations } from '@electron/file-access/workingCopyMutationQueue';
import {
    clearWorkingCopyRevisionInitializations,
    forgetWorkingCopyRevisionInitialization,
    hasWorkingCopySyncRequired,
} from '@electron/file-access/documentRevisionStore';
import {
    clearPageIdentityStoreInitializations,
    forgetPageIdentityStoreInitialization,
} from '@electron/file-access/pageIdentityStore';
import {cleanupStaleAtomicReplaceBackups} from '@electron/utils/atomicReplace';
import {
    cancelWorkingCopyMaterialization,
    ensureWorkingCopyMaterialized,
} from '@electron/file-access/workingCopyMaterialization';
import {
    cancelMainOperationsForClosingWorkingCopy,
    snapshotMainOperations,
    snapshotCancellableWorkingCopyDependents,
    waitForMainOperationsSettled,
    type IClosingWorkingCopyOwnership,
    type IMainOperationSnapshot,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {
    describeWorkingCopyQuarantine,
    isWorkingCopyQuarantined,
} from '@electron/file-access/workingCopyQuarantine';

const logger = createLogger('working-copy');
const STALE_WORK_DIR_MAX_AGE_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_WORKING_COPY_STALE_MAX_AGE_MS ?? `${24 * 60 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 60_000) {
        return 24 * 60 * 60 * 1000;
    }
    return parsed;
})();
const CLOSING_WORKING_COPY_REASON = 'Working copy is closing';
// Closing a document cancels the jobs that read its working copy, and the
// directory may only go away once they have actually stopped. Scan cleanup is
// the slowest of them: a cooperative worker cancel gets a five second grace
// period, and only then does the worker-task harness force terminate the
// thread, so this bound clears that policy with room to spare. What it does not
// do is turn expiry into permission. A dependent still running when the bound
// expires keeps its directory; the close reports that and leaves the bytes
// alone.
const DEPENDENT_OPERATION_SETTLEMENT_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_WORKING_COPY_DEPENDENT_SETTLE_TIMEOUT_MS ?? `${30_000}`,
        10,
    );
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 30_000;
    }
    return Math.min(parsed, 5 * 60_000);
})();
// Shutdown has already refused new operations and cancelled every running one,
// so its dependents are unwinding rather than starting, and the app owes the
// user a prompt exit. The bound is short for that reason and, like the close
// bound, expiry retains the bytes instead of authorising their deletion.
const SHUTDOWN_DEPENDENT_SETTLEMENT_TIMEOUT_MS = Math.min(
    DEPENDENT_OPERATION_SETTLEMENT_TIMEOUT_MS,
    5_000,
);
const STALE_WORK_DIR_SCAN_LIMIT = (() => {
    const parsed = Number.parseInt(process.env.EVB_WORKING_COPY_STALE_SCAN_LIMIT ?? '512', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 512;
    }
    return Math.min(parsed, 10_000);
})();

let staleWorkingCopyCleanupBlockedReason: string | null = null;
let staleWorkingCopyCleanupPromise: Promise<void> | null = null;

export interface ICleanupStaleWorkingCopyDirectoriesOptions {statConcurrency?: number;}

/**
 * A checkpoint read failure leaves recovery evidence in place, so stale
 * directory cleanup must not guess that the corresponding work copy is safe
 * to remove during this process.
 */
export function blockStaleWorkingCopyDirectoryCleanup(reason: string) {
    staleWorkingCopyCleanupBlockedReason ??= reason;
}

function getWorkingCopyLogicalPath(
    mapPath: string,
    entry: Pick<IWorkingCopyOriginalEntry, 'logicalPath'>,
) {
    const logicalPath = typeof entry.logicalPath === 'string' ? entry.logicalPath.trim() : '';
    return logicalPath || mapPath;
}

function isRegisteredWorkingCopyDirectory(workDir: string) {
    const normalizedDirectory = normalizePathForLookup(workDir);
    return [...workingCopyMap.entries()]
        .some(([
            mapPath,
            entry,
        ]) => normalizePathForLookup(
            dirname(getWorkingCopyLogicalPath(mapPath, entry)),
        ) === normalizedDirectory);
}

async function performCleanupStaleWorkingCopyDirectories(
    options: ICleanupStaleWorkingCopyDirectoriesOptions = {},
): Promise<{
    removedDirectories: number;
    removedOcrDirectories: number;
}> {
    if (staleWorkingCopyCleanupBlockedReason) {
        logger.warn(
            `Skipped stale working-copy cleanup because recovery preservation is required: ${staleWorkingCopyCleanupBlockedReason}`,
        );
        return {
            removedDirectories: 0,
            removedOcrDirectories: 0,
        };
    }
    let removedDirectories = 0;
    let removedOcrDirectories = 0;
    const now = Date.now();
    const tempDirs = Array.from(new Set([
        resolve(getAppTempDir()),
        resolve(getLegacyAppTempDirPath()),
    ]));
    const entriesByTempDir = await Promise.all(tempDirs.map(async (tempDir) => {
        try {
            return (await readdir(tempDir)).map(entryName => ({
                entryName,
                tempDir,
            }));
        } catch {
            return [];
        }
    }));
    const candidates = entriesByTempDir.flat()
        .filter(({entryName}) => isWorkingCopyDirectoryName(entryName) && !entryName.endsWith('.ocr'))
        .slice(0, STALE_WORK_DIR_SCAN_LIMIT)
        .map(({
            entryName,
            tempDir,
        }) => ({
            tempDir,
            workDir: resolve(join(tempDir, entryName)),
        }))
        .filter(({
            tempDir,
            workDir,
        }) => {
            const relativePath = relative(tempDir, workDir);
            return relativePath !== '..'
                && !relativePath.startsWith(`..${sep}`)
                && !isAbsolute(relativePath);
        });
    const workerCount = Math.min(
        candidates.length,
        Math.max(1, Math.trunc(options.statConcurrency ?? 8)),
    );
    const retainedAtomicReplaceBackupDirectories = new Set<string>();
    let removedAtomicReplaceBackups = 0;
    let nextBackupCleanupIndex = 0;

    await Promise.all(Array.from({length: workerCount}, async () => {
        while (nextBackupCleanupIndex < candidates.length) {
            if (staleWorkingCopyCleanupBlockedReason) {
                return;
            }
            const candidateIndex = nextBackupCleanupIndex;
            nextBackupCleanupIndex += 1;
            const candidate = candidates[candidateIndex];
            if (!candidate) {
                continue;
            }
            const backupCleanup = await cleanupStaleAtomicReplaceBackups(candidate.workDir, {
                isDestinationActive: destinationPath => isRegisteredWorkingCopyDirectory(dirname(destinationPath)),
                maxAgeMs: STALE_WORK_DIR_MAX_AGE_MS,
                now,
            });
            if (backupCleanup.hasRetainedBackup) {
                retainedAtomicReplaceBackupDirectories.add(candidate.workDir);
            }
            removedAtomicReplaceBackups += backupCleanup.removedBackups;
        }
    }));

    if (staleWorkingCopyCleanupBlockedReason) {
        return {
            removedDirectories,
            removedOcrDirectories,
        };
    }

    let nextCandidateIndex = 0;

    await Promise.all(Array.from({length: workerCount}, async () => {
        while (nextCandidateIndex < candidates.length) {
            if (staleWorkingCopyCleanupBlockedReason) {
                return;
            }
            const candidateIndex = nextCandidateIndex;
            nextCandidateIndex += 1;
            const candidate = candidates[candidateIndex];
            if (!candidate) {
                continue;
            }
            const {workDir} = candidate;

            try {
                const workDirStat = await stat(workDir);
                if (!workDirStat.isDirectory() || now - workDirStat.mtimeMs < STALE_WORK_DIR_MAX_AGE_MS) {
                    continue;
                }
            } catch {
                continue;
            }

            if (isRegisteredWorkingCopyDirectory(workDir)) {
                continue;
            }
            if (retainedAtomicReplaceBackupDirectories.has(workDir)) {
                continue;
            }
            if (staleWorkingCopyCleanupBlockedReason) {
                return;
            }
            if (await safeRemoveDirectory(workDir)) {
                removedDirectories += 1;
            }
            if (staleWorkingCopyCleanupBlockedReason) {
                return;
            }
            if (await safeRemoveDirectory(`${workDir}.ocr`)) {
                removedOcrDirectories += 1;
            }
        }
    }));

    if (removedAtomicReplaceBackups > 0) {
        logger.info(`Cleaned stale atomic replace backups: ${removedAtomicReplaceBackups}`);
    }
    if (removedDirectories > 0 || removedOcrDirectories > 0) {
        logger.info(
            `Cleaned stale working copy temp directories (work=${removedDirectories}, ocr=${removedOcrDirectories}, scanned=${candidates.length})`,
        );
    }

    return {
        removedDirectories,
        removedOcrDirectories,
    };
}

export function cleanupStaleWorkingCopyDirectories(
    options: ICleanupStaleWorkingCopyDirectoriesOptions = {},
): Promise<{
    removedDirectories: number;
    removedOcrDirectories: number;
}> {
    const previousCleanup = staleWorkingCopyCleanupPromise ?? Promise.resolve();
    const currentCleanup = previousCleanup.then(() => performCleanupStaleWorkingCopyDirectories(options));
    const settledCleanup = currentCleanup.then(() => undefined, () => undefined);
    staleWorkingCopyCleanupPromise = settledCleanup;
    return currentCleanup.finally(() => {
        if (staleWorkingCopyCleanupPromise === settledCleanup) {
            staleWorkingCopyCleanupPromise = null;
        }
    });
}

function isPathWithin(parentPath: string, candidatePath: string) {
    const relativePath = relative(parentPath, candidatePath);
    return relativePath === '' || (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
    );
}

async function cleanupWorkingCopyDirectory(
    workingPath: string,
    originalPath?: string,
) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    try {
        const tempDirs = new Set([
            normalizePathForLookup(getAppTempDir()),
            normalizePathForLookup(getLegacyAppTempDirPath()),
        ]);
        const workDir = normalizePathForLookup(dirname(normalizedPath));
        const workDirName = basename(workDir);
        const isWithinTemp = Array.from(tempDirs).some((tempDir) => {
            const relativePath = relative(tempDir, workDir);
            return relativePath !== '..'
                && !relativePath.startsWith(`..${sep}`)
                && !isAbsolute(relativePath);
        });
        const isWorkingCopyDir = workDirName.startsWith('pdf-work-');

        if (isWithinTemp && isWorkingCopyDir) {
            const ocrDir = `${workDir}.ocr`;
            const resolvedOriginalPath = originalPath ? normalizePathForLookup(originalPath) : null;
            if (resolvedOriginalPath && isPathWithin(workDir, resolvedOriginalPath)) {
                logger.warn(`Refused to delete a working directory containing its original backing: ${workDir}`);
                await rm(ocrDir, {
                    recursive: true,
                    force: true,
                });
                return;
            }
            await Promise.all([
                rm(workDir, {
                    recursive: true,
                    force: true,
                }),
                rm(ocrDir, {
                    recursive: true,
                    force: true,
                }),
            ]);
        }
    } catch (err) {
        logger.warn(`Failed to delete working directory: ${getErrorMessage(err)}`);
    }
}

function getMaterializationOperations(workingPath: string) {
    return snapshotMainOperations()
        .filter(operation => operation.workingCopyPath === workingPath);
}

async function waitForOperationSettlement(operationIds: Set<string>) {
    while (
        operationIds.size > 0
        && snapshotMainOperations().some(operation => operationIds.has(operation.id))
    ) {
        await new Promise<void>((resolveSettlement) => {
            setImmediate(resolveSettlement);
        });
    }
}

async function settleWorkingCopyMaterialization(
    workingPath: string,
    entry: IWorkingCopyOriginalEntry,
) {
    if (entry.backingState !== 'materializing') {
        return;
    }
    const joined = await runWithWorkingCopyRegistrationFence(
        workingPath,
        entry.registrationId,
        (currentEntry) => {
            if (currentEntry.backingState !== 'materializing') {
                return null;
            }
            const initialOperations = getMaterializationOperations(workingPath);
            const hasActiveDemand = initialOperations.some(operation => (
                operation.kind === 'critical-write'
                && !operation.aborted
            ));
            const settlement = ensureWorkingCopyMaterialized(workingPath, {
                ...(currentEntry.ownerWebContentsId === undefined
                    ? {}
                    : {ownerWebContentsId: currentEntry.ownerWebContentsId}),
                reason: 'checkpoint-recovery',
            });
            return {
                hasActiveDemand,
                operations: hasActiveDemand
                    ? initialOperations
                    : getMaterializationOperations(workingPath),
                settlement,
            };
        },
    );
    if (!joined.matched || !joined.value) {
        return;
    }

    const {
        hasActiveDemand,
        operations,
        settlement,
    } = joined.value;
    const abortableOperationIds = new Set(
        operations
            .filter(operation => operation.kind === 'abortable-work')
            .map(operation => operation.id),
    );
    if (!hasActiveDemand) {
        for (const operation of [...operations].reverse()) {
            if (operation.kind === 'abortable-work') {
                const cancelled = cancelWorkingCopyMaterialization(
                    operation.id,
                    'Working-copy materialization cancelled during cleanup',
                );
                if (cancelled) {
                    break;
                }
            }
        }
    }
    await settlement.catch((error) => {
        logger.debug(
            `${hasActiveDemand ? 'Joined' : 'Cancelled'} working-copy materialization settled with an error: ${
                getErrorMessage(error)
            }`,
        );
    });
    await waitForOperationSettlement(abortableOperationIds);
}

export async function settleAllWorkingCopyMaterializations() {
    const materializingEntries = [...workingCopyMap.entries()]
        .filter(([
            , entry,
        ]) => entry.backingState === 'materializing');
    await Promise.allSettled(materializingEntries.map(([
        mapPath,
        entry,
    ]) => (
        settleWorkingCopyMaterialization(getWorkingCopyLogicalPath(mapPath, entry), entry)
    )));
}

type TDependentSettlementOutcome = 'settled' | 'unsettled' | 'ownership-lost';

interface IWorkingCopyDependentSettlement {
    outcome: TDependentSettlementOutcome;
    pending: IMainOperationSnapshot[];
}

// A close owns one registration, never a path. `isRegistrationCurrent` is read
// again before every cancellation round, and re-registering a path is a
// synchronous transition in the store, so a replacement that appears at any
// point is observed before the next round can cancel anything belonging to it.
function createClosingOwnership(
    workingPath: string,
    registrationId: number,
): IClosingWorkingCopyOwnership {
    return {isRegistrationCurrent: () => workingCopyMap.get(workingPath)?.registrationId === registrationId};
}

// A dependent can register between the moment its predecessors were cancelled
// and the moment the last of them stops, so one cancel-and-wait pass does not
// prove the working copy is unused. Each round cancels whatever is cancellable
// at that instant and waits for it; the loop ends when a round finds nothing
// left to stop. The round count is bounded so a caller that keeps starting work
// against a closing working copy cannot hold the close open forever, and an
// exhausted budget reports as unsettled rather than as proof of safety.
const MAX_DEPENDENT_CANCELLATION_ROUNDS = 4;

async function stopWorkingCopyDependents(
    workingPath: string,
    ownership: IClosingWorkingCopyOwnership,
    timeoutMs: number,
): Promise<IWorkingCopyDependentSettlement> {
    let canceled = cancelMainOperationsForClosingWorkingCopy(
        workingPath,
        CLOSING_WORKING_COPY_REASON,
        ownership,
    );
    for (let round = 0; round < MAX_DEPENDENT_CANCELLATION_ROUNDS; round += 1) {
        if (canceled === null) {
            return {
                outcome: 'ownership-lost',
                pending: [],
            };
        }
        if (canceled.length === 0) {
            return {
                outcome: 'settled',
                pending: [],
            };
        }
        if (round === 0) {
            logger.debug(
                `Cancelled ${canceled.length} dependent operation(s) for a closing working copy `
                + `(${canceled.map(operation => operation.kind).join(', ')})`,
            );
        } else {
            logger.debug(
                `Cancelled ${canceled.length} dependent operation(s) that started while "${workingPath}" was closing`,
            );
        }
        const settlement = await waitForMainOperationsSettled(canceled, {timeoutMs});
        if (!settlement.settled) {
            return {
                outcome: 'unsettled',
                pending: settlement.pending,
            };
        }
        canceled = cancelMainOperationsForClosingWorkingCopy(
            workingPath,
            CLOSING_WORKING_COPY_REASON,
            ownership,
        );
    }
    // The round budget is spent. The last cancellation round still has to be
    // read for what it says: if the caller lost the registration on it, the
    // path belongs to a replacement and the close owes it nothing, which is a
    // different answer from "dependents would not stop" even though both leave
    // the bytes alone.
    if (canceled === null) {
        return {
            outcome: 'ownership-lost',
            pending: [],
        };
    }
    // The last round found nothing left to stop, which is the same proof the
    // loop accepts on any earlier round. Spending the budget is not itself a
    // failure, and reporting one here would retain a working copy whose
    // dependents demonstrably stopped.
    if (canceled.length === 0) {
        return {
            outcome: 'settled',
            pending: [],
        };
    }
    const unsettledIds = new Set(canceled.map(operation => operation.id));
    return {
        outcome: 'unsettled',
        pending: snapshotMainOperations().filter(operation => unsettledIds.has(operation.id)),
    };
}

function describePendingDependents(pending: readonly IMainOperationSnapshot[]) {
    if (pending.length === 0) {
        return 'the operation records were gone before they could be described';
    }
    return pending
        .map(operation => `${operation.kind}#${operation.id}${operation.aborted ? '' : ' (not aborted)'}`)
        .join(', ');
}

// Deleting a working copy whose dependents have not stopped is the incident
// this close path exists to prevent: a Poppler child mid-page keeps reading the
// file and the user's cancellation turns into a failure. When settlement cannot
// be proven the directory stays where it is. Nothing else in the session will
// delete it, and the stale working-copy sweep reclaims it on a later run once
// no process can possibly hold it.
//
// Retention is the designed outcome of an unprovable stop, not a fault, so it
// is reported below the severity the renderer turns into a user-visible runtime
// error while still reaching the log file and telemetry.
function reportRetainedWorkingCopy(
    workingPath: string,
    reason: string,
) {
    logger.warn(`Retained the working copy directory for "${workingPath}" instead of deleting it: ${reason}`);
}

function describeUnsettledDependents(
    settlement: IWorkingCopyDependentSettlement,
    phase: string,
    timeoutMs: number,
) {
    return `${settlement.pending.length} cancelled dependent operation(s) had not stopped ${phase} `
        + `within ${timeoutMs}ms (${describePendingDependents(settlement.pending)})`;
}

type TWorkingCopyRetirementOutcome =
    | {
        status: 'deleted';
        originalPath: string;
    }
    | {
        status: 'retained';
        reason: string;
    }
    | {
        status: 'skipped';
        reason: string;
    };

// Retirement and deletion run inside a single registration fence, so they are
// one indivisible step against the store's own ownership mechanism: a
// re-registration of this path cannot interleave between them, and one that
// already happened fails the fence and leaves the bytes untouched. The last look
// at the operation registry happens in the same synchronous turn as the
// retirement, so an operation joining a replacement registration is seen before
// anything is removed and keeps the bytes it reads.
async function retireAndDeleteWorkingCopy(
    workingPath: string,
    entry: IWorkingCopyOriginalEntry,
): Promise<TWorkingCopyRetirementOutcome> {
    const retirement = await runWithWorkingCopyRegistrationFence(
        workingPath,
        entry.registrationId,
        async (currentEntry): Promise<TWorkingCopyRetirementOutcome> => {
            if (hasWorkingCopyRecoveryClaim(workingPath)) {
                return {
                    status: 'retained',
                    reason: 'an unresolved recovery checkpoint still owns this working copy',
                };
            }
            const dependents = snapshotCancellableWorkingCopyDependents(workingPath);
            if (dependents.length > 0) {
                return {
                    status: 'retained',
                    reason: `${dependents.length} operation(s) still hold this working copy `
                        + `(${describePendingDependents(dependents)})`,
                };
            }
            const {originalPath} = currentEntry;
            rememberRetiredWorkingCopyOriginal(
                workingPath,
                originalPath,
                currentEntry.ownerWebContentsId,
                {
                    ...(currentEntry.admissionSnapshot ? {admissionSnapshot: currentEntry.admissionSnapshot} : {}),
                    backingState: currentEntry.backingState,
                    ...(currentEntry.originalFileExpectation
                        ? {originalFileExpectation: currentEntry.originalFileExpectation}
                        : {}),
                    role: currentEntry.role,
                    ...(currentEntry.sourceBackingErrorCode
                        ? {sourceBackingErrorCode: currentEntry.sourceBackingErrorCode}
                        : {}),
                },
            );
            forgetWorkingCopyOriginalPath(workingPath);
            forgetWorkingCopyRevisionInitialization(workingPath);
            forgetPageIdentityStoreInitialization(workingPath);
            // The document is closed either way; only the bytes are in question.
            // A quarantine says some native reader was never proven dead, so the
            // directory outlives the registration and the stale sweep reclaims it.
            if (isWorkingCopyQuarantined(workingPath)) {
                return {
                    status: 'retained',
                    reason: `the working copy is quarantined (${describeWorkingCopyQuarantine(workingPath)})`,
                };
            }
            await cleanupWorkingCopyDirectory(workingPath, originalPath);
            return {
                status: 'deleted',
                originalPath,
            };
        },
    );
    return retirement.matched
        ? retirement.value
        : {
            status: 'skipped',
            reason: 'its registration changed while its dependents settled',
        };
}

export async function cleanupWorkingCopy(workingPath: string, senderWebContentsId?: number) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    const originalEntry = workingCopyMap.get(normalizedPath);
    if (!originalEntry) {
        logger.warn(`Rejected cleanup for unmanaged working copy path "${normalizedPath}"`);
        return;
    }
    const workingCopyPath = getWorkingCopyLogicalPath(normalizedPath, originalEntry);
    const ownerWebContentsId = getWorkingCopyOwnerWebContentsId(normalizedPath);
    if (
        typeof ownerWebContentsId === 'number'
        && ownerWebContentsId !== senderWebContentsId
    ) {
        logger.warn(`Rejected cleanup for working copy path owned by another sender "${normalizedPath}"`);
        return;
    }

    if (hasWorkingCopyRecoveryClaim(normalizedPath)) {
        logger.warn(
            `Retained recovery working copy while its checkpoint adoption is unresolved "${normalizedPath}"`,
        );
        return;
    }
    if (hasWorkingCopySyncRequired(normalizedPath)) {
        logger.warn(
            `Retained working copy while its document transition is unresolved "${normalizedPath}"`,
        );
        return;
    }

    // Mutations already in flight own the bytes too. Draining before the
    // dependents are stopped lets a write finish rather than be torn out from
    // under itself, and draining again afterwards catches whatever the unwinding
    // dependents enqueued on their way out.
    await drainWorkingCopyMutations(workingCopyPath);
    const ownership = createClosingOwnership(workingCopyPath, originalEntry.registrationId);
    const settlement = await stopWorkingCopyDependents(
        workingCopyPath,
        ownership,
        DEPENDENT_OPERATION_SETTLEMENT_TIMEOUT_MS,
    );
    if (settlement.outcome === 'ownership-lost') {
        logger.warn(
            `Skipped cleanup for a working copy re-registered while its dependents settled "${workingCopyPath}"`,
        );
        return;
    }
    if (settlement.outcome === 'unsettled') {
        reportRetainedWorkingCopy(
            workingCopyPath,
            describeUnsettledDependents(
                settlement,
                'while its registration was still active',
                DEPENDENT_OPERATION_SETTLEMENT_TIMEOUT_MS,
            ),
        );
        return;
    }

    await drainWorkingCopyMutations(workingCopyPath);
    const currentOwnerWebContentsId = getWorkingCopyOwnerWebContentsId(workingCopyPath);
    if (
        typeof currentOwnerWebContentsId === 'number'
        && currentOwnerWebContentsId !== senderWebContentsId
    ) {
        logger.warn(`Rejected cleanup for working copy path whose owner changed while waiting "${workingCopyPath}"`);
        return;
    }

    await settleWorkingCopyMaterialization(workingCopyPath, originalEntry);
    // Materialization settling can admit new dependents, so the cancel-and-wait
    // loop runs once more before the registration is retired.
    const postMaterializationSettlement = await stopWorkingCopyDependents(
        workingCopyPath,
        ownership,
        DEPENDENT_OPERATION_SETTLEMENT_TIMEOUT_MS,
    );
    if (postMaterializationSettlement.outcome === 'ownership-lost') {
        logger.warn(
            `Skipped cleanup for a working copy re-registered while its dependents settled "${workingCopyPath}"`,
        );
        return;
    }
    if (postMaterializationSettlement.outcome === 'unsettled') {
        reportRetainedWorkingCopy(
            workingCopyPath,
            describeUnsettledDependents(
                postMaterializationSettlement,
                'while its materialization settled',
                DEPENDENT_OPERATION_SETTLEMENT_TIMEOUT_MS,
            ),
        );
        return;
    }

    const retirement = await retireAndDeleteWorkingCopy(workingCopyPath, originalEntry);
    if (retirement.status === 'skipped') {
        logger.warn(`Skipped cleanup for a working copy: ${retirement.reason} "${workingCopyPath}"`);
        return;
    }
    if (retirement.status === 'retained') {
        reportRetainedWorkingCopy(workingCopyPath, retirement.reason);
    }
}

export async function clearAllWorkingCopies(options: {skipPaths?: Iterable<string>} = {}) {
    await drainWorkingCopyMutations();
    const paths = [...workingCopyMap.entries()].map(([
        mapPath,
        entry,
    ]) => ({
        entry,
        mapPath,
        workingPath: getWorkingCopyLogicalPath(mapPath, entry),
    }));
    const skipPaths = new Set(Array.from(options.skipPaths ?? [])
        .map(path => typeof path === 'string' ? path.trim() : '')
        .filter(Boolean));
    const skipPathKeys = new Set(Array.from(skipPaths).map(path => normalizePathForLookup(path)));
    for (const path of paths) {
        const {workingPath} = path;
        if (hasWorkingCopySyncRequired(workingPath)) {
            skipPaths.add(workingPath);
            skipPathKeys.add(normalizePathForLookup(workingPath));
        }
    }
    const pathsToDelete = paths.filter(({workingPath}) => !skipPathKeys.has(normalizePathForLookup(workingPath)));

    const retiredPaths = new Set<string>();
    // Kept apart from `skipPaths`: a path retained because its readers could not
    // be proven stopped is a designed outcome already reported at warn level,
    // while `skipPaths` is the unsaved-work list that shutdown reports as a
    // fault. Merging them would turn every quarantine into an application error.
    const retainedPaths = new Set<string>();
    await Promise.all(pathsToDelete.map(async (path) => {
        const {
            entry,
            workingPath,
        } = path;
        // Shutdown cancels every main operation before this step, but a cancel
        // is still only a request. The abortable dependents that read these
        // bytes — OCR, search indexing, image export, DjVu conversion — have to
        // be observed stopping before the directory can go, exactly as they do
        // on a document close. The critical-write path keeps its own protection
        // upstream: `main.ts` adds the paths of writes that failed to drain to
        // `skipPaths`, so they never reach this loop.
        const ownership = createClosingOwnership(workingPath, entry.registrationId);
        const settlement = await stopWorkingCopyDependents(
            workingPath,
            ownership,
            SHUTDOWN_DEPENDENT_SETTLEMENT_TIMEOUT_MS,
        );
        if (settlement.outcome !== 'settled') {
            retainedPaths.add(workingPath);
            reportRetainedWorkingCopy(
                workingPath,
                settlement.outcome === 'ownership-lost'
                    ? 'its registration changed during shutdown'
                    : describeUnsettledDependents(
                        settlement,
                        'during shutdown',
                        SHUTDOWN_DEPENDENT_SETTLEMENT_TIMEOUT_MS,
                    ),
            );
            return;
        }
        await settleWorkingCopyMaterialization(workingPath, entry);
        const retirement = await retireAndDeleteWorkingCopy(workingPath, entry);
        if (retirement.status !== 'deleted') {
            retainedPaths.add(workingPath);
            reportRetainedWorkingCopy(workingPath, retirement.reason);
            return;
        }
        retiredPaths.add(workingPath);
        forgetRetiredWorkingCopyOriginal(workingPath);
    }));

    if (workingCopyMap.size === 0) {
        clearRetiredWorkingCopyOriginals();
        clearWorkingCopyRevisionInitializations();
        clearPageIdentityStoreInitializations();
    }
    if (skipPaths.size > 0) {
        logger.warn(
            `Skipped shutdown deletion for ${skipPaths.size} working copy path(s) with pending writes or dirty sync state: ${
                Array.from(skipPaths).join(', ')
            }`,
        );
    }
    logger.debug(
        `Deleted ${retiredPaths.size} working copy director(ies) during shutdown, `
        + `retained ${retainedPaths.size}`,
    );
}
