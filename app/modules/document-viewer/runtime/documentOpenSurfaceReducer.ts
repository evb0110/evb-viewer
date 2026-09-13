export interface IDocumentViewportIdentity {
    readonly documentId: string;
    readonly revision: string;
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
    readonly pageNumber: number;
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
        readonly presentation: 'cold-shell' | 'prepared-shell' | 'skeleton' | 'canvas' | 'error';
        readonly frameKey: string | null;
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
    /** Latest user intent. It is deliberately allowed to exceed an as-yet unknown page count. */
    readonly requestedPage: number;
    readonly committedPage: number | null;
    /** Semantic page currently observed in a settled, freely scrolled viewport. */
    readonly observedPage: number | null;
    readonly pageCount: number | null;
    readonly visual: TDocumentViewportVisualOwner;
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

export interface IDocumentViewportPreparedPage {
    readonly pageNumber: number;
    readonly pageCount: number;
    readonly frameKey: string;
}

export type TDocumentViewportSessionEvent =
    | {
        readonly type: 'open-requested';
        readonly identity: IDocumentViewportIdentity;
        readonly viewportIntentId: string;
        readonly initialPage?: number;
        readonly preparedPage?: IDocumentViewportPreparedPage;
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
        readonly type: 'metadata-ready';
        readonly generation: number;
        readonly pageCount: number
    }
    | {
        readonly type: 'navigation-requested';
        readonly pageNumber: number;
        readonly viewportIntentId: string;
        readonly skeletonDelay?: {
            readonly token: string;
            readonly deadline: number
        };
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
        add(state.viewportIntent.pageNumber === state.requestedPage, 'viewport intent must target requestedPage');
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
    if (state.lifecycle !== 'ready') {
        add(state.observedPage === null, 'only a ready session can own an observed page');
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
    return state.lifecycle === 'ready'
        ? state.observedPage ?? state.committedPage ?? state.requestedPage
        : state.requestedPage;
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
            frameKey: null,
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
    const prepared = event.preparedPage;
    if (prepared && (
        !isPositivePage(prepared.pageNumber)
        || !isPositivePage(prepared.pageCount)
        || prepared.pageNumber > prepared.pageCount
        || prepared.frameKey.length === 0
    )) {
        return reject(state);
    }
    const initialPage = prepared?.pageNumber ?? event.initialPage ?? 1;
    if (!isPositivePage(initialPage)) {
        return reject(state);
    }

    const generation = state.generation + 1;
    const pageCount = prepared?.pageCount ?? null;
    const requestedPage = clampPage(initialPage, pageCount);
    const next: IDocumentViewportSessionState = {
        generation,
        identity: {...event.identity},
        lifecycle: 'opening',
        requestedPage,
        committedPage: null,
        observedPage: null,
        pageCount,
        visual: {
            kind: 'page',
            generation,
            pageNumber: requestedPage,
            presentation: prepared ? 'prepared-shell' : 'cold-shell',
            frameKey: prepared?.frameKey ?? null,
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
        pageNumber: requestedPage,
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
            frameKey: null,
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
        || state.lifecycle === 'failed'
        || !isPositivePage(event.pageNumber)
        || event.viewportIntentId.length === 0
        || (event.skeletonDelay && (
            event.skeletonDelay.token.length === 0
            || !Number.isFinite(event.skeletonDelay.deadline)
        ))
    ) {
        return reject(state);
    }
    const pageNumber = clampPage(event.pageNumber, state.pageCount);
    const effects: TDocumentViewportSessionEffect[] = [];
    if (state.skeletonDelay) effects.push({
        type: 'cancel-skeleton-delay',
        token: state.skeletonDelay.token,
    });
    const visual: TDocumentViewportVisualOwner = {
        kind: 'page',
        generation: state.generation,
        pageNumber,
        presentation: event.skeletonDelay ? 'cold-shell' : 'skeleton',
        frameKey: null,
        error: null,
    };
    const next: IDocumentViewportSessionState = {
        ...state,
        lifecycle: state.lifecycle === 'opening' ? 'opening' : 'transitioning',
        requestedPage: pageNumber,
        observedPage: null,
        visual,
        viewportIntent: {
            generation: state.generation,
            id: event.viewportIntentId,
            pageNumber,
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
        skeletonDelay: event.skeletonDelay ? {
            generation: state.generation,
            token: event.skeletonDelay.token,
            pageNumber,
            deadline: event.skeletonDelay.deadline,
        } : null,
        failure: null,
    };
    if (event.skeletonDelay) {
        effects.push({
            type: 'schedule-skeleton-delay',
            generation: state.generation,
            pageNumber,
            token: event.skeletonDelay.token,
            deadline: event.skeletonDelay.deadline,
        });
    }
    return accept(next, effects);
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
        });
    }
    return accept(settleIfComplete({
        ...state,
        stagedViewportFence: event.fence,
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
        case 'metadata-ready':
            return metadataReady(state, event);
        case 'navigation-requested':
            return navigationRequested(state, event);
        case 'page-observed':
            if (
                event.generation !== state.generation
                || state.lifecycle !== 'ready'
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
                    frameKey: null,
                    error: null,
                },
                viewportIntent: null,
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
                    frameKey: null,
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
                observedPage: null,
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: event.fence.pageNumber,
                    presentation: 'error',
                    frameKey: null,
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
                    frameKey: null,
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
