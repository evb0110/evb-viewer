import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type {
    IPdfPersistFailure,
    IPdfPersistResult,
} from '@app/types/pdfUi';
import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfDateString } from '@contracts/pdfDateString';
import type { TRequestId } from '@contracts/shared';
import type {
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeMutationSet,
    IPdfNativeSaveResult,
    IPdfOptimizeOptions,
    IPdfOptimizeResult,
    IPdfSerializedSaveOptions,
    TPreparedPdfOptimizeCopy,
} from '@contracts/electronApiDocuments';
import { isStaleRevisionError } from '@contracts/documentMutationErrors';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/documentSessionState';
import type {IPdfLoadedState} from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
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
    resolveStableLazyHistoryBaseline,
    hasNativePathBackedSource,
    alignLoadedPathSourceLength,
} from '@app/modules/workspace-shell/composables/document-session/adoptPathBackedPersistedState';
import { PDF_COMBINE_MAX_OUTPUT_BYTES } from '@contracts/pdfCombineOutputPolicy';
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
    refreshDocumentRevisionToken: (path: TDocumentRef, isCurrent: () => boolean) => Promise<boolean>;
    deferPdfConformanceProfile: (path: TDocumentRef) => void;
    ensureHistoryBaselineForMutation: () => Promise<boolean>;
    captureHistoryCleanState: () => () => Promise<void>;
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
    preserveLoadedSource?: boolean;
    saveMode?: TPdfSaveMode;
    expectedWorkingPath?: TDocumentRef | null;
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
}

const MAX_IN_MEMORY_PDF_BYTES = PDF_COMBINE_MAX_OUTPUT_BYTES;

export function createDocumentPersistence(
    state: IDocumentSessionState,
    deps: ICreateDocumentPersistenceDeps,
) {
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
        snapshotHint: Uint8Array | null | undefined,
        expectedWorkingPath: TDocumentRef,
        markCurrentHistoryEntryClean: () => Promise<void>,
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

        // The native path is the source of truth for desktop path documents.
        // A save may still hand us a renderer byte hint, but that hint must not
        // become a history/recovery snapshot. Keep the path and revision token
        // instead, so a 2+ GiB working copy never crosses into renderer memory.
        const hasNativePathSource = hasNativePathBackedSource(state, path);
        if (!hasNativePathSource && !await deps.refreshDocumentRevisionToken(path, () => state.isActiveWorkingCopy(path))) return false;
        if (hasNativePathSource && !opts?.preserveLoadedSource) {
            if (!await adoptStablePathBackedPersistedState({
                state,
                path,
                resolveStableBaseline: () => resolveStableLazyHistoryBaseline(path),
                markCurrentHistoryEntryClean,
            })) {
                return false;
            }
        } else if (opts?.preserveLoadedSource) {
            if (!hasNativePathSource && snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
                const snapshot = snapshotHint.slice();
                state.pdfData.value = snapshot;
                state.pdfReloadSrc.value = state.pdfSrc.value instanceof Blob
                    ? deps.toPdfBlob(snapshot)
                    : {
                        kind: 'path',
                        path,
                        size: snapshot.byteLength,
                    };
                await markCurrentHistoryEntryClean();
            } else {
                const {
                    baseline,
                    revisionInfo,
                } = await resolveStableLazyHistoryBaseline(path);
                if (!state.isActiveWorkingCopy(path)) {
                    return false;
                }
                state.documentRevisionInfo.value = revisionInfo;
                state.pdfData.value = null;
                state.pdfReloadSrc.value = {
                    kind: 'path',
                    path,
                    size: baseline.size,
                    revision: baseline.revision,
                };
                alignLoadedPathSourceLength(state, path, baseline.size, baseline.revision);
                await markCurrentHistoryEntryClean();
            }
        } else if (snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
            const snapshot = snapshotHint.slice();
            state.pdfData.value = snapshot;
            state.pdfSrc.value = deps.toPdfBlob(snapshot);
            state.pdfReloadSrc.value = state.pdfSrc.value;
            await markCurrentHistoryEntryClean();
        } else {
            const nextState = await deps.readPdfStateFromPath(path);
            if (!state.isActiveWorkingCopy(path)) {
                return false;
            }
            state.pdfData.value = nextState.pdfData;
            state.pdfSrc.value = nextState.pdfSrc;
            state.pdfReloadSrc.value = nextState.pdfSrc;
            await markCurrentHistoryEntryClean();
        }

        if (opts?.preserveConformanceProfile !== true) {
            deps.deferPdfConformanceProfile(path);
        }
        return true;
    }

    const {
        createPersistResult,
        createFailedPersistResult,
        createStalePersistResult,
        createCancelledPersistResult,
    } = createDocumentPersistResults(() => state.originalPath.value);

    /**
     * A refused write is reported by the save flow in the user's language with
     * an error ID; its raw cause travels as that record's diagnostics. The
     * document's error state belongs to a failed open, so a save never writes it.
     */
    function refusedPersistFailure(
        channel: string,
        phase: string,
        reason: IPdfPersistFailure['reason'],
        detail: Pick<IPdfPersistFailure, 'message' | 'validation' | 'cause' | 'keptFilePath' | 'externalWriteCommitted'>,
    ): IPdfPersistFailure {
        return {
            channel,
            operation: 'persist',
            phase,
            reason,
            ...detail,
        };
    }

    // A step whose working copy this document no longer holds.
    function skipStale(step: string, workingPath: TDocumentRef, saveMode: TPdfSaveMode, didSaveAs = false) {
        BrowserLogger.debug('workspace', `Skipped stale ${step}`, {
            workingPath,
            currentWorkingPath: state.workingCopyPath.value,
            saveMode,
        });
        return createStalePersistResult(saveMode, didSaveAs);
    }

    /** Whether a refused save still wrote the file. */
    function saveOutcomeFields(result: Pick<IPdfPersistFailure, 'externalWriteCommitted'>) {
        return result.externalWriteCommitted === undefined ? {} : {externalWriteCommitted: result.externalWriteCommitted};
    }

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
        operation: (workingPath: TDocumentRef, markClean: () => Promise<void>) => Promise<IPdfPersistResult>,
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
            return await operation(workingPath, deps.captureHistoryCleanState());
        } catch (e) {
            // A canceled operation reaches the save flow's cancellation, not its failure toast.
            if (isStaleRevisionError(e) || (e instanceof DOMException && e.name === 'AbortError')) {
                throw e;
            }
            return createFailedPersistResult(saveMode, didSaveAs, refusedPersistFailure('persist', 'write', 'write-failed', {
                message: getErrorMessage(e),
                cause: e,
            }));
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

    async function saveWorkingCopy(
        opts?: IWorkingCopyPersistOptions,
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath, markClean) => {
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

            const result = await getDocumentFilesCapability().saveFileStructured(
                workingPath,
                createDocumentMutationRevisionOptions(stagedRequest.expectedDocumentRevisionToken),
            );
            if (!result.ok) {
                return createFailedPersistResult(requestedSaveMode, false, {
                    channel: 'file:saveStructured',
                    operation: 'saveFileStructured',
                    phase: 'publish-original',
                    reason: result.reason,
                    ...(result.keptFilePath === undefined ? {} : {keptFilePath: result.keptFilePath}),
                    ...(result.message === undefined ? {} : {message: result.message}),
                    ...(result.validation === undefined ? {} : {validation: result.validation}),
                    ...saveOutcomeFields(result),
                });
            }
            if (result.warning) {
                BrowserLogger.warn('workspace', 'Working-copy save completed with a platform warning', result.warning);
            }
            if (!state.isActiveWorkingCopy(workingPath)) {
                return skipStale('working-copy save completion', workingPath, requestedSaveMode);
            }
            if (!await commitPersistedPdfState(undefined, workingPath, markClean, opts?.preserveLoadedSource === undefined ? undefined : {preserveLoadedSource: opts.preserveLoadedSource})) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return {
                ...createPersistResult(true, requestedSaveMode, false),
                ...(result.documentRevision ? {documentRevision: result.documentRevision} : {}),
            };
        }, opts?.expectedWorkingPath);
    }

    async function repairWorkingCopy(
        opts?: IWorkingCopyPersistOptions,
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath, markClean) => {
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
                return skipStale('working-copy repair completion', workingPath, requestedSaveMode);
            }
            if (!validation.isValid) {
                return createFailedPersistResult(requestedSaveMode, false, refusedPersistFailure(
                    'file:repairPdf',
                    'validate-output',
                    'validation-failed',
                    {validation},
                ));
            }
            if (!await commitPersistedPdfState(undefined, workingPath, markClean)) {
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
        return runPersistOperation(requestedSaveMode, false, async (workingPath, markClean) => {
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
                return skipStale('working-copy optimize completion', workingPath, requestedSaveMode);
            }
            if (!validation.isValid) {
                return createFailedPersistResult(requestedSaveMode, false, refusedPersistFailure(
                    'file:optimizePdfForInteraction',
                    'validate-output',
                    'validation-failed',
                    {validation},
                ));
            }
            if (!await commitPersistedPdfState(undefined, workingPath, markClean)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function optimizeWorkingCopyAsCopy(
        options: IPdfOptimizeOptions,
        requestId?: TRequestId,
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
            expectedWorkingPath?: TDocumentRef | null;
            onResult?: (result: IPdfOptimizeResult) => void;
            preparedOptimize?: TPreparedPdfOptimizeCopy;
            signal?: AbortSignal;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'save_as_rewrite';
        return runPersistOperation(requestedSaveMode, true, async (workingPath, markClean) => {
            const previousWorkingPath = workingPath;
            const optimizePdfAsCopy = getDocumentFilesCapability().optimizePdfAsCopy;
            const revisionOptions = createDocumentMutationRevisionOptions(
                opts?.expectedDocumentRevisionToken ?? state.documentRevisionToken.value,
            );
            // A target picked during the user's click comes with its own Optimize;
            // desktop picks inside its four-argument call.
            let optimizeResult: IPdfOptimizeResult;
            if (opts?.preparedOptimize) {
                optimizeResult = await opts.preparedOptimize(workingPath, options, requestId, revisionOptions, opts.signal);
            } else if (optimizePdfAsCopy) {
                optimizeResult = await optimizePdfAsCopy(workingPath, options, requestId, revisionOptions);
            } else {
                return createFailedPersistResult(requestedSaveMode, true);
            }
            if (optimizeResult.validation && !optimizeResult.validation.isValid) {
                return createFailedPersistResult(requestedSaveMode, true, refusedPersistFailure(
                    'file:optimizePdfAsCopy',
                    'validate-output',
                    'validation-failed',
                    {validation: optimizeResult.validation},
                ));
            }
            if (!state.isActiveWorkingCopy(previousWorkingPath)) {
                return skipStale('optimized-copy completion', previousWorkingPath, requestedSaveMode, true);
            }

            opts?.onResult?.(optimizeResult);
            const savedPath = optimizeResult.path;
            if (savedPath) {
                let savedWorkingPath = previousWorkingPath;
                // Unlike Save As, the copy holds other bytes than the working
                // copy, so the document continues from the copy on every platform.
                if (savedPath !== previousWorkingPath) {
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
                }
                try {
                    state.originalPath.value = savedPath;
                    state.requiresSaveAsOnFirstSave.value = false;
                    if (!await commitPersistedPdfState(undefined, savedWorkingPath, markClean)) {
                        return createStalePersistResult(requestedSaveMode, true);
                    }
                    state.lastSaveMode.value = requestedSaveMode;
                    return createPersistResult(true, requestedSaveMode, true, savedPath);
                } finally {
                    if (previousWorkingPath !== savedWorkingPath) {
                        void runDetached(
                            () => getDocumentWorkingCopyCapability().cleanupFile(previousWorkingPath),
                            {
                                category: 'background-diagnostic',
                                scope: 'workspace',
                                message: 'Failed to cleanup previous saved working copy',
                            },
                        );
                    }
                }
            }

            return createCancelledPersistResult(requestedSaveMode);
        }, opts?.expectedWorkingPath);
    }

    async function trySavePdfNativeMutations(
        mutations: IPdfNativeMutationSet,
        opts: {
            saveMode: TPdfSaveMode;
            optimizeLossless?: boolean;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
            modifiedAt: TPdfDateString;
            workingCopyOnly?: true;
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
        const applyPdfNativeMutationsToWorkingCopy = documentFiles.applyPdfNativeMutationsToWorkingCopy;
        const commitStagedPdfNativeMutations = documentFiles.commitStagedPdfNativeMutations;
        const replaceWorkingCopyFromStagedPdfNativeMutation = documentFiles.replaceWorkingCopyFromStagedPdfNativeMutation;
        const canReplaceWorkingCopyFromStagedMutation = typeof replaceWorkingCopyFromStagedPdfNativeMutation === 'function';
        if (
            typeof applyPdfNativeMutationsToWorkingCopy !== 'function'
            || typeof commitStagedPdfNativeMutations !== 'function'
        ) {
            BrowserLogger.diagnostic('workspace', 'Native PDF mutation persistence returned no result', () => ({
                reason: 'native-document-capability-unavailable',
                hasGenericApply: typeof applyPdfNativeMutationsToWorkingCopy === 'function',
                hasGenericCommit: typeof commitStagedPdfNativeMutations === 'function',
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
        if (opts.workingCopyOnly && !canReplaceWorkingCopyFromStagedMutation) {
            return null;
        }

        const expectedDocumentRevisionToken = resolveDocumentMutationRevisionToken(opts);
        let stagedSaveAsResult: IPdfPersistResult | null = null;
        let materializedIdentityBindings: IPdfNativeAnnotationIdentityBinding[] = [];
        let annotationDeleteEffects: IPdfNativeSaveResult['annotationDeleteEffects'];
        // A failed save may have committed the staged bytes before it stopped; the shell acknowledges their identities then.
        const stagedIdentities = () => (materializedIdentityBindings.length > 0 ? {materializedIdentityBindings} : {});
        const workingPath = state.workingCopyPath.value;
        const expectedOriginalPath = state.originalPath.value;
        if (!workingPath) {
            return createFailedPersistResult(opts.saveMode, false);
        }
        if (opts.expectedWorkingPath !== undefined && workingPath !== opts.expectedWorkingPath) {
            BrowserLogger.debug('workspace', 'Skipped stale native note-text save request', {
                expectedWorkingPath: opts.expectedWorkingPath,
                currentWorkingPath: workingPath,
                saveMode: opts.saveMode,
            });
            return createStalePersistResult(opts.saveMode, false);
        }

        const markClean = deps.captureHistoryCleanState();
        const phaseTimings: IPdfPersistPhaseTiming[] = [];
        const operationStart = performance.now();
        const logRendererTimings = (status: string, extra?: Record<string, unknown>) => {
            const totalMs = roundDurationMs(performance.now() - operationStart);
            const log = totalMs >= 1_000 ? BrowserLogger.info : BrowserLogger.debug;
            log('workspace', 'Native PDF mutation save renderer timings', {
                status,
                saveMode: opts.saveMode,
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
                logRendererTimings('stale-before-write');
                return skipStale('native PDF mutation save before write', workingPath, opts.saveMode);
            }
            const result = await measurePdfPersistPhase(
                phaseTimings,
                'native-ipc',
                async (): Promise<IPdfNativeSaveResult> => {
                    const revisionOptions = createDocumentMutationRevisionOptions(expectedDocumentRevisionToken);
                    if (!revisionOptions) {
                        throw new Error(
                            'Native staged PDF mutation requires the document revision',
                        );
                    }
                    const applied = await measurePdfPersistPhase(
                        phaseTimings,
                        'native-apply',
                        () => applyPdfNativeMutationsToWorkingCopy(
                            workingPath,
                            mutations,
                            opts.modifiedAt,
                            revisionOptions,
                        ),
                    );
                    if (!applied.applied || !applied.validation?.isValid) {
                        return applied;
                    }
                    const stagedOutput = applied.stagedOutput;
                    if (!stagedOutput) {
                        throw new Error('Native mutation did not return an immutable staged output');
                    }
                    const verifyPathBeforeExpose = opts.verifyPathBeforeExpose;
                    const assertBeforeExpose = opts.assertBeforeExpose;
                    try {
                        materializedIdentityBindings = validateNativeIdentityBindings(
                            applied.identityBindings,
                            expectedNativeIdentityIds,
                            'Native staged identity bindings',
                        );
                        annotationDeleteEffects = applied.annotationDeleteEffects;
                        // Verified native postconditions replace the renderer reopen.
                        // Callers without that proof still verify the staged bytes.
                        if (
                            verifyPathBeforeExpose
                            && applied.nativeMutationPostconditionsVerified !== true
                        ) {
                            await measurePdfPersistPhase(
                                phaseTimings,
                                'native-verify-staged-path',
                                () => verifyPathBeforeExpose(
                                    stagedOutput.path,
                                    stagedOutput.size,
                                ),
                            );
                        }
                        if (assertBeforeExpose) {
                            await measurePdfPersistPhase(
                                phaseTimings,
                                'native-assert-current',
                                async () => assertBeforeExpose(),
                            );
                        }
                        await measurePdfPersistPhase(
                            phaseTimings,
                            'native-publish-automation',
                            () => publishStagedPdfNativeMutationForAutomation(stagedOutput),
                        );
                        await assertBeforeExpose?.();
                    } catch (error) {
                        await documentFiles.releaseManagedTempFileHandle?.(stagedOutput.leaseId);
                        throw error;
                    }
                    if (opts.saveMode === 'save_as_rewrite') {
                        try {
                            stagedSaveAsResult = await saveWorkingCopyAs(undefined, {
                                saveMode: opts.saveMode,
                                expectedWorkingPath: workingPath,
                                expectedDocumentRevisionToken,
                                stagedOutput,
                                preserveLoadedSource: opts.preserveLoadedSource === true,
                                ...(opts.optimizeLossless ? {optimizeLossless: true} : {}),
                            });
                            if (stagedSaveAsResult.success) {
                                stagedSaveAsResult = {
                                    ...stagedSaveAsResult,
                                    materializedIdentityBindings,
                                    ...(annotationDeleteEffects ? {annotationDeleteEffects} : {}),
                                };
                            }
                            return applied;
                        } finally {
                            void runDetached(
                                () => documentFiles.releaseManagedTempFileHandle?.(stagedOutput.leaseId) ?? Promise.resolve(),
                                {
                                    category: 'background-diagnostic',
                                    scope: 'workspace',
                                    message: 'Failed to release saved PDF staging lease',
                                },
                            );
                        }
                    }
                    if (opts.workingCopyOnly) {
                        const replaced = await measurePdfPersistPhase(
                            phaseTimings,
                            'native-replace-working-copy',
                            () => replaceWorkingCopyFromStagedPdfNativeMutation!(
                                workingPath,
                                stagedOutput,
                                revisionOptions,
                            ),
                        );
                        return replaced
                            ? {
                                applied: true,
                                validation: {
                                    isValid: true,
                                    tool: 'native' as const,
                                    errors: [],
                                    warnings: [],
                                },
                                nativeMutationPostconditionsVerified: true,
                                ...(materializedIdentityBindings.length > 0
                                    ? {identityBindings: materializedIdentityBindings}
                                    : {}),
                            }
                            : {
                                applied: false,
                                validation: null,
                            };
                    }
                    const committed = await measurePdfPersistPhase(
                        phaseTimings,
                        'native-commit',
                        () => commitStagedPdfNativeMutations(
                            workingPath,
                            stagedOutput,
                            createNativeStagedCommitOptions(
                                expectedDocumentRevisionToken,
                                mutations,
                                materializedIdentityBindings,
                            ),
                        ),
                    );
                    if (!committed.applied || !committed.validation?.isValid) {
                        return committed;
                    }
                    const committedIdentityBindings = validateNativeIdentityBindings(
                        committed.identityBindings,
                        expectedNativeIdentityIds,
                        'Native committed identity bindings',
                    );
                    if (!haveSameNativeIdentityBindings(materializedIdentityBindings, committedIdentityBindings)) {
                        throw new Error('Native identity bindings changed between staging and commit');
                    }
                    return committed;
                },
            );
            if (stagedSaveAsResult) {
                return stagedSaveAsResult;
            }
            if (!result.applied || !result.validation?.isValid) {
                BrowserLogger.warn('workspace', 'Native PDF mutation was not applied', {
                    reason: 'native-mutation-not-applied',
                    applied: result.applied,
                    error: result.error,
                    validation: result.validation,
                });
                logRendererTimings('not-applied', {validation: result.validation});
                return {
                    ...createFailedPersistResult(opts.saveMode, false, refusedPersistFailure(
                        'native',
                        'mutation',
                        result.reason ?? (result.validation?.isValid === false ? 'validation-failed' : 'write-failed'),
                        {
                            ...(result.error ? {
                                message: result.error.message,
                                cause: result.error,
                            } : {}),
                            validation: result.validation,
                            ...(result.keptFilePath === undefined ? {} : {keptFilePath: result.keptFilePath}),
                            ...saveOutcomeFields(result),
                        },
                    )),
                    ...(result.error?.code === 'too-large' ? {nativeRefusalCode: 'too-large' as const} : {}),
                    ...stagedIdentities(),
                };
            }
            const commitWorkingPath = state.workingCopyPath.value;
            if (!commitWorkingPath || state.originalPath.value !== expectedOriginalPath) {
                BrowserLogger.debug('workspace', 'Skipped stale native PDF mutation save completion', {
                    workingPath,
                    expectedOriginalPath,
                    currentOriginalPath: state.originalPath.value,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: opts.saveMode,
                });
                logRendererTimings('stale-after-write');
                return createStalePersistResult(opts.saveMode, false);
            }
            if (commitWorkingPath !== workingPath) {
                BrowserLogger.debug('workspace', 'Using refreshed working copy after native PDF mutation save', {
                    workingPath,
                    refreshedWorkingPath: commitWorkingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: opts.saveMode,
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
                () => commitPersistedPdfState(undefined, commitWorkingPath, markClean, commitOptions),
            );
            if (!committed) {
                logRendererTimings('stale-commit');
                return createStalePersistResult(opts.saveMode, false);
            }
            state.lastSaveMode.value = opts.saveMode;
            logRendererTimings('applied');
            return {
                ...createPersistResult(true, opts.saveMode, false),
                ...(result.documentRevision ? {documentRevision: result.documentRevision} : {}),
                ...(materializedIdentityBindings.length > 0 ? {materializedIdentityBindings} : {}),
                ...(annotationDeleteEffects ? {annotationDeleteEffects} : {}),
            };
        } catch (saveError) {
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
                saveMode: opts.saveMode,
                totalMs: roundDurationMs(performance.now() - operationStart),
                phases: phaseTimings,
            });
            return {
                ...createFailedPersistResult(opts.saveMode, false, refusedPersistFailure(
                    'native',
                    'mutation',
                    'write-failed',
                    {
                        message: getErrorMessage(saveError),
                        cause: saveError,
                    },
                )),
                ...stagedIdentities(),
            };
        }
    }

    async function saveWorkingCopyAs(
        data?: Uint8Array,
        opts?: IWorkingCopyPersistOptions & {
            optimizeLossless?: boolean;
            stagedOutput?: ITypedStagedArtifact;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'save_as_rewrite';
        return runPersistOperation(requestedSaveMode, true, async (workingPath, markClean) => {
            const revisionOptions = resolveDocumentMutationRevisionOptions(opts);
            const previousWorkingPath = workingPath;
            const saveAsOptions = {
                ...(opts?.optimizeLossless === true ? {optimizeLossless: true} : {}),
                ...(opts?.stagedOutput ? {stagedOutput: opts.stagedOutput} : {}),
            };
            const savedPath = await getDocumentFilesCapability().savePdfAs(
                workingPath,
                Object.keys(saveAsOptions).length > 0 ? saveAsOptions : undefined,
                revisionOptions,
            );
            try {
                if (!state.isActiveWorkingCopy(previousWorkingPath)) {
                    return createStalePersistResult(requestedSaveMode, true);
                }
                if (savedPath) {
                    let savedWorkingPath = previousWorkingPath;
                    if (shouldRefreshWorkingCopyAfterSaveAs(savedPath, previousWorkingPath)) {
                        const nextWorkingPath =
                            await getDocumentWorkingCopyCapability().createWorkingCopyFromPath(savedPath);
                        try {
                            data ??= (await deps.readPdfStateFromPath(nextWorkingPath)).pdfData ?? undefined;
                            if (!state.isActiveWorkingCopy(previousWorkingPath)) return createStalePersistResult(requestedSaveMode, true);
                            state.workingCopyPath.value = nextWorkingPath;
                        } finally {
                            if (!state.isActiveWorkingCopy(nextWorkingPath)) {
                                void runDetached(() => getDocumentWorkingCopyCapability().cleanupFile(nextWorkingPath), {
                                    category: 'background-diagnostic',
                                    scope: 'workspace',
                                    message: 'Failed to cleanup unadopted saved working copy',
                                });
                            }
                        }
                        savedWorkingPath = nextWorkingPath;
                    }
                    state.originalPath.value = savedPath;
                    state.requiresSaveAsOnFirstSave.value = false;
                    if (!await commitPersistedPdfState(data, savedWorkingPath, markClean, shouldRefreshWorkingCopyAfterSaveAs(savedPath, previousWorkingPath) ? {
                        preserveLoadedSource: opts?.preserveLoadedSource === true && state.pdfSrc.value instanceof Blob,
                        preserveConformanceProfile: opts?.preserveLoadedSource === true && state.pdfSrc.value instanceof Blob,
                    } : undefined)) {
                        return createStalePersistResult(requestedSaveMode, true);
                    }
                    state.lastSaveMode.value = requestedSaveMode;
                    return createPersistResult(true, requestedSaveMode, true, savedPath);
                }
                return createCancelledPersistResult(requestedSaveMode);
            } finally {
                if (savedPath && (state.workingCopyPath.value !== previousWorkingPath
                    || shouldRefreshWorkingCopyAfterSaveAs(savedPath, previousWorkingPath))) {
                    void runDetached(
                        () => getDocumentWorkingCopyCapability().cleanupFile(previousWorkingPath),
                        {
                            category: 'background-diagnostic',
                            scope: 'workspace',
                            message: 'Failed to cleanup previous saved working copy',
                        },
                    );
                }
            }
        }, opts?.expectedWorkingPath);
    }

    return {
        persistPdfDataSilently,
        repairWorkingCopy,
        optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy,
        saveWorkingCopy,
        saveWorkingCopyAs,
        trySavePdfNativeMutations,
    };
}
