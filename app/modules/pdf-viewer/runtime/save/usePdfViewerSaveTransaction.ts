import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {AnnotationEditorUIManager} from 'pdfjs-dist';
import type {
    ComputedRef,
    ShallowRef,
} from 'vue';
import type {
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {IPdfLiveAnnotationChangeSummary} from '@app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics';
import type {TPdfSaveRouteDecision} from '@app/modules/pdf-viewer/runtime/save/nativeMutationProjection';
import { buildNativePdfMutationProjection } from '@app/modules/pdf-viewer/runtime/save/nativeMutationProjection';
import type {
    IPdfSaveByteRouteDecision,
    IPdfViewerNativeRequiredFailure,
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
    IPdfViewerSaveTransactionSerializedResult,
    TNativeSaveRouteRejection,
    TPdfViewerSaveTransactionSource,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import type {
    ISerializationPlan,
    ISerializationPlanInputs,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import type {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    mapPdfAnnotationParseEntity,
    mapPdfAnnotationParseForeign,
} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';
import { isNativeDocumentRef } from '@app/utils/documentRef';
import { isPdfDocumentUsable } from '@app/utils/isPdfDocumentUsable';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import { collectNativeTextBoxMutationsForSave } from '@app/modules/pdf-viewer/runtime/save/nativeTextBoxMutations';

const SLOW_SAVE_PREPARATION_STEP_MS = 250;
const DEFAULT_TRANSACTION_SAVE_MODE = 'rewrite';
const AVAILABLE_SERIALIZATION_BACKENDS = ['native-append'] as const;
const emptyLiveAnnotationChanges: IPdfLiveAnnotationChangeSummary = {
    ids: new Set(),
    replayableEditorNoteIds: new Set(),
    nativeFreeTextEditors: new Map(),
    hasChanges: false,
    hasUnknownChanges: false,
    fingerprint: 'empty',
};

interface IUsePdfViewerSaveTransactionOptions {
    /**
     * Production sessions pass their live authorities. The callback variants
     * below remain only as narrow test/workspace-save seams.
     */
    pdfDocument?: ShallowRef<IPdfDocument | null>;
    annotationUiManager?: ShallowRef<AnnotationEditorUIManager | null>;
    annotationApplication?: ShallowRef<AnnotationApplication>;
    documentRevisionToken?: ComputedRef<TDocumentRevisionToken | null>;
    documentSession?: Pick<TPdfDocumentSession, 'captureFence' | 'isCurrent'>;
    flushAnnotationMutationsForSave?: () => Promise<unknown>;
    commitPendingEditorDraftsForSave?: () => void;
    getPdfDocument?: () => IPdfDocument | null;
    getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAllShapes?: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    ensureManagedShapeBaselineReady?: () => Promise<boolean>;
    prepareAnnotationSave?: () => {
        plan?: ISerializationPlan;
        verify(bytes: Uint8Array): Promise<void>;
        verifyPath?(path: string, knownSize: number): Promise<void>;
        assertCurrent?(): Promise<void> | void;
        replaceFromDocument?(result: IPdfAnnotationParseResult): void;
        commit(): void;
    };
}

async function waitForCommittedEditorModelsToSettle() {
    await nextTick();
}

async function waitForCommittedEditorsToRender() {
    await nextTick();
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        return;
    }
    await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
        });
    });
    await nextTick();
}

async function commitPdfEditorsForSave(
    annotationUiManager: AnnotationEditorUIManager | null,
    commitPendingEditorDraftsForSave?: () => void,
    waitForRender = false,
) {
    commitPendingEditorDraftsForSave?.();
    annotationUiManager?.commitOrRemove();
    if (waitForRender) {
        await waitForCommittedEditorsToRender();
        return;
    }
    await waitForCommittedEditorModelsToSettle();
}

/**
 * Raw PDF.js materialization remains public for the viewer expose contract,
 * but its commit/settle/current-document fence is owned by the save
 * transaction rather than a second save adapter.
 */
/**
 * Surfaces which field of which annotation failed the semantic reopen. The
 * verifier already reduced text to a length and a digest, so this record is
 * safe to log: no document text and no annotation note text reaches it.
 */

function logSaveRouteDecision(
    request: IPdfViewerSaveTransactionRequest,
    decision: TPdfSaveRouteDecision,
) {
    const {
        canonical,
        annotationPlan,
    } = decision;
    BrowserLogger.debug('workspace', 'Planned PDF annotation save route', {
        route: decision.route,
        annotationRoute: annotationPlan.route,
        expectedCost: annotationPlan.expectedCost,
        reason: annotationPlan.reason,
        nativeRejection: decision.route === 'native-append' ? null : decision.nativeRejection,
        liveAnnotationIds: Array.from(canonical.liveAnnotationChanges.ids),
        replayableLiveEditorNoteIds: Array.from(canonical.liveAnnotationChanges.replayableEditorNoteIds),
        replayableAnnotationIds: Array.from(canonical.replayableEmbeddedAnnotationIds),
        unreplayableLiveAnnotationIds: annotationPlan.unreplayableLiveAnnotationIds,
        pendingTexts: canonical.pendingTexts.size,
        pendingDeletes: canonical.pendingDeletes.length,
        forceWriterSave: request.forceWriterSave === true,
        dirtyState: request.dirtyState,
        includeManagedShapes: request.includeManagedShapes === true,
    });
}

function createSerializedResult(input: {
    request: IPdfViewerSaveTransactionRequest;
    resultSource: TPdfViewerSaveTransactionSource;
    serializedBytes: Uint8Array | null;
}): IPdfViewerSaveTransactionSerializedResult | null {
    if (!input.request.serializeResult || !input.serializedBytes) {
        return null;
    }

    return {
        finalBytes: input.serializedBytes,
        saveMode: input.request.saveMode ?? DEFAULT_TRANSACTION_SAVE_MODE,
        source: input.resultSource,
        changedObjectRefs: input.request.annotationSerializationPlan?.changedObjectRefs ?? [],
    };
}

function isNativeSaveRequired(request: IPdfViewerSaveTransactionRequest) {
    return isNativeDocumentRef(request.workingPath);
}

function nativeRequiredFailureReason(
    rejection: TNativeSaveRouteRejection,
): IPdfViewerNativeRequiredFailure['reason'] {
    if (
        rejection === 'save-descriptors-unavailable'
        || rejection === 'native-save-capability-unavailable'
        || rejection === 'native-structured-save-capability-unavailable'
    ) {
        return 'missing-native-capability';
    }
    return 'classifier-rejection';
}

function createNativeRequiredFailure(
    rejection: TNativeSaveRouteRejection,
): IPdfViewerNativeRequiredFailure {
    return {
        code: 'native-save-required',
        phase: 'pre-write',
        reason: nativeRequiredFailureReason(rejection),
        nativeRejection: rejection,
    };
}

export const usePdfViewerSaveTransaction = (
    options: IUsePdfViewerSaveTransactionOptions,
) => {
    const getPdfDocument = () => options.pdfDocument?.value ?? options.getPdfDocument?.() ?? null;
    function prepareAnnotationSave(input: {
        annotationApplication: AnnotationApplication | undefined;
        documentRevisionToken: TDocumentRevisionToken | null;
    }) {
        if (options.prepareAnnotationSave) {
            return options.prepareAnnotationSave();
        }
        const application = input.annotationApplication;
        if (!application) {
            return undefined;
        }
        const session = application.beginSave(input.documentRevisionToken);
        return {
            plan: session.plan,
            verify: () => Promise.resolve(),
            verifyPath: () => Promise.resolve(),
            assertCurrent: () => application.assertSaveCurrent(session, input.documentRevisionToken),
            commit: () => application.acknowledgeSave(session, input.documentRevisionToken),
            replaceFromDocument: (result: IPdfAnnotationParseResult) => application.store.replaceFromDocument(
                result.entities.map(entry => mapPdfAnnotationParseEntity(entry)),
                result.foreign.map(mapPdfAnnotationParseForeign),
            ),
        };
    }

    async function readSourcePdfBytes(request: IPdfViewerSaveTransactionRequest) {
        return await request.source?.getSourcePdfData() ?? null;
    }

    async function selectBaseBytes(input: {
        request: IPdfViewerSaveTransactionRequest;
        byteRoute: IPdfSaveByteRouteDecision;
    }) {
        return readSourcePdfBytes(input.request);
    }

    function serializeResultBytes(input: {
        request: IPdfViewerSaveTransactionRequest;
        baseBytes: Uint8Array | null;
    }) {
        void input.request;
        return input.baseBytes;
    }

    async function runSaveTransaction(
        initialRequest: IPdfViewerSaveTransactionRequest,
    ): Promise<IPdfViewerSaveTransactionResult> {
        const capturedTarget = {
            annotationApplication: options.annotationApplication?.value,
            pdfDocument: getPdfDocument(),
            documentRevisionToken: options.documentRevisionToken?.value ?? null,
            documentFence: options.documentSession?.captureFence(),
        };
        const staleTargetError = (message: string) => createStaleRevisionError({
            expectedRevision: capturedTarget.documentRevisionToken,
            actualRevision: options.documentRevisionToken?.value ?? null,
            message,
        });
        function assertSaveTargetCurrent() {
            if (
                options.annotationApplication
                && options.annotationApplication.value !== capturedTarget.annotationApplication
            ) {
                throw staleTargetError('Annotation application changed after the save frontier was captured');
            }
            if (
                (options.pdfDocument || options.documentSession)
                && getPdfDocument() !== capturedTarget.pdfDocument
            ) {
                throw staleTargetError('PDF document changed after the save frontier was captured');
            }
            if (capturedTarget.pdfDocument && !isPdfDocumentUsable(capturedTarget.pdfDocument)) {
                throw staleTargetError('Captured PDF document is no longer usable');
            }
            if (
                options.documentRevisionToken
                && options.documentRevisionToken.value !== capturedTarget.documentRevisionToken
            ) {
                throw staleTargetError('Document revision changed after the save frontier was captured');
            }
            if (
                options.documentSession
                && (
                    !capturedTarget.documentFence
                    || !options.documentSession.isCurrent(capturedTarget.documentFence)
                )
            ) {
                throw staleTargetError('Document open fence changed after the save frontier was captured');
            }
        }
        let request = {...initialRequest};
        if (
            request.serializeResult === true
            || request.includeManagedShapes === true
            || request.rewriteShapeState === true
            || request.forceRewrite === true
        ) {
            // An unscanned shape layer cannot be rewritten without discarding the
            // managed shapes this session never saw, so the save stays additive.
            if (await options.ensureManagedShapeBaselineReady?.() === false) {
                request = {
                    ...request,
                    rewriteShapeState: false,
                };
            }
            assertSaveTargetCurrent();
        }
        const measurePreparationStep = async <T>(phase: string, operation: () => Promise<T> | T) => {
            return measureOperationPhase(async () => operation(), durationMs => {
                if (durationMs >= SLOW_SAVE_PREPARATION_STEP_MS) {
                    BrowserLogger.warn('workspace', 'Slow PDF save preparation step', {
                        phase,
                        durationMs,
                    });
                }
            });
        };
        await measurePreparationStep(
            'flush-annotation-mutations',
            () => options.flushAnnotationMutationsForSave?.(),
        );
        assertSaveTargetCurrent();
        await measurePreparationStep(
            'commit-editor-models',
            () => commitPdfEditorsForSave(
                options.annotationUiManager?.value ?? null,
                options.commitPendingEditorDraftsForSave,
            ),
        );
        assertSaveTargetCurrent();
        const canonicalSave = prepareAnnotationSave(capturedTarget);
        // Complete the annotation frontier into the global immutable save plan
        // before route selection. From this point onward no backend is allowed to
        // sample metadata or route constraints from mutable UI state.
        const planInputs: ISerializationPlanInputs = {
            metadata: {
                pageLabels: request.documentStructure?.pageLabelsDirty
                    ? request.documentStructure.pageLabelRanges
                    : null,
                bookmarks: request.documentStructure?.bookmarksDirty
                    ? request.documentStructure.bookmarkItems
                    : null,
            },
            routeConstraints: {
                forceRewrite: request.forceRewrite === true,
                preserveLoadedSource: request.mode !== 'persist',
                allowedBackends: request.forceRewrite
                    ? ['native-append']
                    : AVAILABLE_SERIALIZATION_BACKENDS,
            },
            postconditions: {expectedPageCount: request.documentStructure?.totalPages ?? null},
        };
        const frontierPlan = canonicalSave?.plan;
        const globalSerializationPlan = frontierPlan
            ? buildSerializationPlan(frontierPlan.frontier, frontierPlan.expected, frontierPlan.entities, planInputs)
            : buildSerializationPlan({
                documentRevisionToken: null,
                epoch: 0,
                entityBaselineHash: 'no-canonical-annotation-frontier',
                revisions: new Map(),
            }, [], [], planInputs);
        request = {
            ...request,
            annotationSerializationPlan: globalSerializationPlan,
        };
        const nativeTextBoxes = await measurePreparationStep(
            'collect-native-text-box-mutations',
            () => collectNativeTextBoxMutationsForSave(getPdfDocument(), globalSerializationPlan),
        );
        assertSaveTargetCurrent();
        const canonicalSaveCallbacks = {
            verifyAnnotationSave: async (bytes: Uint8Array) => {
                assertSaveTargetCurrent();
                await canonicalSave?.verify(bytes);
                assertSaveTargetCurrent();
            },
            verifyAnnotationSavePath: async (path: string, knownSize: number) => {
                assertSaveTargetCurrent();
                const verifyPath = canonicalSave?.verifyPath;
                if (!verifyPath) {
                    throw new Error('Path-backed annotation verification is unavailable');
                }
                await verifyPath(path, knownSize);
                assertSaveTargetCurrent();
            },
            commitAnnotationSave: () => {
                // Persistence may legitimately advance the document revision and
                // open fence. The frozen store frontier still performs semantic
                // CAS. If a successful Save As/reload retired this application,
                // its old frontier has no live authority left to acknowledge.
                if (
                    options.annotationApplication
                    && options.annotationApplication.value !== capturedTarget.annotationApplication
                ) {
                    return;
                }
                canonicalSave?.commit();
            },
            assertAnnotationSaveCurrent: async () => {
                assertSaveTargetCurrent();
                try {
                    await canonicalSave?.assertCurrent?.();
                } catch (error) {
                    if (error instanceof Error && error.message.includes('staleRevisionError')) {
                        throw staleTargetError(error.message.replace(/^staleRevisionError:\s*/u, ''));
                    }
                    throw error;
                }
                assertSaveTargetCurrent();
            },
            ...(canonicalSave?.replaceFromDocument
                ? {replaceFromDocument: canonicalSave.replaceFromDocument}
                : {}),
        };
        // Routing is decided exactly once, here; every projector below consumes the result.
        const decision: TPdfSaveRouteDecision = buildNativePdfMutationProjection(globalSerializationPlan, {
            saveFlowMode: request.saveFlowMode ?? 'save',
            availableBackends: AVAILABLE_SERIALIZATION_BACKENDS,
            nativeCapabilities: request.nativeCapabilities,
            dirtyState: request.dirtyState,
            documentStructure: request.documentStructure,
            liveAnnotationChanges: emptyLiveAnnotationChanges,
            hasLoadedSource: Boolean(request.source),
            forceWriterSave: request.forceWriterSave === true,
            rewriteShapeState: request.rewriteShapeState !== false,
            totalPageCount: Math.max(
                request.documentStructure?.totalPages ?? 0,
                getPdfDocument()?.numPages ?? 0,
            ),
            shapes: request.dirtyState?.shapeStateDirty ? options.getAllShapes?.() ?? null : null,
            deletedEmbeddedShapeAnnotationIds: request.dirtyState?.shapeStateDirty
                ? options.getDeletedEmbeddedShapeAnnotationIds?.() ?? []
                : [],
            deletedEmbeddedShapeStableKeys: request.dirtyState?.shapeStateDirty
                ? options.getDeletedEmbeddedShapeStableKeys?.() ?? []
                : [],
            markupSubtypeOverrides: request.markupSubtypeOverrides ?? options.getMarkupSubtypeOverrides?.(),
            markupSubtypeHints: request.markupSubtypeHints ?? options.getMarkupSubtypeHints?.() ?? [],
            ...(nativeTextBoxes !== undefined ? {nativeTextBoxes} : {}),
        });
        const annotationSavePlan = decision.annotationPlan;
        logSaveRouteDecision(request, decision);
        if (isNativeSaveRequired(request) && decision.route !== 'native-append') {
            await canonicalSaveCallbacks.assertAnnotationSaveCurrent();
            return {
                source: 'native-required-failure',
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection: null,
                nativeRequiredFailure: createNativeRequiredFailure(decision.nativeRejection),
                fallbackDecision: decision,
                annotationSavePlan,
                ...canonicalSaveCallbacks,
            };
        }
        async function executeByteRoute(
            byteRoute: IPdfSaveByteRouteDecision,
            executionRequest: IPdfViewerSaveTransactionRequest = request,
        ) {
            await canonicalSaveCallbacks.assertAnnotationSaveCurrent();
            const baseBytes = await selectBaseBytes({
                request: executionRequest,
                byteRoute,
            });
            await canonicalSaveCallbacks.assertAnnotationSaveCurrent();
            const serializedBytes = serializeResultBytes({
                request: executionRequest,
                baseBytes,
            });
            await canonicalSaveCallbacks.assertAnnotationSaveCurrent();
            const resultSource: TPdfViewerSaveTransactionSource = executionRequest.source
                ? serializedBytes ? 'serialized-rewrite' : byteRoute.route
                : 'writer-save';
            const serializedResult = createSerializedResult({
                request: executionRequest,
                resultSource,
                serializedBytes,
            });

            return {
                source: resultSource,
                baseBytes: serializedBytes ? null : executionRequest.source ? baseBytes : null,
                serializedBytes: serializedResult ? null : serializedBytes,
                serializedResult,
                nativeMutationProjection: null,
                fallbackDecision: byteRoute,
                annotationSavePlan,
                ...canonicalSaveCallbacks,
            };
        }
        if (decision.route === 'native-append') {
            const nativeMutationProjection = decision.nativeMutationProjection;
            if (decision.replayableAnnotationMutationsAllowed && decision.annotationRoute.route !== 'loaded-source') {
                throw new Error(`Native annotation replay was granted on the ${decision.annotationRoute.route} route`);
            }
            if (
                !decision.replayableAnnotationMutationsAllowed
                && (
                    nativeMutationProjection.noteTextUpdates.length > 0
                    || (nativeMutationProjection.noteGeometryUpdates?.length ?? 0) > 0
                    || nativeMutationProjection.freeTextEditors.length > 0
                    || nativeMutationProjection.annotationDeletes.length > 0
                )
            ) {
                throw new Error('Native annotation mutations were projected without a loaded-source grant');
            }
            if (
                !decision.metadataMutationsAllowed
                && (nativeMutationProjection.hasMetadataMutations || nativeMutationProjection.hasShapeMutations)
            ) {
                throw new Error('Structured native mutations were projected without capability');
            }
            await canonicalSaveCallbacks.assertAnnotationSaveCurrent();
            const result: IPdfViewerSaveTransactionResult = {
                source: 'native-mutation-projection',
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection,
                fallbackDecision: decision.fallback,
                annotationSavePlan,
                ...canonicalSaveCallbacks,
            };
            if (!isNativeSaveRequired(request)) {
                const fallbackExecutionRequest = {
                    ...request,
                    planOnly: false,
                };
                let fallbackExecution: Promise<IPdfViewerSaveTransactionResult> | null = null;
                result.executeFallback = () => (
                    fallbackExecution ??= executeByteRoute(decision.fallback, fallbackExecutionRequest)
                );
            }
            return result;
        }

        const byteRoute = decision;
        if (request.planOnly) {
            await canonicalSaveCallbacks.assertAnnotationSaveCurrent();
            let fallbackExecution: Promise<IPdfViewerSaveTransactionResult> | null = null;
            return {
                source: byteRoute.route,
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection: null,
                fallbackDecision: byteRoute,
                annotationSavePlan,
                ...canonicalSaveCallbacks,
                executeFallback: () => (
                    fallbackExecution ??= executeByteRoute(byteRoute, {
                        ...request,
                        planOnly: false,
                    })
                ),
            };
        }
        return executeByteRoute(byteRoute);
    }

    return {
        commitPdfEditorsForSave: () => commitPdfEditorsForSave(
            options.annotationUiManager?.value ?? null,
            options.commitPendingEditorDraftsForSave,
        ),
        runSaveTransaction,
    };
};
