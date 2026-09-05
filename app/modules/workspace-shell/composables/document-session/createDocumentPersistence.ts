import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type { IPdfPersistResult } from '@app/types/pdfUi';
import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativePlacedImageGeometryUpdate,
    IPdfNativeMutationSet,
    IPdfNativeSaveResult,
    IPdfNoteGeometryUpdate,
    IPdfNoteTextUpdate,
    IPdfOptimizeOptions,
    IPdfSerializedCommitCallbacks,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import { isStaleRevisionError } from '@contracts/documentMutationErrors';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import type {
    ILazyHistoryBaseline,
    IPdfLoadedState,
} from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import { createDocumentPersistResults } from '@app/modules/workspace-shell/composables/document-session/createDocumentPersistResults';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { runDetached } from '@app/utils/asyncGuard';
import { publishStagedPdfNativeMutationForAutomation } from '@app/modules/workspace-shell/automation/automationReadinessEvents';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
    shouldRefreshWorkingCopyAfterSaveAs,
} from '@app/utils/platformDocuments';
import {
    adoptStablePathBackedPersistedState,
    hasNativePathBackedSource,
} from '@app/modules/workspace-shell/composables/document-session/adoptPathBackedPersistedState';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';
import {
    collectExpectedNativeIdentityIds,
    createDocumentMutationRevisionOptions,
    createNativeStagedCommitOptions,
    haveSameNativeIdentityBindings,
    validateNativeIdentityBindings,
} from '@app/modules/workspace-shell/composables/document-session/nativePdfMutationCommit';

interface IPdfPersistPhaseTiming {
    phase: string;
    durationMs: number;
}

interface ICreateDocumentPersistenceDeps {
    deferPdfConformanceProfile: (path: TDocumentRef) => void;
    ensureHistoryBaselineForMutation: () => Promise<boolean>;
    getHistoryDebugState: () => {
        historyLength: number;
        historyIndex: number;
        historyCleanIndex: number;
    };
    markCurrentHistoryEntryClean: (
        snapshot: Uint8Array | null,
        options?: {
            lazyBaseline?: ILazyHistoryBaseline;
            recordSnapshotChange?: boolean;
        },
    ) => Promise<void>;
    pushHistorySnapshot: (
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) => Promise<boolean>;
    readPdfStateFromPath: (path: TDocumentRef) => Promise<IPdfLoadedState>;
    shouldForceSaveAsForWorkingCopy: (
        saveMode: TPdfSaveMode,
        workingPath: TDocumentRef,
    ) => Promise<boolean>;
    t: TTranslateFn;
    toPdfBlob: (snapshot: Uint8Array) => Blob;
}

interface IWorkingCopyPersistOptions {
    saveMode?: TPdfSaveMode;
    expectedWorkingPath?: TDocumentRef | null;
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
}

const MAX_IN_MEMORY_PDF_BYTES = BROWSER_MAX_FULL_READ_BYTES;

class NativeMutationPreExposeError extends Error {}

export function createDocumentPersistence(
    state: IDocumentSessionState,
    deps: ICreateDocumentPersistenceDeps,
) {
    async function resolveStableLazyHistoryBaseline(path: TDocumentRef) {
        const documentFiles = getDocumentFilesCapability();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const before = await documentFiles.getDocumentRevision(path);
            const file = await documentFiles.statFile(path);
            const after = await documentFiles.getDocumentRevision(path);
            if (before.token === after.token) {
                return {
                    baseline: {
                        workingPath: path,
                        revision: after.token,
                        size: file.size,
                    },
                    revisionInfo: after,
                };
            }
        }
        throw new Error('Working-copy revision changed while adopting the saved path');
    }

    function resolveDocumentMutationRevisionToken(
        opts?: {expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined},
    ) {
        return opts && Object.prototype.hasOwnProperty.call(opts, 'expectedDocumentRevisionToken')
            ? opts.expectedDocumentRevisionToken
            : state.documentRevisionToken.value;
    }

    function resolveDocumentMutationRevisionOptions(
        opts?: {
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
            changedObjectRefs?: string[];
        },
    ): IPdfSerializedSaveOptions | undefined {
        const revision = createDocumentMutationRevisionOptions(resolveDocumentMutationRevisionToken(opts));
        if (!revision) {
            return undefined;
        }
        return {
            ...revision,
            ...(opts?.changedObjectRefs?.length ? {changedObjectRefs: opts.changedObjectRefs} : {}),
        };
    }

    async function commitPersistedPdfState(
        snapshotHint?: Uint8Array | null,
        expectedWorkingPath?: TDocumentRef,
        opts?: {
            preserveLoadedSource?: boolean;
            preserveConformanceProfile?: boolean;
        },
    ) {
        const path = expectedWorkingPath ?? state.workingCopyPath.value;
        if (!path) {
            return false;
        }
        if (!state.isActiveWorkingCopy(path)) {
            return false;
        }

        BrowserLogger.debug('workspace', 'Committing persisted PDF state', () => ({
            path,
            hasSnapshotHint: Boolean(snapshotHint),
            snapshotHintBytes: snapshotHint?.byteLength ?? 0,
            isDirty: state.isDirty.value,
            ...deps.getHistoryDebugState(),
        }));

        // The native path is the source of truth for desktop path documents.
        // A save may still hand us a renderer byte hint, but that hint must not
        // become a history/recovery snapshot. Keep the path and revision token
        // instead, so a 2+ GiB working copy never crosses into renderer memory.
        const hasNativePathSource = hasNativePathBackedSource(state, path);
        if (hasNativePathSource && !opts?.preserveLoadedSource) {
            if (!await adoptStablePathBackedPersistedState({
                state,
                path,
                resolveStableBaseline: () => resolveStableLazyHistoryBaseline(path),
                markCurrentHistoryEntryClean: deps.markCurrentHistoryEntryClean,
            })) {
                return false;
            }
        } else if (opts?.preserveLoadedSource) {
            if (!hasNativePathSource && snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
                const snapshot = snapshotHint.slice();
                if (!state.isActiveWorkingCopy(path)) {
                    return false;
                }
                state.pdfData.value = snapshot;
                state.pdfReloadSrc.value = state.pdfSrc.value instanceof Blob
                    ? deps.toPdfBlob(snapshot)
                    : {
                        kind: 'path',
                        path,
                        size: snapshot.byteLength,
                    };
                await deps.markCurrentHistoryEntryClean(snapshot, { recordSnapshotChange: false });
            } else {
                const {
                    baseline,
                    revisionInfo,
                } = await resolveStableLazyHistoryBaseline(path);
                if (!state.isActiveWorkingCopy(path)) {
                    return false;
                }
                state.documentRevisionInfo.value = revisionInfo;
                state.documentRevisionToken.value = revisionInfo.token;
                state.pdfData.value = null;
                state.pdfReloadSrc.value = {
                    kind: 'path',
                    path,
                    size: baseline.size,
                    revision: baseline.revision,
                };
                await deps.markCurrentHistoryEntryClean(null, {
                    lazyBaseline: baseline,
                    recordSnapshotChange: false,
                });
            }
        } else if (snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
            const snapshot = snapshotHint.slice();
            if (!state.isActiveWorkingCopy(path)) {
                return false;
            }
            state.pdfData.value = snapshot;
            state.pdfSrc.value = deps.toPdfBlob(snapshot);
            state.pdfReloadSrc.value = state.pdfSrc.value;
            await deps.markCurrentHistoryEntryClean(snapshot);
        } else {
            const nextState = await deps.readPdfStateFromPath(path);
            if (!state.isActiveWorkingCopy(path)) {
                return false;
            }
            state.pdfData.value = nextState.pdfData;
            state.pdfSrc.value = nextState.pdfSrc;
            state.pdfReloadSrc.value = nextState.pdfSrc;
            await deps.markCurrentHistoryEntryClean(nextState.pdfData);
        }

        if (opts?.preserveConformanceProfile !== true) {
            deps.deferPdfConformanceProfile(path);
        }
        BrowserLogger.debug('workspace', 'Committed persisted PDF state', () => ({
            path,
            isDirty: state.isDirty.value,
            ...deps.getHistoryDebugState(),
        }));
        return true;
    }

    const {
        createPersistResult,
        createFailedPersistResult,
        createStalePersistResult,
        createCancelledPersistResult,
    } = createDocumentPersistResults(() => state.originalPath.value);

    function roundDurationMs(durationMs: number) {
        return Math.round(durationMs * 10) / 10;
    }

    async function measurePdfPersistPhase<T>(
        phaseTimings: IPdfPersistPhaseTiming[],
        phase: string,
        operation: () => Promise<T>,
    ) {
        const start = performance.now();
        try {
            return await operation();
        } finally {
            phaseTimings.push({
                phase,
                durationMs: roundDurationMs(performance.now() - start),
            });
        }
    }

    async function runPersistOperation(
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
        operation: (workingPath: TDocumentRef) => Promise<IPdfPersistResult>,
        expectedWorkingPath?: TDocumentRef | null,
    ): Promise<IPdfPersistResult> {
        const workingPath = state.workingCopyPath.value;
        if (!workingPath) {
            return createFailedPersistResult(saveMode, didSaveAs);
        }
        if (
            expectedWorkingPath !== undefined
            && workingPath !== expectedWorkingPath
        ) {
            BrowserLogger.debug('workspace', 'Skipped stale PDF persistence request', {
                expectedWorkingPath,
                currentWorkingPath: workingPath,
                saveMode,
            });
            return createStalePersistResult(saveMode, didSaveAs);
        }

        try {
            return await operation(workingPath);
        } catch (e) {
            if (isStaleRevisionError(e)) {
                throw e;
            }
            state.error.value = e instanceof Error ? e.message : deps.t('errors.file.save');
            return createFailedPersistResult(saveMode, didSaveAs);
        }
    }

    async function stageWorkingCopyPersistenceRequest(
        opts: IWorkingCopyPersistOptions | undefined,
        requestedSaveMode: TPdfSaveMode,
        workingPath: TDocumentRef,
        operation: 'save' | 'repair' | 'optimize',
    ) {
        const expectedDocumentRevisionToken = resolveDocumentMutationRevisionToken(opts);
        const forceSaveAs = await deps.shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath);
        if (!state.isActiveWorkingCopy(workingPath)) {
            BrowserLogger.debug('workspace', `Skipped stale working-copy ${operation} before write`, {
                workingPath,
                currentWorkingPath: state.workingCopyPath.value,
                saveMode: requestedSaveMode,
            });
            return null;
        }
        return {
            expectedDocumentRevisionToken,
            forceSaveAs,
        };
    }

    async function persistPdfDataSilently(data: Uint8Array) {
        const expectedWorkingPath = state.workingCopyPath.value;
        const snapshot = data.slice();
        if (!await deps.ensureHistoryBaselineForMutation()) {
            return false;
        }
        if (expectedWorkingPath !== state.workingCopyPath.value) {
            return false;
        }
        if (expectedWorkingPath) {
            await getDocumentFilesCapability().writeFile(
                expectedWorkingPath,
                snapshot,
                createDocumentMutationRevisionOptions(state.documentRevisionToken.value),
            );
            if (!state.isActiveWorkingCopy(expectedWorkingPath)) {
                BrowserLogger.debug('pdf-file', 'Skipped stale silent PDF data persistence', {
                    expectedWorkingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                });
                return false;
            }
        } else if (state.workingCopyPath.value !== null) {
            return false;
        }

        state.pdfData.value = snapshot;
        state.pdfSrc.value = deps.toPdfBlob(snapshot);
        state.pdfReloadSrc.value = state.pdfSrc.value;
        await deps.pushHistorySnapshot(snapshot, { reuseSnapshot: true });

        if (expectedWorkingPath) {
            deps.deferPdfConformanceProfile(expectedWorkingPath);
        }
        return true;
    }

    async function saveWorkingCopyToOriginal(
        workingPath: TDocumentRef,
        expectedDocumentRevisionToken: TDocumentRevisionToken | null | undefined,
    ) {
        const documentFiles = getDocumentFilesCapability();
        const result = await documentFiles.saveFileStructured(
            workingPath,
            createDocumentMutationRevisionOptions(expectedDocumentRevisionToken),
        );
        if (!result.ok) {
            state.error.value = result.validation?.errors.join('\n')
                ?? result.message
                ?? deps.t('errors.file.save');
            return false;
        }
        if (result.warning) {
            BrowserLogger.warn('workspace', 'Working-copy save completed with a platform warning', result.warning);
        }
        return true;
    }

    async function saveFile(
        data: Uint8Array,
        opts?: {
            saveMode?: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
            changedObjectRefs?: string[];
            commitCallbacks?: IPdfSerializedCommitCallbacks;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const expectedDocumentRevisionToken = resolveDocumentMutationRevisionToken(opts);
            const forceSaveAs = await deps.shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale PDF save before write', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (forceSaveAs) {
                return saveWorkingCopyAs(data, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                    expectedDocumentRevisionToken,
                    ...(opts?.changedObjectRefs?.length ? {changedObjectRefs: opts.changedObjectRefs} : {}),
                    ...(opts?.commitCallbacks ? {commitCallbacks: opts.commitCallbacks} : {}),
                });
            }

            const wrote = await getDocumentFilesCapability().writeFile(
                workingPath,
                data,
                resolveDocumentMutationRevisionOptions({
                    expectedDocumentRevisionToken,
                    ...(opts?.changedObjectRefs?.length ? {changedObjectRefs: opts.changedObjectRefs} : {}),
                    ...(opts?.commitCallbacks ? {commitCallbacks: opts.commitCallbacks} : {}),
                }),
            );
            const validation = {
                isValid: wrote,
                tool: 'native' as const,
                errors: wrote ? [] : [deps.t('errors.file.save')],
                warnings: [],
            };
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale PDF save completion', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!validation.isValid) {
                state.error.value = validation.errors.join('\n') || deps.t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, false);
            }
            const commitOptions = opts?.preserveLoadedSource
                ? { preserveLoadedSource: true }
                : undefined;
            if (!await commitPersistedPdfState(data, workingPath, commitOptions)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function saveWorkingCopy(
        opts?: IWorkingCopyPersistOptions,
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const stagedRequest = await stageWorkingCopyPersistenceRequest(
                opts,
                requestedSaveMode,
                workingPath,
                'save',
            );
            if (!stagedRequest) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (stagedRequest.forceSaveAs) {
                return saveWorkingCopyAs(undefined, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                    expectedDocumentRevisionToken: stagedRequest.expectedDocumentRevisionToken,
                });
            }

            if (!await saveWorkingCopyToOriginal(workingPath, stagedRequest.expectedDocumentRevisionToken)) {
                return createFailedPersistResult(requestedSaveMode, false);
            }
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy save completion', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!await commitPersistedPdfState(undefined, workingPath)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function repairWorkingCopy(
        opts?: IWorkingCopyPersistOptions,
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const stagedRequest = await stageWorkingCopyPersistenceRequest(
                opts,
                requestedSaveMode,
                workingPath,
                'repair',
            );
            if (!stagedRequest) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (stagedRequest.forceSaveAs) {
                return saveWorkingCopyAs(undefined, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                    expectedDocumentRevisionToken: stagedRequest.expectedDocumentRevisionToken,
                });
            }

            const repairPdf = getDocumentFilesCapability().repairPdf;
            if (!repairPdf) {
                return createFailedPersistResult(requestedSaveMode, false);
            }
            const validation = await repairPdf(
                workingPath,
                createDocumentMutationRevisionOptions(stagedRequest.expectedDocumentRevisionToken),
            );
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy repair completion', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!validation.isValid) {
                state.error.value = validation.errors.join('\n') || deps.t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, false);
            }
            if (!await commitPersistedPdfState(undefined, workingPath)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function optimizeWorkingCopy(
        opts?: IWorkingCopyPersistOptions,
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const stagedRequest = await stageWorkingCopyPersistenceRequest(
                opts,
                requestedSaveMode,
                workingPath,
                'optimize',
            );
            if (!stagedRequest) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (stagedRequest.forceSaveAs) {
                return saveWorkingCopyAs(undefined, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                    expectedDocumentRevisionToken: stagedRequest.expectedDocumentRevisionToken,
                });
            }

            const optimizePdfForInteraction = getDocumentFilesCapability().optimizePdfForInteraction;
            if (!optimizePdfForInteraction) {
                return createFailedPersistResult(requestedSaveMode, false);
            }
            const validation = await optimizePdfForInteraction(
                workingPath,
                createDocumentMutationRevisionOptions(stagedRequest.expectedDocumentRevisionToken),
            );
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy optimize completion', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!validation.isValid) {
                state.error.value = validation.errors.join('\n') || deps.t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, false);
            }
            if (!await commitPersistedPdfState(undefined, workingPath)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function optimizeWorkingCopyAsCopy(
        options: IPdfOptimizeOptions,
        requestId?: string,
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
            expectedWorkingPath?: TDocumentRef | null;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'save_as_rewrite';
        return runPersistOperation(requestedSaveMode, true, async (workingPath) => {
            const previousWorkingPath = workingPath;
            const optimizePdfAsCopy = getDocumentFilesCapability().optimizePdfAsCopy;
            if (!optimizePdfAsCopy) {
                return createFailedPersistResult(requestedSaveMode, true);
            }

            const optimizeResult = await optimizePdfAsCopy(
                workingPath,
                options,
                requestId,
                createDocumentMutationRevisionOptions(
                    opts?.expectedDocumentRevisionToken ?? state.documentRevisionToken.value,
                ),
            );
            if (optimizeResult.validation && !optimizeResult.validation.isValid) {
                state.error.value = optimizeResult.validation.errors.join('\n') || deps.t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, true);
            }
            if (!state.isActiveWorkingCopy(previousWorkingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale optimized-copy completion', {
                    workingPath: previousWorkingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    savedPath: optimizeResult.path,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, true);
            }

            const savedPath = optimizeResult.path;
            if (savedPath) {
                let savedWorkingPath = previousWorkingPath;
                if (shouldRefreshWorkingCopyAfterSaveAs(savedPath, previousWorkingPath)) {
                    const nextWorkingPath = await getDocumentWorkingCopyCapability().createWorkingCopyFromPath(savedPath);
                    if (!state.isActiveWorkingCopy(previousWorkingPath)) {
                        BrowserLogger.debug('workspace', 'Skipped stale optimized-copy working-copy refresh', {
                            workingPath: previousWorkingPath,
                            currentWorkingPath: state.workingCopyPath.value,
                            nextWorkingPath,
                            savedPath,
                            saveMode: requestedSaveMode,
                        });
                        if (!state.isActiveWorkingCopy(nextWorkingPath)) {
                            void runDetached(
                                () => getDocumentWorkingCopyCapability().cleanupFile(nextWorkingPath),
                                {
                                    category: 'background-diagnostic',
                                    scope: 'workspace',
                                    message: 'Failed to cleanup stale optimized working copy',
                                },
                            );
                        }
                        return createStalePersistResult(requestedSaveMode, true);
                    }
                    state.workingCopyPath.value = nextWorkingPath;
                    savedWorkingPath = nextWorkingPath;
                    if (previousWorkingPath !== nextWorkingPath) {
                        try {
                            await getDocumentWorkingCopyCapability().cleanupFile(previousWorkingPath);
                        } catch (cleanupError) {
                            BrowserLogger.warn('workspace', 'Optimized copy succeeded but previous working-copy cleanup failed', {
                                previousWorkingPath,
                                nextWorkingPath,
                                savedPath,
                                error: cleanupError,
                            });
                        }
                    }
                }
                if (!state.isActiveWorkingCopy(savedWorkingPath)) {
                    BrowserLogger.debug('workspace', 'Skipped stale optimized-copy state commit', {
                        workingPath: savedWorkingPath,
                        currentWorkingPath: state.workingCopyPath.value,
                        savedPath,
                        saveMode: requestedSaveMode,
                    });
                    return createStalePersistResult(requestedSaveMode, true);
                }
                state.originalPath.value = savedPath;
                state.requiresSaveAsOnFirstSave.value = false;
                if (!await commitPersistedPdfState(undefined, savedWorkingPath)) {
                    return createStalePersistResult(requestedSaveMode, true);
                }
                state.lastSaveMode.value = requestedSaveMode;
                return createPersistResult(true, requestedSaveMode, true, savedPath);
            }

            return createCancelledPersistResult(requestedSaveMode);
        }, opts?.expectedWorkingPath);
    }

    async function trySaveEmbeddedNoteTextUpdates(
        updates: IPdfNoteTextUpdate[],
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
            modifiedAt: string;
            verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>;
            assertBeforeExpose?: () => Promise<void> | void;
            geometryUpdates?: IPdfNoteGeometryUpdate[];
            placedImageGeometryUpdates?: IPdfNativePlacedImageGeometryUpdate[];
            freeTextNotes?: IPdfNativeFreeTextNote[];
            deletes?: IPdfNativeAnnotationDelete[];
        },
    ): Promise<IPdfPersistResult | null> {
        return trySavePdfNativeMutations({
            ...(updates.length > 0 ? {updates} : {}),
            ...((opts.geometryUpdates?.length ?? 0) > 0 ? {geometryUpdates: opts.geometryUpdates} : {}),
            ...((opts.placedImageGeometryUpdates?.length ?? 0) > 0
                ? {placedImageGeometryUpdates: opts.placedImageGeometryUpdates}
                : {}),
            ...((opts.freeTextNotes?.length ?? 0) > 0 ? {freeTextNotes: opts.freeTextNotes} : {}),
            ...((opts.deletes?.length ?? 0) > 0 ? {deletes: opts.deletes} : {}),
        }, opts);
    }

    async function trySavePdfNativeMutations(
        mutations: IPdfNativeMutationSet,
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
            modifiedAt: string;
            verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>;
            assertBeforeExpose?: () => Promise<void> | void;
        },
    ): Promise<IPdfPersistResult | null> {
        const documentFiles = getDocumentFilesCapability();
        const updates = mutations.updates ?? [];
        const geometryUpdates = mutations.geometryUpdates ?? [];
        const placedImageGeometryUpdates = mutations.placedImageGeometryUpdates ?? [];
        const freeTextNotes = mutations.freeTextNotes ?? [];
        const textBoxes = mutations.textBoxes ?? [];
        const freeTextEditors = mutations.freeTextEditors ?? [];
        const deletes = mutations.deletes ?? [];
        const hasPageLabels = mutations.pageLabels !== undefined;
        const hasBookmarks = mutations.bookmarks !== undefined;
        const hasShapes = mutations.shapes !== undefined;
        const hasMarkup = mutations.markup !== undefined;
        const expectedNativeIdentityIds = collectExpectedNativeIdentityIds(mutations);
        const placedImages = mutations.placedImages ?? [];
        const hasPlacedImages = placedImages.length > 0;
        if (
            freeTextNotes.length === 0
            && textBoxes.length === 0
            && freeTextEditors.length === 0
            && updates.length === 0
            && geometryUpdates.length === 0
            && placedImageGeometryUpdates.length === 0
            && deletes.length === 0
            && !hasPageLabels
            && !hasBookmarks
            && !hasShapes
            && !hasMarkup
            && !hasPlacedImages
        ) {
            BrowserLogger.diagnostic('workspace', 'Native PDF mutation persistence returned no result', {reason: 'empty-mutation-set'});
            return null;
        }
        const canUseGenericNativeMutations = typeof documentFiles.applyPdfNativeMutationsToWorkingCopy === 'function'
            && typeof documentFiles.commitStagedPdfNativeMutations === 'function';
        const canUseLegacyNativeNoteText = (
            !hasPageLabels
            && !hasBookmarks
            && !hasShapes
            && !hasMarkup
            && !hasPlacedImages
            && freeTextNotes.length === 0
            && textBoxes.length === 0
            && freeTextEditors.length === 0
            && deletes.length === 0
            && updates.length > 0
            && geometryUpdates.length === 0
            && placedImageGeometryUpdates.length === 0
            && typeof documentFiles.savePdfNoteTextUpdates === 'function'
        );
        const canUseLegacyNativeNoteChanges = (
            !hasPageLabels
            && !hasBookmarks
            && !hasShapes
            && !hasMarkup
            && !hasPlacedImages
            && expectedNativeIdentityIds.length === 0
            && (geometryUpdates.length > 0 || freeTextNotes.length > 0 || deletes.length > 0)
            && textBoxes.length === 0
            && freeTextEditors.length === 0
            && typeof documentFiles.savePdfNoteChanges === 'function'
        );
        if (!canUseGenericNativeMutations && !canUseLegacyNativeNoteText && !canUseLegacyNativeNoteChanges) {
            BrowserLogger.diagnostic('workspace', 'Native PDF mutation persistence returned no result', () => ({
                reason: 'native-document-capability-unavailable',
                hasGenericApply: typeof documentFiles.applyPdfNativeMutationsToWorkingCopy === 'function',
                hasGenericCommit: typeof documentFiles.commitStagedPdfNativeMutations === 'function',
                hasLegacyNoteText: typeof documentFiles.savePdfNoteTextUpdates === 'function',
                hasLegacyNoteChanges: typeof documentFiles.savePdfNoteChanges === 'function',
                updateCount: updates.length,
                geometryUpdateCount: geometryUpdates.length,
                placedImageGeometryUpdateCount: placedImageGeometryUpdates.length,
                freeTextNoteCount: freeTextNotes.length,
                textBoxCount: textBoxes.length,
                freeTextEditorCount: freeTextEditors.length,
                deleteCount: deletes.length,
            }));
            return null;
        }

        const expectedDocumentRevisionToken = resolveDocumentMutationRevisionToken(opts);
        const requestedSaveMode = opts.saveMode;
        const workingPath = state.workingCopyPath.value;
        const expectedOriginalPath = state.originalPath.value;
        if (!workingPath) {
            return createFailedPersistResult(requestedSaveMode, false);
        }
        if (opts.expectedWorkingPath !== undefined && workingPath !== opts.expectedWorkingPath) {
            BrowserLogger.debug('workspace', 'Skipped stale native note-text save request', {
                expectedWorkingPath: opts.expectedWorkingPath,
                currentWorkingPath: workingPath,
                saveMode: requestedSaveMode,
            });
            return createStalePersistResult(requestedSaveMode, false);
        }

        const phaseTimings: IPdfPersistPhaseTiming[] = [];
        const operationStart = performance.now();
        const logRendererTimings = (status: string, extra?: Record<string, unknown>) => {
            const totalMs = roundDurationMs(performance.now() - operationStart);
            const log = totalMs >= 1_000 ? BrowserLogger.warn : BrowserLogger.debug;
            log('workspace', 'Native PDF mutation save renderer timings', {
                status,
                saveMode: requestedSaveMode,
                updateCount: updates.length,
                freeTextNoteCount: freeTextNotes.length,
                freeTextEditorCount: freeTextEditors.length,
                deleteCount: deletes.length,
                pageLabels: hasPageLabels,
                bookmarks: hasBookmarks,
                shapes: hasShapes,
                markup: hasMarkup,
                placedImageCount: placedImages.length,
                totalMs,
                phases: phaseTimings,
                ...extra,
            });
        };

        try {
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale native PDF mutation save before write', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                logRendererTimings('stale-before-write');
                return createStalePersistResult(requestedSaveMode, false);
            }
            const result = await measurePdfPersistPhase(
                phaseTimings,
                'native-ipc',
                async () => {
                    if (canUseGenericNativeMutations) {
                        const revisionOptions = createDocumentMutationRevisionOptions(expectedDocumentRevisionToken);
                        if (!revisionOptions) {
                            throw new NativeMutationPreExposeError(
                                'Native staged PDF mutation requires the document revision',
                            );
                        }
                        const applied = await measurePdfPersistPhase(
                            phaseTimings,
                            'native-apply',
                            () => documentFiles.applyPdfNativeMutationsToWorkingCopy!(
                                workingPath,
                                mutations,
                                opts.modifiedAt,
                                revisionOptions,
                            ),
                        );
                        if (!applied.applied || !applied.validation?.isValid) {
                            return applied;
                        }
                        if (!applied.stagedOutput) {
                            throw new NativeMutationPreExposeError('Native mutation did not return an immutable staged output');
                        }
                        let appliedIdentityBindings: IPdfNativeAnnotationIdentityBinding[];
                        try {
                            appliedIdentityBindings = validateNativeIdentityBindings(
                                applied.identityBindings,
                                expectedNativeIdentityIds,
                                'Native staged identity bindings',
                            );
                            // The native writer validates the projected mutation set against
                            // the staged appended revision before it returns. Reopening a large
                            // staged PDF in renderer PDF.js repeats those checks and can add
                            // seconds of visible save latency. Older/native-adjacent callers
                            // without the explicit proof retain the renderer verification.
                            if (
                                opts.verifyPathBeforeExpose
                                && applied.nativeMutationPostconditionsVerified !== true
                            ) {
                                await measurePdfPersistPhase(
                                    phaseTimings,
                                    'native-verify-staged-path',
                                    () => opts.verifyPathBeforeExpose!(
                                        applied.stagedOutput!.path,
                                        applied.stagedOutput!.size,
                                    ),
                                );
                            }
                            if (opts.assertBeforeExpose) {
                                await measurePdfPersistPhase(
                                    phaseTimings,
                                    'native-assert-current',
                                    async () => opts.assertBeforeExpose!(),
                                );
                            }
                            await measurePdfPersistPhase(
                                phaseTimings,
                                'native-publish-automation',
                                () => publishStagedPdfNativeMutationForAutomation(applied.stagedOutput!),
                            );
                        } catch (error) {
                            await documentFiles.releaseManagedTempFileHandle?.(applied.stagedOutput.leaseId);
                            throw new NativeMutationPreExposeError(getErrorMessage(error));
                        }
                        let committed: IPdfNativeSaveResult;
                        try {
                            committed = await measurePdfPersistPhase(
                                phaseTimings,
                                'native-commit',
                                () => documentFiles.commitStagedPdfNativeMutations!(
                                    workingPath,
                                    applied.stagedOutput!,
                                    createNativeStagedCommitOptions(
                                        expectedDocumentRevisionToken,
                                        mutations,
                                        appliedIdentityBindings,
                                    ),
                                ),
                            );
                        } catch (error) {
                            throw new NativeMutationPreExposeError(getErrorMessage(error));
                        }
                        if (!committed.applied || !committed.validation?.isValid) {
                            throw new NativeMutationPreExposeError('Targeted native mutation validation failed before commit');
                        }
                        const committedIdentityBindings = validateNativeIdentityBindings(
                            committed.identityBindings,
                            expectedNativeIdentityIds,
                            'Native committed identity bindings',
                        );
                        if (!haveSameNativeIdentityBindings(appliedIdentityBindings, committedIdentityBindings)) {
                            throw new NativeMutationPreExposeError('Native identity bindings changed between staging and commit');
                        }
                        return committed;
                    }
                    if (canUseLegacyNativeNoteChanges) {
                        return documentFiles.savePdfNoteChanges!(workingPath, {
                            ...(updates.length > 0 ? {updates} : {}),
                            ...(geometryUpdates.length > 0 ? {geometryUpdates} : {}),
                            ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
                            ...(deletes.length > 0 ? {deletes} : {}),
                        }, opts.modifiedAt, createDocumentMutationRevisionOptions(expectedDocumentRevisionToken));
                    }
                    return documentFiles.savePdfNoteTextUpdates!(
                        workingPath,
                        updates,
                        opts.modifiedAt,
                        createDocumentMutationRevisionOptions(expectedDocumentRevisionToken),
                    );
                },
            );
            if (!result.applied || !result.validation?.isValid) {
                BrowserLogger.warn('workspace', 'Native PDF mutation was not applied', {
                    reason: 'native-mutation-not-applied',
                    applied: result.applied,
                    error: result.error,
                    validation: result.validation,
                });
                logRendererTimings('not-applied', {validation: result.validation});
                return null;
            }
            const materializedIdentityBindings = validateNativeIdentityBindings(
                result.identityBindings,
                expectedNativeIdentityIds,
                'Native identity bindings',
            );
            if (result.syncError) {
                BrowserLogger.warn('workspace', 'Native PDF mutation committed with a working copy sync warning', {
                    workingPath,
                    syncError: result.syncError,
                });
            }
            const commitWorkingPath = state.workingCopyPath.value;
            if (!commitWorkingPath || state.originalPath.value !== expectedOriginalPath) {
                BrowserLogger.debug('workspace', 'Skipped stale native PDF mutation save completion', {
                    workingPath,
                    expectedOriginalPath,
                    currentOriginalPath: state.originalPath.value,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                logRendererTimings('stale-after-write');
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (commitWorkingPath !== workingPath) {
                BrowserLogger.debug('workspace', 'Using refreshed working copy after native PDF mutation save', {
                    workingPath,
                    refreshedWorkingPath: commitWorkingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
            }

            const commitOptions = opts.preserveLoadedSource
                ? {
                    preserveLoadedSource: true,
                    preserveConformanceProfile: true,
                }
                : undefined;
            const committed = await measurePdfPersistPhase(
                phaseTimings,
                'commit-persisted-state',
                () => commitPersistedPdfState(undefined, commitWorkingPath, commitOptions),
            );
            if (!committed) {
                logRendererTimings('stale-commit');
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            logRendererTimings('applied');
            return materializedIdentityBindings.length > 0
                ? {
                    ...createPersistResult(true, requestedSaveMode, false),
                    materializedIdentityBindings,
                }
                : createPersistResult(true, requestedSaveMode, false);
        } catch (saveError) {
            if (saveError instanceof NativeMutationPreExposeError) {
                throw saveError;
            }
            if (isStaleRevisionError(saveError)) {
                throw saveError;
            }
            BrowserLogger.warn('workspace', 'Native PDF mutation save failed', {
                error: getErrorMessage(saveError),
                updateCount: updates.length,
                freeTextNoteCount: freeTextNotes.length,
                freeTextEditorCount: freeTextEditors.length,
                deleteCount: deletes.length,
                pageLabels: hasPageLabels,
                bookmarks: hasBookmarks,
                shapes: hasShapes,
                markup: hasMarkup,
                placedImageCount: placedImages.length,
                saveMode: requestedSaveMode,
                totalMs: roundDurationMs(performance.now() - operationStart),
                phases: phaseTimings,
            });
            return null;
        }
    }

    async function saveWorkingCopyAs(
        data?: Uint8Array,
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
            optimizeLossless?: boolean;
            changedObjectRefs?: string[];
            commitCallbacks?: IPdfSerializedCommitCallbacks;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'save_as_rewrite';
        return runPersistOperation(requestedSaveMode, true, async (workingPath) => {
            const revisionOptions = resolveDocumentMutationRevisionOptions(opts);
            const previousWorkingPath = workingPath;
            const saveAsOptions = opts?.optimizeLossless === true
                ? { optimizeLossless: true }
                : undefined;
            void data;
            const saveAsResult = {
                path: await getDocumentFilesCapability().savePdfAs(
                    workingPath,
                    saveAsOptions,
                    revisionOptions,
                ),
                validation: null,
            };
            const savedPath = saveAsResult.path;
            if (!state.isActiveWorkingCopy(previousWorkingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale Save As completion', {
                    workingPath: previousWorkingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    savedPath: saveAsResult.path,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, true);
            }
            if (savedPath) {
                let savedWorkingPath = previousWorkingPath;
                if (shouldRefreshWorkingCopyAfterSaveAs(savedPath, previousWorkingPath)) {
                    const nextWorkingPath =
                        await getDocumentWorkingCopyCapability().createWorkingCopyFromPath(savedPath);
                    if (!state.isActiveWorkingCopy(previousWorkingPath)) {
                        BrowserLogger.debug('workspace', 'Skipped stale Save As working-copy refresh', {
                            workingPath: previousWorkingPath,
                            currentWorkingPath: state.workingCopyPath.value,
                            nextWorkingPath,
                            savedPath,
                            saveMode: requestedSaveMode,
                        });
                        if (!state.isActiveWorkingCopy(nextWorkingPath)) {
                            void getDocumentWorkingCopyCapability().cleanupFile(nextWorkingPath);
                        }
                        return createStalePersistResult(requestedSaveMode, true);
                    }
                    state.workingCopyPath.value = nextWorkingPath;
                    savedWorkingPath = nextWorkingPath;
                    if (previousWorkingPath !== nextWorkingPath) {
                        try {
                            await getDocumentWorkingCopyCapability().cleanupFile(previousWorkingPath);
                        } catch (cleanupError) {
                            BrowserLogger.warn('workspace', 'Save As succeeded but previous working-copy cleanup failed', {
                                previousWorkingPath,
                                nextWorkingPath,
                                savedPath,
                                error: cleanupError,
                            });
                        }
                    }
                }
                if (!state.isActiveWorkingCopy(savedWorkingPath)) {
                    BrowserLogger.debug('workspace', 'Skipped stale Save As state commit', {
                        workingPath: savedWorkingPath,
                        currentWorkingPath: state.workingCopyPath.value,
                        savedPath,
                        saveMode: requestedSaveMode,
                    });
                    return createStalePersistResult(requestedSaveMode, true);
                }
                state.originalPath.value = savedPath;
                state.requiresSaveAsOnFirstSave.value = false;
                if (!await commitPersistedPdfState(data ?? undefined, savedWorkingPath)) {
                    return createStalePersistResult(requestedSaveMode, true);
                }
                state.lastSaveMode.value = requestedSaveMode;
                return createPersistResult(true, requestedSaveMode, true, savedPath);
            }
            return createCancelledPersistResult(requestedSaveMode);
        }, opts?.expectedWorkingPath);
    }

    return {
        persistPdfDataSilently,
        saveFile,
        repairWorkingCopy,
        optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy,
        saveWorkingCopy,
        saveWorkingCopyAs,
        trySaveEmbeddedNoteTextUpdates,
        trySavePdfNativeMutations,
    };
}
