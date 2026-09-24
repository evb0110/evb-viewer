export interface IDocumentViewportIdentity {
    readonly documentId: string;
    readonly revision: string;
    readonly provisional?: boolean;
}

export type TDocumentViewportLifecycle = 'empty' | 'opening' | 'transitioning'
    | 'ready' | 'closing' | 'failed';

export interface IDocumentViewportRenderFence {
    readonly generation: number;
    readonly revision: string;
    readonly pageNumber: number;
    readonly viewportIntentId: string;
    readonly renderVersion: number;
    readonly requestId: number;
}

export interface IDocumentViewportCommitFence {
    readonly generation: number;
    readonly revision: string;
    readonly pageNumber: number;
    readonly viewportIntentId: string;
    readonly geometryRevision: number;
    readonly interactionEpoch: number;
}

export interface IDocumentViewportIntent {
    readonly generation: number;
    readonly id: string;
    readonly pageNumber: number | null;
}

export interface IDocumentViewportSkeletonDelay {
    readonly generation: number;
    readonly token: string;
    readonly pageNumber: number;
    readonly deadline: number;
}

export type TDocumentViewportVisualOwner =
    | { readonly kind: 'empty' }
    | {
        readonly kind: 'page';
        readonly generation: number;
        readonly pageNumber: number;
        readonly presentation: 'cold-shell' | 'skeleton' | 'canvas' | 'error';
        readonly error: string | null;
    }
    | {
        readonly kind: 'failed';
        readonly generation: number;
        readonly error: string;
    };

export interface IDocumentViewportSessionState {
    readonly generation: number;
    readonly identity: IDocumentViewportIdentity | null;
    readonly lifecycle: TDocumentViewportLifecycle;
    /** Resolved paint target of the shared request; bounded once metadata arrives. */
    readonly requestedPage: number;
    /** Page whose canvas and physical placement have joined. */
    readonly committedPage: number | null;
    /** Physical page, retained while a new destination is pending or painting. */
    readonly observedPage: number | null;
    readonly pageCount: number | null;
    readonly visual: TDocumentViewportVisualOwner;
    /** Presentation fence derived from the ticket; retained for repaint after arrival. */
    readonly viewportIntent: IDocumentViewportIntent | null;
    readonly renderFence: IDocumentViewportRenderFence | null;
    /** Canvas commit for the active intent; promoted only when its viewport also commits. */
    readonly stagedRenderFence: IDocumentViewportRenderFence | null;
    /** Viewport commit for the active intent; promoted only when its canvas also commits. */
    readonly stagedViewportFence: IDocumentViewportCommitFence | null;
    readonly committedRenderFence: IDocumentViewportRenderFence | null;
    readonly committedViewportFence: IDocumentViewportCommitFence | null;
    readonly skeletonDelay: IDocumentViewportSkeletonDelay | null;
    readonly failure: string | null;
}

export type TDocumentViewportSessionEvent =
    | {
        readonly type: 'open-requested';
        readonly identity: IDocumentViewportIdentity;
        readonly viewportIntentId: string;
        readonly initialPage?: number;
        readonly skeletonDelay?: {
            readonly token: string;
            readonly deadline: number
        };
    }
    | {
        readonly type: 'identity-refined';
        readonly generation: number;
        readonly identity: IDocumentViewportIdentity;
    }
    | {
        readonly type: 'revision-swapped';
        readonly generation: number;
        readonly identity: IDocumentViewportIdentity;
        readonly pageNumber: number;
        readonly viewportIntentId: string;
    }
    | {
        readonly type: 'metadata-ready';
        readonly generation: number;
        readonly pageCount: number
    }
    | {
        readonly type: 'navigation-requested';
        readonly pageNumber: number | null;
        readonly viewportIntentId: string;
        readonly skeletonDelay?: {
            readonly token: string;
            readonly deadline: number
        };
    }
    | {
        readonly type: 'navigation-resolved';
        readonly generation: number;
        readonly viewportIntentId: string;
        readonly pageNumber: number;
    }
    | {
        readonly type: 'resident-visual-invalidated';
        readonly generation: number;
        readonly pageNumber: number
    }
    | {
        readonly type: 'page-observed';
        readonly generation: number;
        readonly pageNumber: number;
    }
    | {
        readonly type: 'navigation-superseded-by-user';
        readonly generation: number;
        readonly pageNumber: number;
    }
    | {
        readonly type: 'render-started';
        readonly fence: IDocumentViewportRenderFence
    }
    | {
        readonly type: 'canvas-committed';
        readonly fence: IDocumentViewportRenderFence
    }
    | {
        readonly type: 'viewport-committed';
        readonly fence: IDocumentViewportCommitFence
    }
    | {
        readonly type: 'visual-ready';
        readonly fence: IDocumentViewportRenderFence
    }
    | {
        readonly type: 'skeleton-delay-elapsed';
        readonly generation: number;
        readonly token: string;
    }
    | {
        readonly type: 'page-failed';
        readonly fence: IDocumentViewportRenderFence;
        readonly error: string
    }
    | {
        readonly type: 'page-transition-failed';
        readonly generation: number;
        readonly pageNumber: number;
        readonly viewportIntentId: string;
        readonly error: string;
    }
    | {
        readonly type: 'open-failed';
        readonly generation: number;
        readonly error: string
    }
    | { readonly type: 'close-requested' }
    | {
        readonly type: 'close-committed';
        readonly generation: number
    };

export type TDocumentViewportSessionEffect = {
    readonly type: 'schedule-skeleton-delay';
    readonly generation: number;
    readonly pageNumber: number;
    readonly token: string;
    readonly deadline: number;
}
    | {
        readonly type: 'cancel-skeleton-delay';
        readonly token: string
    };

export interface IDocumentViewportSessionTransition {
    readonly state: IDocumentViewportSessionState;
    readonly effects: readonly TDocumentViewportSessionEffect[];
    readonly accepted: boolean;
}

function isPositivePage(value: number) {
    return Number.isSafeInteger(value) && value >= 1;
}

export function canOpenRecentDocument(state: IDocumentViewportSessionState) {
    return state.lifecycle === 'empty' && state.identity === null && state.visual.kind === 'empty';
}

export function collectDocumentViewportSessionInvariantViolations(
    state: IDocumentViewportSessionState,
) {
    const violations: string[] = [];
    const add = (condition: boolean, message: string) => {
        if (!condition) violations.push(message);
    };

    add(Number.isSafeInteger(state.generation) && state.generation >= 0, 'generation must be non-negative');
    add(isPositivePage(state.requestedPage), 'requestedPage must be positive');
    add(state.committedPage === null || isPositivePage(state.committedPage), 'committedPage must be positive');
    add(state.observedPage === null || isPositivePage(state.observedPage), 'observedPage must be positive');
    add(state.pageCount === null || isPositivePage(state.pageCount), 'pageCount must be positive');
    if (state.pageCount !== null) {
        add(state.requestedPage <= state.pageCount, 'requestedPage must be clamped after metadata');
        add(state.committedPage === null || state.committedPage <= state.pageCount, 'committedPage exceeds pageCount');
        add(state.observedPage === null || state.observedPage <= state.pageCount, 'observedPage exceeds pageCount');
    }

    if (state.lifecycle === 'empty') {
        add(state.identity === null, 'empty session cannot have identity');
        add(state.visual.kind === 'empty', 'empty session must have the empty visual owner');
        add(state.viewportIntent === null, 'empty session cannot have viewport intent');
        add(state.renderFence === null, 'empty session cannot have render fence');
        add(state.stagedRenderFence === null, 'empty session cannot have staged render fence');
        add(state.stagedViewportFence === null, 'empty session cannot have staged viewport fence');
        add(state.skeletonDelay === null, 'empty session cannot have skeleton delay');
        add(state.observedPage === null, 'empty session cannot have observed page');
    } else {
        add(state.identity !== null, 'non-empty session must have identity');
        add(state.visual.kind !== 'empty', 'non-empty session must have a visual owner');
    }

    if (state.visual.kind !== 'empty') {
        add(state.visual.generation === state.generation, 'visual owner generation is stale');
    }
    if (state.visual.kind === 'page') {
        add(isPositivePage(state.visual.pageNumber), 'page visual must own a positive page');
        add(state.visual.presentation === 'error' || state.visual.error === null, 'non-error page visual has error');
        add(state.visual.presentation !== 'error' || state.visual.error !== null, 'error page visual lacks error');
    }
    if (state.identity && state.viewportIntent) {
        add(state.viewportIntent.generation === state.generation, 'viewport intent generation is stale');
        add(state.viewportIntent.pageNumber === null || state.viewportIntent.pageNumber === state.requestedPage, 'viewport intent must target requestedPage');
    }
    for (const fence of [
        state.renderFence,
        state.stagedRenderFence,
        state.committedRenderFence,
    ]) {
        if (!fence || !state.identity) continue;
        add(fence.generation === state.generation, 'render fence generation is stale');
        add(fence.revision === state.identity.revision, 'render fence revision is stale');
    }
    if (state.stagedViewportFence && state.identity) {
        add(state.stagedViewportFence.generation === state.generation, 'staged viewport fence generation is stale');
        add(state.stagedViewportFence.revision === state.identity.revision, 'staged viewport fence revision is stale');
    }
    if (state.committedViewportFence && state.identity) {
        add(state.committedViewportFence.generation === state.generation, 'viewport fence generation is stale');
        add(state.committedViewportFence.revision === state.identity.revision, 'viewport fence revision is stale');
    }
    if (state.skeletonDelay) {
        add(state.skeletonDelay.generation === state.generation, 'skeleton delay generation is stale');
        add(
            state.visual.kind === 'page' && state.visual.presentation !== 'canvas',
            'skeleton delay requires a not-ready page visual',
        );
        add(state.skeletonDelay.pageNumber === state.requestedPage, 'skeleton delay page is stale');
    }
    if (state.lifecycle === 'ready') {
        add(state.visual.kind === 'page' && state.visual.presentation === 'canvas', 'ready session must own canvas');
        add(state.committedPage !== null, 'ready session must have committed page');
        add(state.committedRenderFence?.pageNumber === state.committedPage, 'ready render fence page mismatch');
        add(state.committedViewportFence?.pageNumber === state.committedPage, 'ready viewport fence page mismatch');
    }
    return violations;
}

export function assertDocumentViewportSessionInvariants(state: IDocumentViewportSessionState) {
    const violations = collectDocumentViewportSessionInvariantViolations(state);
    if (violations.length > 0) {
        throw new Error(`Invalid document viewport session: ${violations.join('; ')}`);
    }
    return state;
}

export function createEmptyDocumentViewportSession(
    generation = 0,
): IDocumentViewportSessionState {
    return assertDocumentViewportSessionInvariants({
        generation,
        identity: null,
        lifecycle: 'empty',
        requestedPage: 1,
        committedPage: null,
        observedPage: null,
        pageCount: null,
        visual: {kind: 'empty'},
        viewportIntent: null,
        renderFence: null,
        stagedRenderFence: null,
        stagedViewportFence: null,
        committedRenderFence: null,
        committedViewportFence: null,
        skeletonDelay: null,
        failure: null,
    });
}

function clampPage(pageNumber: number, pageCount: number | null) {
    return pageCount === null ? pageNumber : Math.min(pageCount, pageNumber);
}

export function resolveDocumentViewportCurrentPage(state: IDocumentViewportSessionState) {
    return state.observedPage ?? state.committedPage ?? 1;
}

function reject(state: IDocumentViewportSessionState): IDocumentViewportSessionTransition {
    return {
        state,
        effects: [],
        accepted: false,
    };
}

function accept(
    state: IDocumentViewportSessionState,
    effects: readonly TDocumentViewportSessionEffect[] = [],
): IDocumentViewportSessionTransition {
    return {
        state: assertDocumentViewportSessionInvariants(state),
        effects,
        accepted: true,
    };
}

function sameIdentityRevision(identity: IDocumentViewportIdentity | null, revision: string) {
    return identity?.revision === revision;
}

function renderFenceMatches(left: IDocumentViewportRenderFence, right: IDocumentViewportRenderFence) {
    return left.generation === right.generation
        && left.revision === right.revision
        && left.pageNumber === right.pageNumber
        && left.viewportIntentId === right.viewportIntentId
        && left.renderVersion === right.renderVersion
        && left.requestId === right.requestId;
}

function fenceTargetsCurrentIntent(
    state: IDocumentViewportSessionState,
    fence: IDocumentViewportRenderFence | IDocumentViewportCommitFence,
) {
    return fence.generation === state.generation
        && sameIdentityRevision(state.identity, fence.revision)
        && state.viewportIntent?.pageNumber !== null
        && fence.pageNumber === state.requestedPage
        && fence.viewportIntentId === state.viewportIntent?.id;
}

function settleIfComplete(state: IDocumentViewportSessionState) {
    const render = state.stagedRenderFence;
    const viewport = state.stagedViewportFence;
    if (
        !render
        || !viewport
        || !fenceTargetsCurrentIntent(state, render)
        || !fenceTargetsCurrentIntent(state, viewport)
        || render.pageNumber !== viewport.pageNumber
    ) {
        return state;
    }
    return {
        ...state,
        lifecycle: state.lifecycle === 'failed' ? 'opening' as const : state.lifecycle,
        committedPage: render.pageNumber,
        observedPage: null,
        stagedRenderFence: null,
        stagedViewportFence: null,
        committedRenderFence: render,
        committedViewportFence: viewport,
        visual: {
            kind: 'page' as const,
            generation: state.generation,
            pageNumber: render.pageNumber,
            presentation: 'canvas' as const,
            error: null,
        },
        skeletonDelay: null,
        failure: null,
    };
}

function openRequested(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'open-requested'}>,
) {
    if (
        event.identity.documentId.length === 0
        || event.identity.revision.length === 0
        || event.viewportIntentId.length === 0
        || (event.skeletonDelay && (
            event.skeletonDelay.token.length === 0
            || !Number.isFinite(event.skeletonDelay.deadline)
        ))
    ) {
        return reject(state);
    }
    const initialPage = event.initialPage ?? 1;
    if (!isPositivePage(initialPage)) {
        return reject(state);
    }

    const generation = state.generation + 1;
    const requestedPage = initialPage;
    const next: IDocumentViewportSessionState = {
        generation,
        identity: {...event.identity},
        lifecycle: 'opening',
        requestedPage,
        committedPage: null,
        observedPage: null,
        pageCount: null,
        visual: {
            kind: 'page',
            generation,
            pageNumber: requestedPage,
            presentation: 'cold-shell',
            error: null,
        },
        viewportIntent: {
            generation,
            id: event.viewportIntentId,
            pageNumber: requestedPage,
        },
        renderFence: null,
        stagedRenderFence: null,
        stagedViewportFence: null,
        committedRenderFence: null,
        committedViewportFence: null,
        skeletonDelay: event.skeletonDelay ? {
            generation,
            token: event.skeletonDelay.token,
            pageNumber: requestedPage,
            deadline: event.skeletonDelay.deadline,
        } : null,
        failure: null,
    };
    const effects: TDocumentViewportSessionEffect[] = [];
    if (state.skeletonDelay) effects.push({
        type: 'cancel-skeleton-delay',
        token: state.skeletonDelay.token,
    });
    if (event.skeletonDelay) effects.push({
        type: 'schedule-skeleton-delay',
        generation,
        pageNumber: requestedPage,
        token: event.skeletonDelay.token,
        deadline: event.skeletonDelay.deadline,
    });
    return accept(next, effects);
}

function metadataReady(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'metadata-ready'}>,
) {
    if (event.generation !== state.generation || !isPositivePage(event.pageCount) || !state.identity) {
        return reject(state);
    }
    const requestedPage = clampPage(state.requestedPage, event.pageCount);
    const committedPageInvalidated = state.committedPage !== null
        && state.committedPage > event.pageCount;
    const viewportIntent = state.viewportIntent && {
        ...state.viewportIntent,
        pageNumber: state.viewportIntent.pageNumber === null ? null : requestedPage,
    };
    let visual = state.visual;
    const skeletonDelay = state.skeletonDelay && {
        ...state.skeletonDelay,
        pageNumber: requestedPage,
    };
    if (visual.kind === 'page' && visual.presentation !== 'canvas') {
        visual = {
            ...visual,
            pageNumber: requestedPage,
        };
    }
    if (committedPageInvalidated && state.lifecycle === 'ready') {
        visual = {
            kind: 'page',
            generation: state.generation,
            pageNumber: requestedPage,
            presentation: 'skeleton',
            error: null,
        };
    }
    const next: IDocumentViewportSessionState = {
        ...state,
        lifecycle: committedPageInvalidated && state.lifecycle === 'ready'
            ? 'transitioning'
            : state.lifecycle,
        requestedPage,
        observedPage: committedPageInvalidated
            ? null
            : state.observedPage === null
                ? null
                : clampPage(state.observedPage, event.pageCount),
        pageCount: event.pageCount,
        visual,
        viewportIntent,
        renderFence: committedPageInvalidated ? null : state.renderFence,
        stagedRenderFence: committedPageInvalidated ? null : state.stagedRenderFence,
        stagedViewportFence: committedPageInvalidated ? null : state.stagedViewportFence,
        committedPage: committedPageInvalidated ? null : state.committedPage,
        committedRenderFence: committedPageInvalidated ? null : state.committedRenderFence,
        committedViewportFence: committedPageInvalidated ? null : state.committedViewportFence,
        skeletonDelay,
    };
    return accept(next);
}

function navigationRequested(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'navigation-requested'}>,
) {
    if (
        !state.identity
        || state.lifecycle === 'closing'
        || state.lifecycle === 'failed' && state.visual.kind !== 'page'
        || event.pageNumber !== null && !isPositivePage(event.pageNumber)
        || event.viewportIntentId.length === 0
        || (event.skeletonDelay && (
            event.skeletonDelay.token.length === 0
            || !Number.isFinite(event.skeletonDelay.deadline)
        ))
    ) {
        return reject(state);
    }
    const pageNumber = event.pageNumber === null ? state.requestedPage : clampPage(event.pageNumber, state.pageCount);
    const effects: TDocumentViewportSessionEffect[] = [];
    if (state.skeletonDelay) effects.push({
        type: 'cancel-skeleton-delay',
        token: state.skeletonDelay.token,
    });
    // The delay spares a quick navigation from a skeleton flash. Once a
    // transition already shows the skeleton, the next command keeps it, and a
    // command that lands while the delay is running keeps its deadline: rapid
    // Next/Previous otherwise alternated between skeleton and bare page, or
    // never showed the skeleton at all.
    const isNavigationTransition = state.lifecycle === 'transitioning';
    const continuesSkeleton = isNavigationTransition
        && state.visual.kind === 'page'
        && state.visual.presentation === 'skeleton';
    const pendingDeadline = isNavigationTransition && state.skeletonDelay?.generation === state.generation
        ? state.skeletonDelay.deadline
        : null;
    const skeletonDelay = event.skeletonDelay && !continuesSkeleton
        ? {
            token: event.skeletonDelay.token,
            deadline: pendingDeadline === null
                ? event.skeletonDelay.deadline
                : Math.min(pendingDeadline, event.skeletonDelay.deadline),
        }
        : null;
    const visual: TDocumentViewportVisualOwner = {
        kind: 'page',
        generation: state.generation,
        pageNumber,
        presentation: skeletonDelay ? 'cold-shell' : 'skeleton',
        error: null,
    };
    const next: IDocumentViewportSessionState = {
        ...state,
        lifecycle: state.lifecycle === 'opening' ? 'opening' : 'transitioning',
        requestedPage: pageNumber,
        observedPage: state.observedPage,
        visual,
        viewportIntent: {
            generation: state.generation,
            id: event.viewportIntentId,
            pageNumber: event.pageNumber === null ? null : pageNumber,
        },
        renderFence: null,
        stagedRenderFence: null,
        stagedViewportFence: null,
        // Retain the previous committed canvas/viewport as the recovery point
        // when real user input supersedes this command before its target has
        // settled. Target matching keeps these fences from completing the new
        // navigation intent.
        committedRenderFence: state.committedRenderFence,
        committedViewportFence: state.committedViewportFence,
        skeletonDelay: skeletonDelay ? {
            generation: state.generation,
            token: skeletonDelay.token,
            pageNumber,
            deadline: skeletonDelay.deadline,
        } : null,
        failure: null,
    };
    if (skeletonDelay) {
        effects.push({
            type: 'schedule-skeleton-delay',
            generation: state.generation,
            pageNumber,
            token: skeletonDelay.token,
            deadline: skeletonDelay.deadline,
        });
    }
    return accept(next, effects);
}

function revisionSwapped(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'revision-swapped'}>,
) {
    if (
        state.lifecycle !== 'ready'
        || !state.identity
        || state.identity.documentId !== event.identity.documentId
        || event.identity.revision.length === 0
        || event.generation !== state.generation
        || !isPositivePage(event.pageNumber)
        || event.pageNumber > (state.pageCount ?? Number.MAX_SAFE_INTEGER)
        || event.viewportIntentId.length === 0
    ) {
        return reject(state);
    }
    const rebaseRenderFence = (fence: IDocumentViewportRenderFence | null) => fence === null
        ? null
        : {
            ...fence,
            revision: event.identity.revision,
            pageNumber: event.pageNumber,
            viewportIntentId: event.viewportIntentId,
        };
    const rebaseViewportFence = (fence: IDocumentViewportCommitFence | null) => fence === null
        ? null
        : {
            ...fence,
            revision: event.identity.revision,
            pageNumber: event.pageNumber,
            viewportIntentId: event.viewportIntentId,
        };
    const committedRenderFence = rebaseRenderFence(state.committedRenderFence);
    const committedViewportFence = rebaseViewportFence(state.committedViewportFence);
    if (
        state.committedPage === null
        || committedRenderFence?.pageNumber !== event.pageNumber
        || committedViewportFence?.pageNumber !== event.pageNumber
    ) {
        return reject(state);
    }
    return accept({
        ...state,
        identity: {...event.identity},
        // Keep the last committed page authoritative while the replacement
        // document and its affected raster are prepared offscreen.
        lifecycle: 'ready',
        requestedPage: event.pageNumber,
        committedPage: event.pageNumber,
        observedPage: event.pageNumber,
        visual: {
            kind: 'page',
            generation: state.generation,
            pageNumber: event.pageNumber,
            presentation: 'canvas',
            error: null,
        },
        viewportIntent: {
            generation: state.generation,
            id: event.viewportIntentId,
            pageNumber: event.pageNumber,
        },
        renderFence: null,
        stagedRenderFence: null,
        stagedViewportFence: null,
        committedRenderFence,
        committedViewportFence,
        skeletonDelay: null,
        failure: null,
    });
}

function reduceCommit(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'canvas-committed' | 'viewport-committed'}>,
) {
    if (!fenceTargetsCurrentIntent(state, event.fence)) {
        return reject(state);
    }
    if (event.type === 'canvas-committed') {
        if (!state.renderFence || !renderFenceMatches(state.renderFence, event.fence)) {
            return reject(state);
        }
        const effects = state.skeletonDelay
            ? [{
                type: 'cancel-skeleton-delay' as const,
                token: state.skeletonDelay.token,
            }]
            : [];
        const next = state.lifecycle === 'ready' ? {
            ...state,
            committedRenderFence: event.fence,
            stagedRenderFence: null,
            skeletonDelay: null,
        } : settleIfComplete({
            ...state,
            stagedRenderFence: event.fence,
            skeletonDelay: null,
        });
        return accept(next, effects);
    }
    if (state.lifecycle === 'ready') {
        return accept({
            ...state,
            committedViewportFence: event.fence,
            stagedViewportFence: null,
            observedPage: event.fence.pageNumber,
        });
    }
    return accept(settleIfComplete({
        ...state,
        stagedViewportFence: event.fence,
        observedPage: event.fence.pageNumber,
    }));
}

export function reduceDocumentViewportSession(
    state: IDocumentViewportSessionState,
    event: TDocumentViewportSessionEvent,
): IDocumentViewportSessionTransition {
    switch (event.type) {
        case 'open-requested':
            return openRequested(state, event);
        case 'identity-refined':
            if (
                event.generation !== state.generation
                || !state.identity
                || event.identity.documentId !== state.identity.documentId
                || event.identity.revision.length === 0
                || state.committedRenderFence !== null
                || state.committedViewportFence !== null
                || state.stagedRenderFence !== null
                || state.stagedViewportFence !== null
            ) {
                return reject(state);
            }
            return accept({
                ...state,
                identity: {...event.identity},
                renderFence: null,
            });
        case 'revision-swapped':
            return revisionSwapped(state, event);
        case 'metadata-ready':
            return metadataReady(state, event);
        case 'navigation-requested':
            return navigationRequested(state, event);
        case 'navigation-resolved': {
            if (event.generation !== state.generation
                || event.viewportIntentId !== state.viewportIntent?.id
                || state.viewportIntent.pageNumber !== null
                || !isPositivePage(event.pageNumber)) return reject(state);
            const pageNumber = clampPage(event.pageNumber, state.pageCount);
            return accept({
                ...state,
                requestedPage: pageNumber,
                viewportIntent: {
                    ...state.viewportIntent,
                    pageNumber,
                },
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber,
                    presentation: 'skeleton',
                    error: null,
                },
                skeletonDelay: state.skeletonDelay && {
                    ...state.skeletonDelay,
                    pageNumber,
                },
            });
        }
        case 'resident-visual-invalidated':
            if (event.generation !== state.generation || state.lifecycle !== 'ready'
                || state.committedPage !== event.pageNumber) return reject(state);
            return accept({
                ...state,
                lifecycle: 'transitioning',
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: event.pageNumber,
                    presentation: 'skeleton',
                    error: null,
                },
                renderFence: null,
                stagedRenderFence: null,
                stagedViewportFence: state.committedViewportFence,
            });
        case 'page-observed':
            if (
                event.generation !== state.generation
                || state.lifecycle === 'closing'
                || !state.identity
                || !isPositivePage(event.pageNumber)
            ) {
                return reject(state);
            }
            return accept({
                ...state,
                observedPage: clampPage(event.pageNumber, state.pageCount),
            });
        case 'navigation-superseded-by-user': {
            const committedPage = state.committedPage;
            const committedRenderFence = state.committedRenderFence;
            const committedViewportFence = state.committedViewportFence;
            if (
                event.generation !== state.generation
                || state.lifecycle !== 'transitioning'
                || !state.identity
                || !isPositivePage(event.pageNumber)
                || committedPage === null
                || committedRenderFence?.pageNumber !== committedPage
                || committedViewportFence?.pageNumber !== committedPage
            ) {
                return reject(state);
            }
            const effects = state.skeletonDelay ? [{
                type: 'cancel-skeleton-delay' as const,
                token: state.skeletonDelay.token,
            }] : [];
            return accept({
                ...state,
                lifecycle: 'ready',
                requestedPage: committedPage,
                observedPage: clampPage(event.pageNumber, state.pageCount),
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: committedPage,
                    presentation: 'canvas',
                    error: null,
                },
                viewportIntent: {
                    generation: state.generation,
                    id: committedViewportFence.viewportIntentId,
                    pageNumber: committedPage,
                },
                renderFence: null,
                stagedRenderFence: null,
                stagedViewportFence: null,
                skeletonDelay: null,
                failure: null,
            }, effects);
        }
        case 'render-started':
            if (!fenceTargetsCurrentIntent(state, event.fence)) {
                return reject(state);
            }
            return accept({
                ...state,
                renderFence: event.fence,
            });
        case 'canvas-committed':
        case 'viewport-committed':
            return reduceCommit(state, event);
        case 'visual-ready':
            if (
                ![
                    'opening',
                    'transitioning',
                ].includes(state.lifecycle)
                || !fenceTargetsCurrentIntent(state, event.fence)
                || state.committedPage !== event.fence.pageNumber
                || state.committedRenderFence === null
                || !renderFenceMatches(state.committedRenderFence, event.fence)
                || state.committedViewportFence?.pageNumber !== event.fence.pageNumber
                || state.visual.kind !== 'page'
                || state.visual.pageNumber !== event.fence.pageNumber
                || state.visual.presentation !== 'canvas'
            ) {
                return reject(state);
            }
            return accept({
                ...state,
                lifecycle: 'ready',
            });
        case 'skeleton-delay-elapsed': {
            const delay = state.skeletonDelay;
            if (!delay || delay.generation !== event.generation || delay.token !== event.token) {
                return reject(state);
            }
            return accept({
                ...state,
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: state.requestedPage,
                    presentation: 'skeleton',
                    error: null,
                },
                skeletonDelay: null,
            });
        }
        case 'page-failed':
            if (!state.renderFence || !renderFenceMatches(state.renderFence, event.fence)) {
                return reject(state);
            }
            return accept({
                ...state,
                lifecycle: 'failed',
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: event.fence.pageNumber,
                    presentation: 'error',
                    error: event.error,
                },
                skeletonDelay: null,
                failure: event.error,
            }, state.skeletonDelay ? [{
                type: 'cancel-skeleton-delay',
                token: state.skeletonDelay.token,
            }] : []);
        case 'page-transition-failed':
            if (
                event.generation !== state.generation
                || event.pageNumber !== state.requestedPage
                || event.viewportIntentId !== state.viewportIntent?.id
                || state.lifecycle === 'ready'
                || state.lifecycle === 'empty'
                || state.lifecycle === 'closing'
            ) {
                return reject(state);
            }
            return accept({
                ...state,
                lifecycle: 'failed',
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: event.pageNumber,
                    presentation: 'error',
                    error: event.error,
                },
                renderFence: null,
                skeletonDelay: null,
                failure: event.error,
            }, state.skeletonDelay ? [{
                type: 'cancel-skeleton-delay',
                token: state.skeletonDelay.token,
            }] : []);
        case 'open-failed':
            if (event.generation !== state.generation || !state.identity) {
                return reject(state);
            }
            return accept({
                ...state,
                lifecycle: 'failed',
                observedPage: null,
                visual: {
                    kind: 'failed',
                    generation: state.generation,
                    error: event.error,
                },
                renderFence: null,
                skeletonDelay: null,
                failure: event.error,
            });
        case 'close-requested': {
            if (state.lifecycle === 'empty' || state.lifecycle === 'closing') {
                return reject(state);
            }
            const effects: TDocumentViewportSessionEffect[] = [];
            if (state.skeletonDelay) effects.push({
                type: 'cancel-skeleton-delay',
                token: state.skeletonDelay.token,
            });
            return accept({
                ...state,
                lifecycle: 'closing',
                observedPage: null,
                renderFence: null,
                skeletonDelay: null,
            }, effects);
        }
        case 'close-committed':
            if (state.lifecycle !== 'closing' || event.generation !== state.generation) {
                return reject(state);
            }
            return accept(createEmptyDocumentViewportSession(state.generation));
    }
}
