import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type {
    IDocumentNavigationRequest,
    IDocumentNavigationTicket,
    TDocumentNavigationReport,
} from '@app/modules/document-viewer/public';
import type { IResolvedPdfNavigationTarget } from '@app/modules/pdf-viewer/runtime/viewport/pdfNavigationRequestResolver';

export type TPdfViewportIntentKind =
    | 'navigate' | 'user-scroll' | 'wheel-page' | 'search' | 'document-restore' | 'relayout';
type TPdfViewportPhase =
    | 'idle' | 'resolving' | 'awaiting-metrics'
    | 'applying' | 'awaiting-visual' | 'settled' | 'cancelled';

export interface IPdfViewportIntent {
    id: string;
    kind: TPdfViewportIntentKind;
    documentRevision: number;
    interactionEpoch: number;
    navigation?: IDocumentNavigationRequest;
    /**
     * The shared surface ticket that owns a navigation intent. The authority
     * keeps this only as an execution capability; it never mints or replaces
     * the ticket.
     */
    navigationTicket?: IDocumentNavigationTicket;
    /** Captured PDF proxy/load revision for this execution attempt. */
    documentContext?: {
        document: object;
        revision: number;
        page: number | null;
        resolvedTarget?: IResolvedPdfNavigationTarget | undefined;
    };
    anchor?: IPdfSemanticAnchor;
}

interface IPdfViewportResolvedCommit {
    anchor: IPdfSemanticAnchor;
    left: number;
    top: number;
}

export interface IPdfViewportPositionCommit {
    intentId: string;
    intentKind: TPdfViewportIntentKind;
    documentRevision: number;
    geometryRevision: number;
    interactionEpoch: number;
    page: number;
    left: number;
    top: number;
    navigationTicket?: IDocumentNavigationTicket;
}

/**
 * Work that moves the viewport without a placement intent of its own: a
 * reload or a search reveal. It shares the authority's single in-flight slot,
 * so a navigation supersedes it and it is never current while a navigation
 * owns the viewport.
 */
export type TPdfViewportWorkKind = 'reload' | 'search';

/** `cancelRasters` cancels the in-flight rasters of the superseded layout. */
export interface IPdfViewportWorkCancellation {cancelRasters: boolean;}

interface IPdfViewportWork {
    readonly id: number;
    readonly kind: TPdfViewportWorkKind;
    readonly page: number | null;
}

interface IViewportAuthorityDependencies {
    getDocumentRevision(): number;
    getGeometryRevision(): number;
    isIntentCurrent?(intent: IPdfViewportIntent): boolean;
    shouldStageNavigationVisual?(intent: IPdfViewportIntent): boolean;
    reportNavigation?(
        ticket: IDocumentNavigationTicket,
        report: TDocumentNavigationReport,
    ): boolean;
    resolve(intent: IPdfViewportIntent, signal: AbortSignal): Promise<IPdfViewportResolvedCommit>;
    awaitMetrics(intent: IPdfViewportIntent, signal: AbortSignal): Promise<unknown>;
    refine?(intent: IPdfViewportIntent, commit: IPdfViewportResolvedCommit, signal: AbortSignal): Promise<IPdfViewportResolvedCommit>;
    refineAfterVisual?(intent: IPdfViewportIntent, commit: IPdfViewportResolvedCommit, signal: AbortSignal): Promise<IPdfViewportResolvedCommit>;
    apply(
        intent: IPdfViewportIntent,
        commit: IPdfViewportResolvedCommit,
    ): {
        left: number;
        top: number;
    } | undefined;
    onPositionCommitted?(commit: IPdfViewportPositionCommit): void;
    awaitVisual(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    beforeApply?(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    postArrival?(request: IDocumentNavigationRequest, signal: AbortSignal): Promise<void>;
    clearDemand?(intentId: string): void;
    /** A navigation ticket accepted by the shared surface but not yet submitted here. */
    hasPendingNavigationTicket?(): boolean;
    onWorkCancelled?(cancellation: IPdfViewportWorkCancellation): void;
}

function createViewportAbortError() {
    return new DOMException('Viewport intent superseded', 'AbortError');
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Abort the authority's wait as soon as ownership ends. The dependency's
 * callback is deliberately left running: it owns its own cancellation and
 * must fence any later side effects against its captured document identity.
 */
function awaitWithAbort<T>(
    value: PromiseLike<T> | T,
    signal: AbortSignal,
) {
    const operation = Promise.resolve(value);
    if (signal.aborted) {
        void operation.then(undefined, () => undefined);
        return Promise.reject(createViewportAbortError());
    }

    let removeAbortListener = () => {};
    const abort = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(createViewportAbortError());
        signal.addEventListener('abort', onAbort, {once: true});
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
            onAbort();
        }
    });
    return Promise.race([
        operation,
        abort,
    ]).finally(removeAbortListener);
}

/**
 * Owns the one viewport operation in flight: a placement intent, or layout
 * work that moves the viewport without one. Page geometry is final for a
 * document revision, so an intent is fenced only by the document, the user's
 * interaction epoch and its own identity; it resolves against the layout at
 * the moment it applies.
 */
export function createViewportAuthority(deps: IViewportAuthorityDependencies) {
    const terminalOutcomeLimit = 128;
    const phase = ref<TPdfViewportPhase>('idle');
    const activeIntent = shallowRef<IPdfViewportIntent | null>(null);
    const committedAnchor = shallowRef<IPdfSemanticAnchor | null>(null);
    const pendingTargetPage = computed(() => {
        const intent = activeIntent.value;
        return intent?.documentContext?.page
            ?? (intent?.navigation?.target && 'page' in intent.navigation.target
                ? intent.navigation.target.page
                : null);
    });
    const currentPage = computed(() => committedAnchor.value?.page ?? 1);
    let interactionEpoch = 0;
    let controller: AbortController | null = null;
    const terminal = new Map<string, 'settled' | 'cancelled'>();
    const work = shallowRef<IPdfViewportWork | null>(null);
    let workSequence = 0;
    const ownsNavigation = computed(() => pendingTargetPage.value !== null
        || deps.hasPendingNavigationTicket?.() === true);
    const activeWorkKind = computed(() => (ownsNavigation.value ? 'navigation' as const : work.value?.kind ?? null));
    const targetPage = computed(() => pendingTargetPage.value ?? (ownsNavigation.value ? null : work.value?.page ?? null));

    function cancelWork(cancellation: IPdfViewportWorkCancellation, workId?: number) {
        if (work.value && workId !== undefined && work.value.id !== workId) {
            return;
        }
        work.value = null;
        deps.onWorkCancelled?.(cancellation);
    }

    function beginWork(kind: TPdfViewportWorkKind, page: number | null = null) {
        if (ownsNavigation.value) {
            // Work begun under a navigation is superseded from the start.
            return ++workSequence;
        }
        if (work.value) {
            cancelWork({cancelRasters: true});
        }
        work.value = {
            id: ++workSequence,
            kind,
            page,
        };
        return work.value.id;
    }

    function isWorkCurrent(workId: number) {
        return work.value?.id === workId && !ownsNavigation.value;
    }

    function settleWork(workId: number) {
        if (work.value?.id === workId) {
            work.value = null;
        }
    }

    watch(ownsNavigation, (navigating) => {
        if (navigating && work.value) {
            cancelWork({cancelRasters: true});
        }
    }, {flush: 'sync'});

    function isCurrent(intent: IPdfViewportIntent, signal: AbortSignal) {
        return !signal.aborted
            && activeIntent.value?.id === intent.id
            && intent.interactionEpoch === interactionEpoch
            && intent.documentRevision === deps.getDocumentRevision()
            && deps.isIntentCurrent?.(intent) !== false;
    }

    function assertCurrent(intent: IPdfViewportIntent, signal: AbortSignal) {
        if (!isCurrent(intent, signal)) {
            throw createViewportAbortError();
        }
    }

    function finish(intent: IPdfViewportIntent, outcome: 'settled' | 'cancelled') {
        // An older execution attempt of the same ticket can reject after its
        // replay was installed. Its ID is shared by design, so checking only
        // the ID here would terminalize and clear the live successor.
        if (activeIntent.value !== intent || terminal.has(intent.id)) {
            return;
        }
        terminal.set(intent.id, outcome);
        while (terminal.size > terminalOutcomeLimit) {
            const oldestIntentId = terminal.keys().next().value;
            if (oldestIntentId === undefined) {
                break;
            }
            terminal.delete(oldestIntentId);
        }
        deps.clearDemand?.(intent.id);
        phase.value = outcome;
        // A synchronous watcher can submit or observe a successor while the
        // terminal phase is published. Re-check before touching the
        // successor's ownership state.
        if (activeIntent.value?.id !== intent.id) {
            return;
        }
        activeIntent.value = null;
        controller = null;
    }

    function cancelActive() {
        const intent = activeIntent.value;
        if (!intent) {
            return;
        }
        controller?.abort();
        finish(intent, 'cancelled');
    }

    function commitPosition(
        intent: IPdfViewportIntent,
        commit: IPdfViewportResolvedCommit,
        applied: ReturnType<IViewportAuthorityDependencies['apply']>,
    ) {
        committedAnchor.value = commit.anchor;
        const positionCommit: IPdfViewportPositionCommit = Object.freeze({
            intentId: intent.id,
            intentKind: intent.kind,
            documentRevision: intent.documentRevision,
            geometryRevision: deps.getGeometryRevision(),
            interactionEpoch: intent.interactionEpoch,
            page: commit.anchor.page,
            left: applied?.left ?? commit.left,
            top: applied?.top ?? commit.top,
            ...(intent.navigationTicket ? {navigationTicket: intent.navigationTicket} : {}),
        });
        deps.onPositionCommitted?.(positionCommit);
        return positionCommit;
    }

    async function submit(
        intent: Omit<IPdfViewportIntent, 'interactionEpoch'> & {interactionEpoch?: number},
    ) {
        if (intent.documentRevision <= 0) {
            throw new Error('Viewport intents require a positive live document revision');
        }
        // A ticket replayed after a renderer mount keeps its semantic ID; it
        // replaces its own earlier attempt instead of cancelling a command.
        const isTicketReplay = intent.navigationTicket !== undefined && (
            (activeIntent.value?.navigationTicket === intent.navigationTicket && activeIntent.value.id === intent.id)
            || (activeIntent.value === null && terminal.get(intent.id) === 'cancelled')
        );
        if (isTicketReplay) {
            controller?.abort();
            terminal.delete(intent.id);
        } else {
            cancelActive();
        }
        const next = {
            ...intent,
            interactionEpoch: intent.interactionEpoch ?? interactionEpoch,
        };
        if (!isTicketReplay && activeIntent.value !== null) {
            finish(next, 'cancelled');
            return {
                outcome: 'cancelled' as const,
                intent: next,
                positionCommit: null,
            };
        }
        const nextController = new AbortController();
        controller = nextController;
        const {signal} = nextController;
        activeIntent.value = next;
        try {
            assertCurrent(next, signal);
            phase.value = 'awaiting-metrics';
            await awaitWithAbort(deps.awaitMetrics(next, signal), signal);
            assertCurrent(next, signal);
            phase.value = 'resolving';
            let commit = await awaitWithAbort(deps.resolve(next, signal), signal);
            assertCurrent(next, signal);
            if (deps.refine) {
                commit = await awaitWithAbort(deps.refine(next, commit, signal), signal);
                assertCurrent(next, signal);
            }
            // Established-document navigation uses place-before-raster so a
            // fast command has an owned physical destination before old pixels
            // are retired. The first opening page is different: its page
            // shell and geometry are created by the initial raster mount, so
            // staging that canvas first avoids a circular wait for geometry
            // that the canvas callback itself commits.
            const stagedNavigationVisual = next.navigation !== undefined
                && (next.navigationTicket === undefined || deps.shouldStageNavigationVisual?.(next) === true);
            let visualReadyBeforePlacement = false;
            if (stagedNavigationVisual) {
                phase.value = 'awaiting-visual';
                try {
                    await awaitWithAbort(deps.awaitVisual(next, signal), signal);
                    visualReadyBeforePlacement = true;
                } catch (error) {
                    // An aborted visual wait still places; the terminal report
                    // below remains the single owner of failure.
                    if (signal.aborted || !isAbortError(error)) throw error;
                }
                assertCurrent(next, signal);
                if (deps.refineAfterVisual) {
                    commit = await awaitWithAbort(deps.refineAfterVisual(next, commit, signal), signal);
                    assertCurrent(next, signal);
                }
            }
            // Navigation owns a semantic ticket. The measured placement is
            // published before raster readiness so the shared session can
            // transfer the shell to the requested page without a paint gate.
            // Raster readiness closes the same ticket after that placement.
            await awaitWithAbort(deps.beforeApply?.(next, signal), signal);
            assertCurrent(next, signal);
            phase.value = 'applying';
            const applied = deps.apply(next, commit);
            // `apply` may synchronously trigger a newer command or physical
            // input. Do not publish the old anchor after that change.
            assertCurrent(next, signal);
            const positionCommit = commitPosition(next, commit, applied);
            assertCurrent(next, signal);
            if (next.navigationTicket && !visualReadyBeforePlacement) {
                phase.value = 'awaiting-visual';
                // A ticket whose raster failed cannot be reported as arrived;
                // it receives `failed` below and a later mount can replay it.
                await awaitWithAbort(deps.awaitVisual(next, signal), signal);
                assertCurrent(next, signal);
                if (deps.refineAfterVisual) {
                    const refined = await awaitWithAbort(deps.refineAfterVisual(next, commit, signal), signal);
                    assertCurrent(next, signal);
                    const refinedApplied = deps.apply(next, refined);
                    assertCurrent(next, signal);
                    commitPosition(next, refined, refinedApplied);
                    assertCurrent(next, signal);
                    commit = refined;
                }
            } else if (!stagedNavigationVisual) {
                phase.value = 'awaiting-visual';
                await awaitWithAbort(deps.awaitVisual(next, signal), signal);
                assertCurrent(next, signal);
            }
            if (next.navigation && deps.postArrival) {
                await awaitWithAbort(deps.postArrival(next.navigation, signal), signal);
            }
            assertCurrent(next, signal);
            if (next.navigationTicket && deps.reportNavigation) {
                const accepted = deps.reportNavigation(next.navigationTicket, {
                    kind: 'arrived',
                    page: commit.anchor.page,
                });
                if (!accepted) {
                    assertCurrent(next, signal);
                    throw new Error('Shared navigation rejected arrival report');
                }
            }
            finish(next, 'settled');
            return {
                outcome: 'settled' as const,
                intent: next,
                positionCommit,
            };
        } catch (error) {
            if (next.navigationTicket && isCurrent(next, signal) && deps.reportNavigation) {
                deps.reportNavigation(next.navigationTicket, {
                    kind: 'failed',
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
            finish(next, 'cancelled');
            if (isAbortError(error)) {
                return {
                    outcome: 'cancelled' as const,
                    intent: next,
                    positionCommit: null,
                };
            }
            throw error;
        }
    }

    function observeUserScroll(anchor: IPdfSemanticAnchor) {
        interactionEpoch += 1;
        cancelActive();
        committedAnchor.value = anchor;
        activeIntent.value = null;
        phase.value = 'idle';
    }

    function commitSettledPosition(input: Omit<
        IPdfViewportPositionCommit,
        'interactionEpoch'
    > & {anchor?: IPdfSemanticAnchor | undefined}) {
        if (
            activeIntent.value !== null
            || input.documentRevision !== deps.getDocumentRevision()
            || input.geometryRevision !== deps.getGeometryRevision()
        ) {
            return null;
        }
        const {
            anchor,
            ...position
        } = input;
        const commit = Object.freeze({
            ...position,
            interactionEpoch,
        });
        if (anchor) {
            committedAnchor.value = anchor;
        }
        deps.onPositionCommitted?.(commit);
        return commit;
    }

    function dispose() {
        cancelActive();
        activeIntent.value = null;
        controller = null;
    }

    return {
        phase: readonly(phase),
        activeIntent: readonly(activeIntent),
        committedAnchor: readonly(committedAnchor),
        pendingTargetPage,
        currentPage,
        submit,
        commitSettledPosition,
        observeUserScroll,
        suspend: cancelActive,
        dispose,
        activeWorkKind,
        targetPage,
        beginWork,
        isWorkCurrent,
        settleWork,
        cancelWork,
        getActiveNavigationRequest: () => activeIntent.value?.navigation,
        getTerminalOutcome: (intentId: string) => terminal.get(intentId) ?? null,
    };
}

export type TPdfViewportWorkPort = Pick<
    ReturnType<typeof createViewportAuthority>,
    'activeWorkKind' | 'beginWork' | 'isWorkCurrent' | 'settleWork' | 'cancelWork'
>;
