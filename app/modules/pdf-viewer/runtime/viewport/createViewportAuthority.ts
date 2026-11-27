import { isAbortError } from '@contracts/isAbortError';
import type {
    IPdfSemanticAnchor,
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

/** An intent's latest placement: its point and the position committed for it. */
export interface IPdfViewportPlacement {
    anchor: IPdfSemanticAnchor;
    commit: IPdfViewportPositionCommit;
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
 * What a layout change did, known in the flush that patched the new layout,
 * before the browser paints it. `placed`: the layout's own placement, or the
 * refined commit of the navigation it belongs to. `superseded`: an unplaced
 * navigation resolves against the new layout itself, or reader input or a
 * newer navigation took the view first. `cancelled`: nothing could be placed
 * (no document, geometry or container, or the view closed).
 */
export type TPdfRelayoutReceipt =
    | {
        outcome: 'placed';
        commit: IPdfViewportPositionCommit;
    }
    | {outcome: 'superseded' | 'cancelled'};

/**
 * Work that moves the viewport without a placement intent of its own: a
 * reload. It shares the authority's single in-flight slot, so a navigation
 * supersedes it and it is never current while a navigation owns the viewport.
 */
export type TPdfViewportWorkKind = 'reload';

/** `cancelRasters` cancels the in-flight rasters of the superseded layout. */
export interface IPdfViewportWorkCancellation {cancelRasters: boolean;}

interface IPdfViewportWork {
    readonly id: number;
    readonly kind: TPdfViewportWorkKind;
    readonly page: number | null;
    readonly interactionEpoch: number;
    /** The work committed its placement; later layout changes place freely. */
    placed: boolean;
}

interface IViewportAuthorityDependencies {
    getDocumentRevision(): number;
    /** The view write port's physical-interaction epoch, which intents and commits record. */
    getInteractionEpoch(): number;
    getGeometryRevision(): number;
    resolveIndicatorPage?(anchor: IPdfSemanticAnchor, previousPage: number): number;
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
    /** The offsets written; null when the view refused the write, which places nothing. */
    apply(
        intent: IPdfViewportIntent,
        commit: IPdfViewportResolvedCommit,
    ): {
        left: number;
        top: number;
    } | null | undefined;
    /**
     * Settles once the layout that ends the handoff is patched, before paint:
     * the placement to write through it, or null when it moved nothing.
     */
    settleHandoff?(
        intent: IPdfViewportIntent,
        placement: IPdfViewportPlacement,
        signal: AbortSignal,
    ): Promise<IPdfViewportResolvedCommit | null>;
    onPositionCommitted?(commit: IPdfViewportPositionCommit): void;
    awaitVisual(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    beforeApply?(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    clearDemand?(intentId: string): void;
    /** A navigation ticket accepted by the shared surface but not yet submitted here. */
    hasPendingNavigationTicket?(): boolean;
    onWorkCancelled?(cancellation: IPdfViewportWorkCancellation): void;
}

function createViewportAbortError() {
    return new DOMException('Viewport intent superseded', 'AbortError');
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
 * document revision, so an intent is fenced only by the document and its own
 * identity; it resolves against the layout at the moment it applies. Reader
 * input ends it through `observeUserScroll`. Wheel packets of a paged flip's
 * own gesture also advance the port's epoch, so the epoch is recorded, not
 * compared.
 */
export function createViewportAuthority(deps: IViewportAuthorityDependencies) {
    const terminalOutcomeLimit = 128;
    const phase = ref<TPdfViewportPhase>('idle');
    const activeIntent = shallowRef<IPdfViewportIntent | null>(null);
    const committedAnchor = shallowRef<IPdfSemanticAnchor | null>(null);
    // The intent whose handoff has ended: the view lays out its destination
    // and the outgoing pages alike while the intent places through that.
    const releasedIntent = shallowRef<IPdfViewportIntent | null>(null);
    const handoffReleased = computed(() => activeIntent.value !== null && releasedIntent.value === activeIntent.value);
    const pendingTargetPage = computed(() => {
        const intent = activeIntent.value;
        if (handoffReleased.value) {
            return null;
        }
        return intent?.documentContext?.page
            ?? (intent?.navigation?.target && 'page' in intent.navigation.target
                ? intent.navigation.target.page
                : null);
    });
    const currentPage = ref(1);
    let controller: AbortController | null = null;
    const terminal = new Map<string, 'settled' | 'cancelled'>();
    // Each intent's latest placement: the first commit, then every refinement.
    const placements = new WeakMap<IPdfViewportIntent, IPdfViewportPlacement>();
    const work = shallowRef<IPdfViewportWork | null>(null);
    let workSequence = 0;
    const ownsNavigation = computed(() => pendingTargetPage.value !== null
        || handoffReleased.value
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
            interactionEpoch: deps.getInteractionEpoch(),
            placed: false,
        };
        return work.value.id;
    }

    function isWorkCurrent(workId: number) {
        return work.value?.id === workId && !ownsNavigation.value;
    }

    /** Admitted work still owes its placement, and the reader has not moved since. */
    function isWorkPlacementPending() {
        return work.value !== null && !work.value.placed && !ownsNavigation.value
            && work.value.interactionEpoch === deps.getInteractionEpoch();
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
        releasedIntent.value = null;
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

    function commitAnchor(anchor: IPdfSemanticAnchor, page = deps.resolveIndicatorPage?.(anchor, currentPage.value) ?? anchor.page) {
        committedAnchor.value = anchor;
        currentPage.value = page;
    }

    function commitPosition(
        intent: IPdfViewportIntent,
        commit: IPdfViewportResolvedCommit,
        applied: {
            left: number;
            top: number;
        } | undefined,
    ) {
        commitAnchor(commit.anchor, intent.navigation || intent.kind === 'document-restore' ? commit.anchor.page : undefined);
        const positionCommit: IPdfViewportPositionCommit = Object.freeze({
            intentId: intent.id,
            intentKind: intent.kind,
            documentRevision: intent.documentRevision,
            geometryRevision: deps.getGeometryRevision(),
            interactionEpoch: intent.interactionEpoch,
            page: currentPage.value,
            left: applied?.left ?? commit.left,
            top: applied?.top ?? commit.top,
            ...(intent.navigationTicket ? {navigationTicket: intent.navigationTicket} : {}),
        });
        placements.set(intent, {
            anchor: commit.anchor,
            commit: positionCommit,
        });
        deps.onPositionCommitted?.(positionCommit);
        return positionCommit;
    }

    // A refused write places nothing: the intent ends instead of committing.
    function applyPlacement(intent: IPdfViewportIntent, commit: IPdfViewportResolvedCommit, signal: AbortSignal) {
        const applied = deps.apply(intent, commit);
        if (applied === null) {
            throw createViewportAbortError();
        }
        assertCurrent(intent, signal);
        commitPosition(intent, commit, applied);
        assertCurrent(intent, signal);
    }

    /**
     * A layout change is not new work; it belongs to the operation in flight.
     * A placed navigation is refined: its point, placed against the new
     * layout, becomes its latest commit, which `submit` returns. An unplaced
     * one resolves against the new layout itself; while a staged one waits
     * for its raster, the previous place the reader sees is kept. Null when
     * nothing is in flight: the caller places the layout's own point.
     */
    function refineLayout(
        resolveForLayout: (anchor: IPdfSemanticAnchor) => IPdfViewportResolvedCommit | null,
        // Maps the shown point through the change, such as a page's turn.
        transformShown: (anchor: IPdfSemanticAnchor) => IPdfSemanticAnchor = anchor => anchor,
    ): TPdfRelayoutReceipt | null {
        const intent = activeIntent.value;
        if (!intent) {
            return ownsNavigation.value ? {outcome: 'superseded'} : null;
        }
        const signal = controller?.signal;
        if (!signal || !isCurrent(intent, signal)) {
            return {outcome: 'superseded'};
        }
        const placement = placements.get(intent);
        if (!placement) {
            const shownAnchor = phase.value === 'awaiting-visual' && committedAnchor.value
                ? transformShown(committedAnchor.value)
                : null;
            const shown = shownAnchor && resolveForLayout(shownAnchor);
            if (shownAnchor && shown && deps.apply(intent, shown) !== null && isCurrent(intent, signal)) {
                committedAnchor.value = shownAnchor;
            }
            return {outcome: 'superseded'};
        }
        const commit = resolveForLayout(placement.anchor);
        if (!commit) {
            return {outcome: 'cancelled'};
        }
        const applied = deps.apply(intent, commit);
        // The write can synchronously deliver newer input; it owns the view.
        if (applied === null || !isCurrent(intent, signal)) {
            return {outcome: applied === null ? 'cancelled' : 'superseded'};
        }
        return {
            outcome: 'placed',
            commit: commitPosition(intent, commit, applied),
        };
    }

    async function submit(intent: Omit<IPdfViewportIntent, 'interactionEpoch'>) {
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
            interactionEpoch: deps.getInteractionEpoch(),
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
            if (stagedNavigationVisual) {
                phase.value = 'awaiting-visual';
                try {
                    await awaitWithAbort(deps.awaitVisual(next, signal), signal);
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
            // `apply` may synchronously trigger a newer command or physical
            // input. Do not publish the old anchor after that change.
            applyPlacement(next, commit, signal);
            if (next.navigationTicket) {
                phase.value = 'awaiting-visual';
                // A ticket whose raster failed cannot be reported as arrived;
                // it receives `failed` below and a later mount can replay it.
                await awaitWithAbort(deps.awaitVisual(next, signal), signal);
                assertCurrent(next, signal);
                // A staged navigation already refined its placement after this wait.
                if (deps.refineAfterVisual && !stagedNavigationVisual) {
                    const refined = await awaitWithAbort(deps.refineAfterVisual(next, commit, signal), signal);
                    assertCurrent(next, signal);
                    applyPlacement(next, refined, signal);
                    commit = refined;
                }
            } else if (!stagedNavigationVisual) {
                phase.value = 'awaiting-visual';
                await awaitWithAbort(deps.awaitVisual(next, signal), signal);
            }
            assertCurrent(next, signal);
            // Ending the handoff lays the outgoing pages it held out at the
            // current scale, which can move the destination. The intent
            // places its point through that before it arrives and settles.
            const placed = placements.get(next);
            if (deps.settleHandoff && placed) {
                releasedIntent.value = next;
                const settled = await awaitWithAbort(deps.settleHandoff(next, placed, signal), signal);
                assertCurrent(next, signal);
                if (settled) {
                    applyPlacement(next, settled, signal);
                }
            }
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
            // The final commit: refinements and the handoff release replace
            // the first placement.
            return {
                outcome: 'settled' as const,
                intent: next,
                positionCommit: placements.get(next)?.commit ?? null,
            };
        } catch (error) {
            if (!isAbortError(error) && next.navigationTicket && isCurrent(next, signal) && deps.reportNavigation) {
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
        cancelActive();
        commitAnchor(anchor);
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
        if (anchor) {
            commitAnchor(anchor, input.intentKind === 'relayout' ? undefined : input.page);
        }
        if (input.intentKind === 'document-restore' && work.value) {
            work.value.placed = true;
        }
        const commit = Object.freeze({
            ...position,
            page: anchor ? currentPage.value : input.page,
            interactionEpoch: deps.getInteractionEpoch(),
        });
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
        currentPage: readonly(currentPage),
        submit,
        refineLayout,
        handoffReleased,
        commitSettledPosition,
        observeUserScroll,
        // The point a settled position shows; it moves nothing and keeps the page.
        observeSettledAnchor: (anchor: IPdfSemanticAnchor) => commitAnchor(anchor, currentPage.value),
        suspend: cancelActive,
        dispose,
        activeWorkKind,
        targetPage,
        beginWork,
        isWorkCurrent,
        isWorkPlacementPending,
        settleWork,
        cancelWork,
        getTerminalOutcome: (intentId: string) => terminal.get(intentId) ?? null,
    };
}
