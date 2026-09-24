import {
    createPageNavigationRequest,
    type IDocumentNavigationRequest,
    type IDocumentNavigationTicket,
    type TDocumentNavigationOutcome,
} from '@app/modules/document-viewer/navigation/documentNavigationRequest';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type {
    IDocumentOpenSurfaceIdentity,
    IDocumentOpenSurfaceRenderFence,
    IDocumentOpenSurfaceRenderOwner,
    IDocumentOpenSurfaceSession,
    IDocumentOpenSurfaceSnapshot,
    TDocumentOpenSurfacePhase,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSessionContract';
import {createDocumentOpenSurfaceDiagnostics} from '@app/modules/document-viewer/runtime/createDocumentOpenSurfaceDiagnostics';
import {
    createEmptyDocumentViewportSession,
    reduceDocumentViewportSession,
    resolveDocumentViewportCurrentPage,
    type IDocumentViewportSessionState,
    type TDocumentViewportSessionEffect,
    type TDocumentViewportSessionEvent,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceReducer';
import {
    retargetDocumentOpeningShell,
    type IDocumentOpenSurfacePageGeometry,
    type IDocumentOpenSurfaceVisualState,
    type TDocumentOpenSurfacePresentation,
    type TDocumentOpenSurfaceVisualPresentation,
} from '@app/modules/document-viewer/runtime/retargetDocumentOpeningShell';
export type {
    IDocumentOpenSurfaceIdentity,
    IDocumentOpenSurfaceRenderFence,
    IDocumentOpenSurfaceRenderOwner,
    IDocumentOpenSurfaceSession,
    IDocumentOpenSurfaceSnapshot,
    IDocumentOpenSurfaceViewportCommit,
    TDocumentOpenSurfacePhase,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSessionContract';
export type {
    IDocumentViewportCommitFence,
    IDocumentViewportIdentity,
    IDocumentViewportIntent,
    IDocumentViewportRenderFence,
    IDocumentViewportSessionState,
    IDocumentViewportSessionTransition,
    IDocumentViewportSkeletonDelay,
    TDocumentViewportLifecycle,
    TDocumentViewportSessionEffect,
    TDocumentViewportSessionEvent,
    TDocumentViewportVisualOwner,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceReducer';
export {
    assertDocumentViewportSessionInvariants,
    canOpenRecentDocument,
    collectDocumentViewportSessionInvariantViolations,
    createEmptyDocumentViewportSession,
    reduceDocumentViewportSession,
    resolveDocumentViewportCurrentPage,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceReducer';
export type {
    IDocumentOpenSurfaceGeometry,
    IDocumentOpenSurfacePageFrame,
    IDocumentOpenSurfacePageGeometry,
    TDocumentOpenSurfacePresentation,
} from '@app/modules/document-viewer/runtime/retargetDocumentOpeningShell';
export type { IDocumentOpenSurfaceDiagnosticEntry } from '@app/modules/document-viewer/runtime/createDocumentOpenSurfaceDiagnostics';
export { shouldProjectDocumentViewportScroll } from '@app/modules/document-viewer/runtime/shouldProjectDocumentViewportScroll';

export function resolveDocumentOpenSurfaceViewportPolicy(snapshot: IDocumentOpenSurfaceSnapshot) {
    const isTransitioning = snapshot.phase === 'pending'
        || snapshot.phase === 'geometry-committed'
        || snapshot.phase === 'canvas-committed'
        || snapshot.phase === 'viewport-committed';
    return {
        overflow: isTransitioning ? 'hidden' : 'auto',
        scrollbarGutter: 'stable',
        committedMargin: snapshot.geometry?.margin ?? null,
    } as const;
}

const idleVisualState = (): IDocumentOpenSurfaceVisualState => ({
    presentation: 'idle',
    geometry: null,
    openingPageGeometry: null,
    openingPageFrame: null,
    committedViewportPosition: null,
});

function isFinitePositive(value: number) {
    return Number.isFinite(value) && value > 0;
}

function normalizeOpeningPageGeometry(
    geometry: IDocumentOpenSurfacePageGeometry | null | undefined,
) {
    if (
        !geometry
        || geometry.documentId.length === 0
        || !Number.isSafeInteger(geometry.pageNumber) || geometry.pageNumber < 1
        || !Number.isSafeInteger(geometry.pageCount) || geometry.pageCount < geometry.pageNumber
        || !isFinitePositive(geometry.width)
        || !isFinitePositive(geometry.height)
        || ![
            0,
            90,
            180,
            270,
        ].includes(geometry.rotation)
    ) {
        return null;
    }
    return Object.freeze({...geometry});
}

function fencesMatch(left: IDocumentOpenSurfaceRenderFence, right: IDocumentOpenSurfaceRenderFence) {
    return left.generation === right.generation
        && left.documentRevision === right.documentRevision
        && left.viewportIntentId === right.viewportIntentId
        && left.renderVersion === right.renderVersion
        && left.requestId === right.requestId
        && left.pageNumber === right.pageNumber;
}

function viewportRenderFenceMatches(
    fence: IDocumentOpenSurfaceRenderFence,
    viewportFence: IDocumentViewportSessionState['renderFence'],
) {
    return viewportFence !== null
        && viewportFence.revision === fence.documentRevision
        && viewportFence.viewportIntentId === fence.viewportIntentId
        && viewportFence.renderVersion === fence.renderVersion
        && viewportFence.requestId === fence.requestId
        && viewportFence.pageNumber === fence.pageNumber;
}

function isTransitionPhase(phase: TDocumentOpenSurfacePhase) {
    return phase === 'pending'
        || phase === 'geometry-committed'
        || phase === 'canvas-committed'
        || phase === 'viewport-committed';
}

export function hasCommittedDocumentOpeningLayout(snapshot: IDocumentOpenSurfaceSnapshot) {
    return isTransitionPhase(snapshot.phase)
        && snapshot.openingPageGeometry !== null
        && snapshot.openingPageFrame !== null
        && snapshot.openingPageFrame.generation === snapshot.generation
        && snapshot.openingPageFrame.pageNumber === snapshot.openingPageGeometry.pageNumber;
}

function resolveOpeningPresentation(
    snapshot: IDocumentOpenSurfaceSnapshot,
): TDocumentOpenSurfaceVisualPresentation {
    const hasMeasuredOwnedFrame = isTransitionPhase(snapshot.phase)
        && snapshot.geometry !== null
        && snapshot.openingPageFrame?.generation === snapshot.generation;
    if (hasCommittedDocumentOpeningLayout(snapshot) || hasMeasuredOwnedFrame) {
        return 'page-shell';
    }
    return snapshot.presentation === 'failed' ? 'idle' : snapshot.presentation;
}

export function isDocumentOpenEmptySurfaceTransition(snapshot: IDocumentOpenSurfaceSnapshot) {
    return isTransitionPhase(snapshot.phase);
}

export function shouldPresentDocumentOpenEmptyPlaceholder(snapshot: IDocumentOpenSurfaceSnapshot) {
    return snapshot.presentation === 'idle';
}

function canAcceptSameGenerationVisualCommit(snapshot: IDocumentOpenSurfaceSnapshot) {
    return isTransitionPhase(snapshot.phase) || snapshot.phase === 'failed';
}

function projectDocumentOpenSurfaceSnapshot(
    visual: IDocumentOpenSurfaceVisualState,
    viewport: IDocumentViewportSessionState,
    revisionSwapPending: boolean,
): IDocumentOpenSurfaceSnapshot {
    const identity = viewport.identity === null
        ? null
        : {
            documentId: viewport.identity.documentId,
            documentRevision: viewport.identity.revision,
            ...(viewport.identity.provisional ? {provisional: true} : {}),
        };
    const projectedRenderFence = viewport.stagedRenderFence ?? viewport.committedRenderFence;
    const committedRender = projectedRenderFence === null
        ? null
        : {
            generation: viewport.generation,
            documentRevision: projectedRenderFence.revision,
            viewportIntentId: projectedRenderFence.viewportIntentId,
            renderVersion: projectedRenderFence.renderVersion,
            requestId: projectedRenderFence.requestId,
            pageNumber: projectedRenderFence.pageNumber,
        };
    const viewportFence = viewport.stagedViewportFence ?? viewport.committedViewportFence;
    const position = visual.committedViewportPosition;
    const committedViewport = viewportFence !== null
        && position?.viewportIntentId === viewportFence.viewportIntentId
        ? {
            generation: viewport.generation,
            documentRevision: viewportFence.revision,
            viewportIntentId: viewportFence.viewportIntentId,
            documentGeometryRevision: viewportFence.geometryRevision,
            interactionEpoch: viewportFence.interactionEpoch,
            pageNumber: viewportFence.pageNumber,
            left: position.left,
            top: position.top,
        }
        : null;
    const phase: TDocumentOpenSurfacePhase = viewport.lifecycle === 'empty'
        ? 'idle'
        : viewport.lifecycle === 'failed'
            ? 'failed'
            : visual.presentation === 'committed'
                ? 'ready'
                : committedRender !== null && committedViewport !== null
                    ? 'viewport-committed'
                    : committedRender !== null
                        ? 'canvas-committed'
                        : visual.geometry !== null
                            ? 'geometry-committed'
                            : 'pending';
    const presentation: TDocumentOpenSurfacePresentation = phase === 'idle'
        ? 'idle'
        : phase === 'failed'
            ? 'failed'
            : visual.presentation;
    return {
        generation: viewport.generation,
        identity,
        revisionSwapPending,
        phase,
        presentation,
        geometry: visual.geometry,
        openingPageGeometry: visual.openingPageGeometry,
        openingPageFrame: visual.openingPageFrame,
        committedRender,
        committedViewport,
        failure: viewport.failure,
    };
}
export function createDocumentOpenSurfaceSession(): IDocumentOpenSurfaceSession {
    const sessionState = shallowRef({
        ticket: null as IDocumentNavigationTicket | null,
        viewport: createEmptyDocumentViewportSession(),
        visual: idleVisualState(),
    });
    const revisionSwap = shallowRef<{
        generation: number;
        documentRevision: string;
        invalidatedPages: readonly number[];
    } | null>(null);
    const navigationTicket = computed(() => sessionState.value.ticket);
    const receipts = new WeakMap<AbortSignal, {
        controller: AbortController;
        finish: (outcome: TDocumentNavigationOutcome) => void;
    }>();
    function makeTicket(request: IDocumentNavigationRequest, generation: number, documentRevision: string, id: string) {
        const controller = new AbortController();
        let finish!: (outcome: TDocumentNavigationOutcome) => void;
        const finished = new Promise<TDocumentNavigationOutcome>(resolve => { finish = resolve; });
        const ticket: IDocumentNavigationTicket = Object.freeze({
            generation,
            documentRevision,
            id,
            request: Object.freeze({
                ...request,
                target: Object.freeze({...request.target}),
            }),
            signal: controller.signal,
            finished,
        });
        receipts.set(ticket.signal, {
            controller,
            finish,
        });
        return ticket;
    }
    function retire(ticket: IDocumentNavigationTicket | null, outcome: TDocumentNavigationOutcome) {
        if (!ticket) return;
        const receipt = receipts.get(ticket.signal);
        if (!receipt) return;
        receipts.delete(ticket.signal);
        receipt.finish(outcome);
        receipt.controller.abort(outcome);
    }
    function isNavigationCurrent(ticket: IDocumentNavigationTicket) {
        const current = sessionState.value;
        const activeTicket = current.ticket;
        return !ticket.signal.aborted
            && activeTicket?.signal === ticket.signal
            && activeTicket.generation === ticket.generation
            && current.viewport.generation === activeTicket.generation
            && current.viewport.identity?.revision === activeTicket.documentRevision;
    }
    const viewportSession = computed(() => sessionState.value.viewport);
    const snapshot = computed(() => projectDocumentOpenSurfaceSnapshot(
        sessionState.value.visual,
        sessionState.value.viewport,
        revisionSwap.value !== null,
    ));
    const skeletonTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let nextViewportIntent = 0;
    let nextRenderOwnerVersion = 0;
    const renderOwnerStates = new WeakMap<IDocumentOpenSurfaceRenderOwner, {
        latestRendererVersion: number;
        latestRendererRequestId: number;
        nextSurfaceRequestId: number;
    }>();
    const ownedRenderFences = new WeakMap<IDocumentOpenSurfaceRenderFence, IDocumentOpenSurfaceRenderOwner>();
    const openingSkeletonDelayMs = 120;
    const diagnostics = createDocumentOpenSurfaceDiagnostics(() => ({
        snapshot: snapshot.value,
        viewport: sessionState.value.viewport,
    }));
    function cancelSkeletonTimer(token: string) {
        const timer = skeletonTimers.get(token);
        if (timer === undefined) {
            return;
        }
        clearTimeout(timer);
        skeletonTimers.delete(token);
    }
    function applyViewportEffect(effect: TDocumentViewportSessionEffect) {
        if (effect.type === 'cancel-skeleton-delay') {
            cancelSkeletonTimer(effect.token);
            return;
        }
        if (sessionState.value.viewport.skeletonDelay?.token !== effect.token) return;
        cancelSkeletonTimer(effect.token);
        const timer = setTimeout(() => {
            skeletonTimers.delete(effect.token);
            dispatchViewport({
                type: 'skeleton-delay-elapsed',
                generation: effect.generation,
                token: effect.token,
            });
        }, Math.max(0, effect.deadline - Date.now()));
        skeletonTimers.set(effect.token, timer);
    }
    function transitionViewport(
        events: readonly TDocumentViewportSessionEvent[],
        updateVisual?: (
            current: IDocumentOpenSurfaceVisualState,
            viewport: IDocumentViewportSessionState,
        ) => IDocumentOpenSurfaceVisualState,
        nextTicket?: IDocumentNavigationTicket | null,
    ) {
        let viewport = sessionState.value.viewport;
        const effects: TDocumentViewportSessionEffect[] = [];
        for (const event of events) {
            const transition = reduceDocumentViewportSession(viewport, event);
            if (!transition.accepted) {
                diagnostics.record(event.type, false, 'viewport-reducer-rejected');
                return false;
            }
            viewport = transition.state;
            effects.push(...transition.effects);
        }
        const previousTicket = sessionState.value.ticket;
        let publishedTicket = viewport.lifecycle === 'failed' ? null
            : nextTicket === undefined ? previousTicket : nextTicket;
        // Metadata may bound a restore requested before the page count existed.
        // Refinement keeps the receipt and ordering identity; it is not another command.
        if (publishedTicket && viewport.pageCount !== null && publishedTicket.request.target.kind !== 'named-dest'
            && publishedTicket.request.target.page > viewport.pageCount) {
            publishedTicket = Object.freeze({
                ...publishedTicket,
                request: Object.freeze({
                    ...publishedTicket.request,
                    target: Object.freeze({
                        ...publishedTicket.request.target,
                        page: viewport.pageCount,
                    }),
                }),
            });
        }
        sessionState.value = {
            ticket: publishedTicket,
            viewport,
            visual: updateVisual?.(sessionState.value.visual, viewport) ?? sessionState.value.visual,
        };
        if (previousTicket?.signal !== publishedTicket?.signal) {
            retire(previousTicket, viewport.lifecycle === 'failed'
                ? {
                    kind: 'failed',
                    reason: viewport.failure ?? 'render-failed',
                }
                : viewport.identity === null || viewport.generation !== previousTicket?.generation
                    ? {kind: 'document-ended'} : {
                        kind: 'superseded',
                        by: 'command',
                    });
        }
        for (const effect of effects) applyViewportEffect(effect);
        for (const event of events) diagnostics.record(event.type, true);
        return true;
    }

    function dispatchViewport(
        event: TDocumentViewportSessionEvent,
        updateVisual?: (
            current: IDocumentOpenSurfaceVisualState,
            viewport: IDocumentViewportSessionState,
        ) => IDocumentOpenSurfaceVisualState,
        nextTicket?: IDocumentNavigationTicket | null,
    ) {
        return transitionViewport([event], updateVisual, nextTicket);
    }

    function commitVisual(
        update: (current: IDocumentOpenSurfaceVisualState) => IDocumentOpenSurfaceVisualState,
    ) {
        sessionState.value = {
            ...sessionState.value,
            viewport: sessionState.value.viewport,
            visual: update(sessionState.value.visual),
        };
    }

    function createViewportIntentId(prefix: string) {
        nextViewportIntent += 1;
        return `${prefix}:${String(nextViewportIntent)}`;
    }

    function beginViewportSession(
        identity: IDocumentOpenSurfaceIdentity,
        openingPageGeometry: IDocumentOpenSurfacePageGeometry | null,
        updateVisual?: (
            current: IDocumentOpenSurfaceVisualState,
            viewport: IDocumentViewportSessionState,
        ) => IDocumentOpenSurfaceVisualState,
        initialPage = openingPageGeometry?.pageNumber ?? 1,
    ) {
        revisionSwap.value = null;
        const id = createViewportIntentId('open');
        const ticket = makeTicket(createPageNavigationRequest(initialPage, 'restore'),
            sessionState.value.viewport.generation + 1, identity.documentRevision, id);
        const opened = dispatchViewport({
            type: 'open-requested',
            identity: {
                documentId: identity.documentId,
                revision: identity.documentRevision,
                ...(identity.provisional ? {provisional: true} : {}),
            },
            viewportIntentId: id,
            initialPage: Math.max(1, Math.trunc(initialPage)),
            skeletonDelay: {
                token: createViewportIntentId('skeleton'),
                deadline: Date.now() + openingSkeletonDelayMs,
            },
        }, updateVisual, ticket);
        logPdfRenderTrace('viewport-session-open-requested', {
            documentId: identity.documentId,
            opened,
            requestedPage: sessionState.value.viewport.requestedPage,
        });
        return opened;
    }

    function navigate(request: IDocumentNavigationRequest, skeletonDelayMs = 120) {
        const state = sessionState.value.viewport;
        if (!state.identity || state.lifecycle === 'closing'
            || state.lifecycle === 'failed' && state.visual.kind !== 'page') return null;
        const page = request.target.kind === 'named-dest' ? null : request.target.page;
        if (page !== null && (!Number.isSafeInteger(page) || page < 1)) return null;
        const id = createViewportIntentId('navigation');
        const ticket = makeTicket(request, state.generation, state.identity.revision, id);
        const token = createViewportIntentId('skeleton');
        const accepted = dispatchViewport({
            type: 'navigation-requested',
            pageNumber: page,
            viewportIntentId: id,
            ...(skeletonDelayMs > 0 ? {skeletonDelay: {
                token,
                deadline: Date.now() + skeletonDelayMs,
            }} : {}),
        }, page !== null && shouldRetargetOwnedOpeningPageShell(page)
            ? visual => retargetDocumentOpeningShell(visual, page) : undefined, ticket);
        if (!accepted) retire(ticket, {
            kind: 'failed',
            reason: 'navigation-rejected',
        });
        return accepted ? sessionState.value.ticket?.signal === ticket.signal ? sessionState.value.ticket : ticket : null;
    }

    function isCurrentFence(fence: IDocumentOpenSurfaceRenderFence) {
        const current = snapshot.value;
        return current.identity !== null
            && current.generation === fence.generation
            && current.identity.documentRevision === fence.documentRevision
            && (canAcceptSameGenerationVisualCommit(current) || current.phase === 'ready');
    }

    function createRenderFence(
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId'>,
    ): IDocumentOpenSurfaceRenderFence | null {
        const current = snapshot.value;
        const viewportState = sessionState.value.viewport;
        const viewportIntentId = viewportState.viewportIntent?.id;
        if (
            current.identity === null
            || !canAcceptSameGenerationVisualCommit(current) && current.phase !== 'ready'
            || input.generation !== current.generation
            || input.documentRevision !== current.identity.documentRevision
            || viewportIntentId === undefined
        ) {
            return null;
        }
        const fence = Object.freeze({
            ...input,
            viewportIntentId,
        });
        const accepted = dispatchViewport({
            type: 'render-started',
            fence: {
                generation: viewportState.generation,
                revision: input.documentRevision,
                pageNumber: input.pageNumber,
                viewportIntentId,
                renderVersion: input.renderVersion,
                requestId: input.requestId,
            },
        });
        return accepted ? fence : null;
    }

    function createRenderOwnerFence(
        owner: IDocumentOpenSurfaceRenderOwner,
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId' | 'renderVersion' | 'requestId'>,
    ) {
        const state = renderOwnerStates.get(owner);
        if (!state || owner.renderVersion !== nextRenderOwnerVersion) {
            return null;
        }
        state.nextSurfaceRequestId += 1;
        const fence = createRenderFence({
            ...input,
            renderVersion: owner.renderVersion,
            requestId: state.nextSurfaceRequestId,
        });
        if (fence) {
            ownedRenderFences.set(fence, owner);
        }
        return fence;
    }

    function shouldRetargetOwnedOpeningPageShell(pageNumber: number) {
        const current = snapshot.value;
        const geometry = current.openingPageGeometry;
        const frame = current.openingPageFrame;
        if (
            !isTransitionPhase(current.phase)
            || geometry === null
            || frame === null
            || frame.generation !== current.generation
            || geometry.pageNumber === pageNumber
        ) {
            return false;
        }
        return true;
    }

    function markReady(fence: IDocumentOpenSurfaceRenderFence) {
        const viewportState = sessionState.value.viewport;
        if (viewportState.lifecycle === 'ready') {
            const committed = snapshot.value.committedRender;
            return committed !== null && fencesMatch(committed, fence)
                && viewportState.committedPage === fence.pageNumber;
        }
        const committed = snapshot.value.committedRender;
        const viewport = snapshot.value.committedViewport;
        if (
            ![
                'opening',
                'transitioning',
            ].includes(viewportState.lifecycle)
            || !committed
            || !viewport
            || !isCurrentFence(fence)
            || !fencesMatch(committed, fence)
            || viewport.pageNumber !== fence.pageNumber
        ) {
            diagnostics.reportRejected('mark-ready', 'render-or-viewport-fence-mismatch', {
                fence,
                committed,
                viewport,
            });
            return false;
        }
        const markedReady = dispatchViewport({
            type: 'visual-ready',
            fence: {
                generation: viewportState.generation,
                revision: fence.documentRevision,
                pageNumber: fence.pageNumber,
                viewportIntentId: fence.viewportIntentId,
                renderVersion: fence.renderVersion,
                requestId: fence.requestId,
            },
        }, visual => ({
            ...visual,
            openingPageFrame: null,
            presentation: 'committed',
        }));
        return markedReady;
    }

    return {
        navigationTicket,
        navigate,
        isNavigationCurrent,
        reportNavigation(ticket, report) {
            if (!isNavigationCurrent(ticket)) return false;
            const state = sessionState.value.viewport;
            const activeTicket = sessionState.value.ticket;
            if (!activeTicket || activeTicket.signal !== ticket.signal) return false;
            if (report.kind === 'resolved') return dispatchViewport({
                type: 'navigation-resolved',
                generation: activeTicket.generation,
                viewportIntentId: activeTicket.id,
                pageNumber: report.page,
            });
            if (report.kind === 'placed') return this.commitViewport({
                generation: activeTicket.generation,
                documentRevision: activeTicket.documentRevision,
                viewportIntentId: activeTicket.id,
                pageNumber: report.page,
                documentGeometryRevision: report.geometryRevision,
                interactionEpoch: report.interactionEpoch,
                left: report.left,
                top: report.top,
            }) && isNavigationCurrent(ticket);
            if (report.kind === 'arrived') {
                const placement = state.stagedViewportFence ?? state.committedViewportFence;
                if (state.requestedPage !== report.page || placement?.viewportIntentId !== ticket.id
                    || placement.pageNumber !== report.page) return false;
                const openingPlacementReady = (state.lifecycle === 'opening'
                    || state.lifecycle === 'transitioning')
                    && (state.stagedRenderFence?.pageNumber === report.page
                        || state.committedRenderFence?.pageNumber === report.page)
                    && state.stagedViewportFence?.pageNumber === report.page;
                if (
                    ticket.request.readiness !== 'metrics'
                    && state.lifecycle !== 'ready'
                    && !openingPlacementReady
                ) return false;
            }
            if (report.kind === 'failed') this.failPageTransition(state.requestedPage, report.reason);
            if (report.kind === 'abandoned') {
                dispatchViewport({
                    type: 'navigation-superseded-by-user',
                    generation: ticket.generation,
                    pageNumber: resolveDocumentViewportCurrentPage(state),
                }, visual => ({
                    ...visual,
                    presentation: 'committed',
                }));
            }
            // Publication can synchronously issue another command; retire only our receipt.
            if (sessionState.value.ticket?.signal === ticket.signal) {
                sessionState.value = {
                    ...sessionState.value,
                    ticket: null,
                };
            }
            retire(ticket, report.kind === 'arrived' ? report
                : report.kind === 'failed' ? report : {
                    kind: 'superseded',
                    by: report.by,
                });
            return true;
        },
        snapshot: readonly(snapshot),
        viewportSession,
        getDiagnosticHistory: diagnostics.getHistory,
        begin(identity, openingPageGeometry = null, initialPage) {
            const normalizedOpeningPageGeometry = normalizeOpeningPageGeometry(openingPageGeometry);
            const identityOwnedOpeningPageGeometry = normalizedOpeningPageGeometry?.documentId === identity.documentId
                ? normalizedOpeningPageGeometry
                : null;
            const normalizedInitialPage = initialPage === undefined
                ? identityOwnedOpeningPageGeometry?.pageNumber ?? 1
                : Math.max(1, Math.trunc(initialPage));
            const ownedOpeningPageGeometry = (
                identityOwnedOpeningPageGeometry?.pageNumber === normalizedInitialPage
            )
                ? identityOwnedOpeningPageGeometry
                : null;
            beginViewportSession(identity, ownedOpeningPageGeometry, () => ({
                // The transaction phase transfers center-surface ownership away
                // from the empty placeholder immediately. Presentation remains
                // idle until real page geometry can establish the page shell.
                presentation: 'idle',
                geometry: null,
                openingPageGeometry: ownedOpeningPageGeometry,
                openingPageFrame: null,
                committedViewportPosition: null,
            }), normalizedInitialPage);
            return sessionState.value.viewport.generation;
        },
        commitOpeningPageGeometry(generation, geometry) {
            const current = snapshot.value;
            const normalizedGeometry = normalizeOpeningPageGeometry(geometry);
            if (
                current.generation !== generation
                || !isTransitionPhase(current.phase)
                || normalizedGeometry === null
                || normalizedGeometry.documentId !== current.identity?.documentId
            ) {
                return false;
            }
            return dispatchViewport({
                type: 'metadata-ready',
                generation: sessionState.value.viewport.generation,
                pageCount: normalizedGeometry.pageCount,
            }, visual => ({
                ...visual,
                openingPageGeometry: normalizedGeometry,
                presentation: resolveOpeningPresentation({
                    ...current,
                    openingPageGeometry: normalizedGeometry,
                }),
            }));
        },
        prepareRevisionSwap(identity, pageNumber, invalidatedPages) {
            const current = snapshot.value;
            if (
                current.phase !== 'ready'
                || current.geometry === null
                || current.identity?.documentId !== identity.documentId
                || identity.documentRevision.length === 0
                || !Number.isSafeInteger(pageNumber)
                || pageNumber < 1
                || invalidatedPages.length === 0
            ) {
                return false;
            }
            const normalizedPage = Math.min(
                pageNumber,
                sessionState.value.viewport.pageCount ?? Number.MAX_SAFE_INTEGER,
            );
            const intentId = createViewportIntentId('revision-swap');
            const ticket = makeTicket(
                createPageNavigationRequest(normalizedPage, 'restore'),
                current.generation,
                identity.documentRevision,
                intentId,
            );
            const accepted = dispatchViewport({
                type: 'revision-swapped',
                generation: current.generation,
                identity: {
                    documentId: identity.documentId,
                    revision: identity.documentRevision,
                },
                pageNumber: normalizedPage,
                viewportIntentId: intentId,
            }, (visual, viewport) => ({
                ...visual,
                committedViewportPosition: visual.committedViewportPosition === null
                    ? null
                    : Object.freeze({
                        ...visual.committedViewportPosition,
                        viewportIntentId: viewport.viewportIntent?.id
                            ?? visual.committedViewportPosition.viewportIntentId,
                    }),
            }), ticket);
            if (!accepted) {
                retire(ticket, {
                    kind: 'superseded',
                    by: 'command',
                });
                return false;
            }
            revisionSwap.value = {
                generation: current.generation,
                documentRevision: identity.documentRevision,
                invalidatedPages: [...new Set(invalidatedPages)],
            };
            return true;
        },
        completeRevisionSwap(generation, documentRevision) {
            if (
                revisionSwap.value?.generation !== generation
                || revisionSwap.value.documentRevision !== documentRevision
                || snapshot.value.generation !== generation
                || snapshot.value.identity?.documentRevision !== documentRevision
            ) {
                return false;
            }
            revisionSwap.value = null;
            return true;
        },
        cancelRevisionSwap(generation, documentRevision) {
            if (
                revisionSwap.value?.generation !== generation
                || revisionSwap.value.documentRevision !== documentRevision
            ) {
                return false;
            }
            revisionSwap.value = null;
            return true;
        },
        acquireSource(identity, expectedGeneration) {
            const current = snapshot.value;
            if (current.generation !== expectedGeneration) return null;
            if (current.identity === null) return this.begin(identity);
            if (current.identity.documentId !== identity.documentId) return null;
            if (current.identity.documentRevision === identity.documentRevision) {
                if (
                    revisionSwap.value?.generation === current.generation
                    && revisionSwap.value.documentRevision === identity.documentRevision
                ) {
                    return current.generation;
                }
                // A feature-pack remount has disposed the old source while the
                // shared surface still retains its ready visual. Give the new
                // owner a fresh opening transaction; reusing the ready
                // generation would make its first frame commit impossible.
                // A failed generation is equally unusable: a later ordinary
                // open must not inherit its missing geometry or failed visual.
                if (current.phase === 'ready' || current.phase === 'failed') {
                    return this.begin(identity, null, resolveDocumentViewportCurrentPage(sessionState.value.viewport));
                }
                return current.generation;
            }
            if (isTransitionPhase(current.phase)) {
                const currentIdentity = current.identity;
                const sameDocument = currentIdentity?.documentId === identity.documentId;
                const sameRevision = currentIdentity?.documentRevision === identity.documentRevision;
                if (sameDocument && sameRevision) {
                    return current.generation;
                }
                // The host establishes the visible generation with a
                // provisional open-intent revision before the feature pack
                // starts loading. Refining that same document to its canonical
                // source revision must not revoke the already-owned page shell.
                // Provisional fences remain invalid because identity matching
                // switches atomically here.
                if (
                    sameDocument
                    && currentIdentity.provisional === true
                    && current.committedRender === null
                    && current.committedViewport === null
                ) {
                    const ticket = sessionState.value.ticket;
                    const refined = dispatchViewport({
                        type: 'identity-refined',
                        generation: sessionState.value.viewport.generation,
                        identity: {
                            documentId: identity.documentId,
                            revision: identity.documentRevision,
                        },
                    }, visual => visual, ticket ? Object.freeze({
                        ...ticket,
                        documentRevision: identity.documentRevision,
                    }) : null);
                    return refined ? snapshot.value.generation : null;
                }
                // A provisional host transaction cannot be replaced by a loader that failed refinement.
                if (currentIdentity?.provisional) return null;
            }
            return this.begin(identity, null, resolveDocumentViewportCurrentPage(sessionState.value.viewport));
        },
        commitOpeningPageFrame(generation, frame) {
            const current = snapshot.value;
            if (
                current.generation !== generation
                || frame.generation !== generation
                || frame.ownerId.length === 0
                || !isTransitionPhase(current.phase)
                || !Number.isSafeInteger(frame.pageNumber)
                || frame.pageNumber < 1
                || frame.intentKey.length === 0
                || current.openingPageFrame !== null
                    && current.openingPageFrame.ownerId !== frame.ownerId
            ) {
                return false;
            }
            const next = {
                ...sessionState.value.visual,
                openingPageFrame: Object.freeze({
                    ...frame,
                    style: Object.freeze({...frame.style}),
                }),
            };
            commitVisual(() => ({
                ...next,
                presentation: resolveOpeningPresentation({
                    ...current,
                    openingPageFrame: next.openingPageFrame,
                }),
            }));
            return true;
        },
        clearOpeningPageFrame(generation, ownerId) {
            const current = snapshot.value;
            if (
                current.generation !== generation
                || current.openingPageFrame === null
                || current.openingPageFrame.ownerId !== ownerId
                // Ready/fail/reset own teardown. Removing the frame during an
                // empty transition would expose a blank/empty surface.
                || isTransitionPhase(current.phase)
            ) {
                return false;
            }
            commitVisual(visual => ({
                ...visual,
                openingPageFrame: null,
            }));
            return true;
        },
        commitGeometry(generation, geometry) {
            if (
                snapshot.value.generation !== generation
                || snapshot.value.phase !== 'pending'
                || !isFinitePositive(geometry.width)
                || !isFinitePositive(geometry.height)
                || !Number.isFinite(geometry.margin)
                || geometry.margin < 0
            ) {
                return false;
            }
            commitVisual(visual => ({
                ...visual,
                presentation: snapshot.value.openingPageFrame === null
                    ? visual.presentation
                    : 'page-shell',
                geometry: Object.freeze({...geometry}),
            }));
            return true;
        },
        claimRenderOwner() {
            const owner = Object.freeze({renderVersion: ++nextRenderOwnerVersion});
            renderOwnerStates.set(owner, {
                latestRendererVersion: Number.NEGATIVE_INFINITY,
                latestRendererRequestId: Number.NEGATIVE_INFINITY,
                nextSurfaceRequestId: 0,
            });
            return owner;
        },
        createRenderFence,
        createOwnedRenderFence(owner, input) {
            const state = renderOwnerStates.get(owner);
            if (!state) {
                return null;
            }
            const isOlderRendererRequest = input.rendererVersion < state.latestRendererVersion
                || input.rendererVersion === state.latestRendererVersion
                && input.rendererRequestId < state.latestRendererRequestId;
            if (isOlderRendererRequest) {
                return null;
            }
            state.latestRendererVersion = input.rendererVersion;
            state.latestRendererRequestId = input.rendererRequestId;
            return createRenderOwnerFence(owner, {
                generation: input.generation,
                documentRevision: input.documentRevision,
                pageNumber: input.pageNumber,
            });
        },
        createOwnedResidentRenderFence: createRenderOwnerFence,
        commitCanvas(fence) {
            const current = snapshot.value;
            const isReadyNavigation = current.phase === 'ready';
            const owner = ownedRenderFences.get(fence);
            if (owner && owner.renderVersion !== nextRenderOwnerVersion) {
                diagnostics.reportRejected('commit-canvas', 'superseded-render-owner', {fence});
                return false;
            }
            if (!isCurrentFence(fence)) {
                diagnostics.reportRejected('commit-canvas', 'stale-render-fence', {fence});
                return false;
            }
            if (!isReadyNavigation && current.geometry === null) {
                diagnostics.reportRejected('commit-canvas', 'geometry-not-committed', {fence});
                return false;
            }
            const previous = current.committedRender;
            if (
                previous
                && (
                    fence.renderVersion < previous.renderVersion
                    || fence.renderVersion === previous.renderVersion && fence.requestId < previous.requestId
                )
            ) {
                diagnostics.reportRejected('commit-canvas', 'render-fence-older-than-committed', {
                    fence,
                    previous,
                });
                return false;
            }
            const accepted = dispatchViewport({
                type: 'canvas-committed',
                fence: {
                    generation: sessionState.value.viewport.generation,
                    revision: fence.documentRevision,
                    pageNumber: fence.pageNumber,
                    viewportIntentId: fence.viewportIntentId,
                    renderVersion: fence.renderVersion,
                    requestId: fence.requestId,
                },
            });
            if (!accepted) {
                diagnostics.reportRejected('commit-canvas', 'viewport-reducer-rejected', {fence});
                return false;
            }
            return true;
        },
        commitViewport(commit) {
            const current = snapshot.value;
            const rejectionReason = current.identity === null
                ? 'missing-identity'
                : !canAcceptSameGenerationVisualCommit(current) && current.phase !== 'ready'
                    ? 'surface-not-accepting-visual-commit'
                    : commit.generation !== current.generation
                        ? 'generation-mismatch'
                        : commit.documentRevision !== current.identity.documentRevision
                            ? 'revision-mismatch'
                            : commit.viewportIntentId.length === 0
                                ? 'missing-viewport-intent'
                                : !Number.isFinite(commit.documentGeometryRevision)
                                    || !Number.isFinite(commit.interactionEpoch)
                                    || !Number.isFinite(commit.left)
                                    || !Number.isFinite(commit.top)
                                    ? 'invalid-viewport-coordinates'
                                    : null;
            if (rejectionReason !== null) {
                diagnostics.reportRejected('commit-viewport', rejectionReason, {commit});
                return false;
            }
            const accepted = dispatchViewport({
                type: 'viewport-committed',
                fence: {
                    generation: sessionState.value.viewport.generation,
                    revision: commit.documentRevision,
                    pageNumber: commit.pageNumber,
                    viewportIntentId: commit.viewportIntentId,
                    geometryRevision: commit.documentGeometryRevision,
                    interactionEpoch: commit.interactionEpoch,
                },
            }, visual => ({
                ...visual,
                committedViewportPosition: Object.freeze({
                    viewportIntentId: commit.viewportIntentId,
                    left: commit.left,
                    top: commit.top,
                }),
            }));
            if (!accepted) {
                diagnostics.reportRejected('commit-viewport', 'viewport-reducer-rejected', {commit});
            }
            return accepted;
        },
        markReady,
        reject(fence, reason) {
            if (!isCurrentFence(fence)) {
                return false;
            }
            const viewportState = sessionState.value.viewport;
            const rejectsCurrentViewportIntent = viewportRenderFenceMatches(fence, viewportState.renderFence)
                && viewportState.requestedPage === fence.pageNumber
                && viewportState.lifecycle !== 'ready';
            const committed = snapshot.value.committedRender;
            if (!rejectsCurrentViewportIntent && committed && !fencesMatch(committed, fence)) {
                return false;
            }
            if (!rejectsCurrentViewportIntent && viewportState.renderFence !== null) {
                return false;
            }
            if (!viewportState.renderFence) {
                return false;
            }
            return dispatchViewport({
                type: 'page-failed',
                fence: viewportState.renderFence,
                error: reason,
            }, visual => ({
                ...visual,
                openingPageFrame: null,
            }));
        },
        failPageTransition(pageNumber, reason) {
            const viewport = sessionState.value.viewport;
            const intent = viewport.viewportIntent;
            if (
                !intent
                || viewport.requestedPage !== pageNumber
                || viewport.lifecycle === 'ready'
            ) {
                return false;
            }
            return dispatchViewport({
                type: 'page-transition-failed',
                generation: viewport.generation,
                pageNumber,
                viewportIntentId: intent.id,
                error: reason,
            });
        },
        fail(generation, reason) {
            const current = snapshot.value;
            if (
                current.generation !== generation
                || current.phase === 'idle'
                || current.committedRender !== null
            ) {
                return false;
            }
            const failed = dispatchViewport({
                type: 'open-failed',
                generation: sessionState.value.viewport.generation,
                error: reason,
            }, visual => ({
                ...visual,
                openingPageFrame: null,
            }));
            if (failed) {
                revisionSwap.value = null;
            }
            return failed;
        },
        reset() {
            revisionSwap.value = null;
            const closingGeneration = sessionState.value.viewport.generation;
            if (!transitionViewport([
                {type: 'close-requested'},
                {
                    type: 'close-committed',
                    generation: closingGeneration,
                },
            ], () => idleVisualState(), null)) {
                commitVisual(() => idleVisualState());
            }
        },
        metadataReady(pageCount) {
            const current = sessionState.value.viewport;
            const invalidatesCommittedVisual = current.lifecycle === 'ready'
                && current.committedPage !== null
                && current.committedPage > pageCount;
            const accepted = dispatchViewport({
                type: 'metadata-ready',
                generation: sessionState.value.viewport.generation,
                pageCount,
            }, invalidatesCommittedVisual
                ? visual => ({
                    ...visual,
                    presentation: 'page-shell',
                    openingPageFrame: null,
                    committedViewportPosition: null,
                })
                : undefined);
            if (!accepted) {
                return false;
            }
            return true;
        },
        invalidateResidentVisual(pageNumber) {
            const normalized = Math.max(1, Math.trunc(pageNumber));
            const viewport = sessionState.value.viewport;
            if (
                !Number.isSafeInteger(normalized)
                || viewport.lifecycle !== 'ready'
                || viewport.requestedPage !== normalized
                || viewport.committedPage !== normalized
                || viewport.observedPage !== null && viewport.observedPage !== normalized
                || viewport.visual.kind !== 'page'
                || viewport.visual.pageNumber !== normalized
                || viewport.visual.presentation !== 'canvas'
            ) {
                return false;
            }
            return dispatchViewport({
                type: 'resident-visual-invalidated',
                generation: viewport.generation,
                pageNumber: normalized,
            });
        },
        requestNavigation(pageNumber, skeletonDelayMs = 120) {
            navigate(createPageNavigationRequest(pageNumber, 'toolbar'), skeletonDelayMs);
            return sessionState.value.viewport.requestedPage;
        },
        observeViewportPage(pageNumber, options = {}) {
            const current = sessionState.value.viewport;
            const normalized = Math.max(1, Math.trunc(pageNumber));
            if (!Number.isSafeInteger(normalized) || current.identity === null) {
                return resolveDocumentViewportCurrentPage(current);
            }
            const supersede = options.supersedeNavigation === true
                && current.lifecycle === 'transitioning';
            if (supersede) {
                const ticket = sessionState.value.ticket;
                if (ticket) {
                    dispatchViewport({
                        type: 'navigation-superseded-by-user',
                        generation: ticket.generation,
                        pageNumber: resolveDocumentViewportCurrentPage(current),
                    }, visual => ({
                        ...visual,
                        presentation: 'committed',
                    }));
                    if (sessionState.value.ticket?.signal === ticket.signal) {
                        sessionState.value = {
                            ...sessionState.value,
                            ticket: null,
                        };
                    }
                    retire(ticket, {
                        kind: 'superseded',
                        by: 'user-input',
                    });
                }
            }
            const observedPage = current.pageCount === null
                ? normalized
                : Math.min(current.pageCount, normalized);
            if (!supersede && current.observedPage === observedPage) {
                return resolveDocumentViewportCurrentPage(current);
            }
            dispatchViewport({
                type: 'page-observed',
                generation: current.generation,
                pageNumber: observedPage,
            });
            return resolveDocumentViewportCurrentPage(sessionState.value.viewport);
        },
    };
}
export const documentOpenSurfaceSessionKey = Symbol('document-open-surface-session') as InjectionKey<
    IDocumentOpenSurfaceSession
>;
export function injectDocumentOpenSurfaceSession() {
    return inject(documentOpenSurfaceSessionKey, null);
}
