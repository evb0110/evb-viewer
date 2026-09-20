import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type {
    IDocumentNavigationRequest,
    IDocumentNavigationTicket,
    TDocumentNavigationReport,
} from '@app/modules/document-viewer/public';
import type { IResolvedPdfNavigationTarget } from '@app/modules/pdf-viewer/runtime/viewport/pdfNavigationRequestResolver';

export type TPdfViewportIntentKind =
    | 'navigate' | 'user-scroll' | 'wheel-page' | 'zoom' | 'fit'
    | 'view-mode' | 'resize' | 'search' | 'activation' | 'document-restore' | 'dpr';
type TPdfViewportPhase =
    | 'idle' | 'resolving' | 'awaiting-metrics' | 'awaiting-slots'
    | 'applying' | 'awaiting-visual' | 'settled' | 'cancelled';

export interface IPdfViewportIntent {
    id: string;
    kind: TPdfViewportIntentKind;
    documentRevision: number;
    geometryRevision: number;
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
    /** Cursor position in viewport pixels, retained across scrollbar changes. */
    viewportPoint?: {
        x: number;
        y: number
    };
    zoom?: number;
    viewMode?: TPdfViewMode;
    dpr?: number;
}

interface IPdfViewportResolvedCommit {
    anchor: IPdfSemanticAnchor;
    left: number;
    top: number;
    zoom?: number;
    viewMode?: TPdfViewMode;
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

interface IPdfViewportAppliedPosition {
    left: number;
    top: number;
}

interface IViewportAuthorityDependencies {
    getDocumentRevision(): number;
    getGeometryRevision(): number;
    isIntentCurrent?(intent: IPdfViewportIntent): boolean;
    reportNavigation?(
        ticket: IDocumentNavigationTicket,
        report: TDocumentNavigationReport,
    ): boolean;
    beginLayoutGeometryReplacement?: (() => () => void) | undefined;
    resolve(intent: IPdfViewportIntent, signal: AbortSignal): Promise<IPdfViewportResolvedCommit>;
    awaitMetrics(intent: IPdfViewportIntent, signal: AbortSignal): Promise<unknown>;
    awaitSlots(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    awaitLayoutGeometrySettled?(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    refine?(intent: IPdfViewportIntent, commit: IPdfViewportResolvedCommit, signal: AbortSignal): Promise<IPdfViewportResolvedCommit>;
    refineAfterVisual?(intent: IPdfViewportIntent, commit: IPdfViewportResolvedCommit, signal: AbortSignal): Promise<IPdfViewportResolvedCommit>;
    apply(
        intent: IPdfViewportIntent,
        commit: IPdfViewportResolvedCommit,
    ): unknown;
    onPositionCommitted?(commit: IPdfViewportPositionCommit): void;
    awaitVisual(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    beforeApply?(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    postArrival?(request: IDocumentNavigationRequest, signal: AbortSignal): Promise<void>;
    clearDemand?(intentId: string): void;
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

export function createViewportAuthority(deps: IViewportAuthorityDependencies) {
    const terminalOutcomeLimit = 128;
    const geometryRetryLimit = 8;
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
    const pendingAnchorPage = computed(() => (
        pendingTargetPage.value ?? activeIntent.value?.anchor?.page ?? null
    ));
    const currentPage = computed(() => committedAnchor.value?.page ?? 1);
    let interactionEpoch = 0;
    let controller: AbortController | null = null;
    const terminal = new Map<string, 'settled' | 'cancelled'>();
    const geometryReplacements = new Map<string, {
        end: () => void;
        token: symbol;
    }>();

    function endGeometryReplacement(intentId: string, token?: symbol) {
        const replacement = geometryReplacements.get(intentId);
        if (!replacement || (token && replacement.token !== token)) {
            return;
        }
        geometryReplacements.delete(intentId);
        replacement.end();
    }

    function beginGeometryReplacement(intentId: string) {
        endGeometryReplacement(intentId);
        if (!deps.beginLayoutGeometryReplacement) {
            return null;
        }
        const token = Symbol(intentId);
        geometryReplacements.set(intentId, {
            end: deps.beginLayoutGeometryReplacement(),
            token,
        });
        return token;
    }

    function scheduleGeometryReplacementEnd(
        intent: IPdfViewportIntent,
        signal: AbortSignal,
        token: symbol | null,
    ) {
        if (!token || !deps.awaitLayoutGeometrySettled) {
            return;
        }
        void deps.awaitLayoutGeometrySettled(intent, signal).then(
            () => endGeometryReplacement(intent.id, token),
            () => endGeometryReplacement(intent.id, token),
        );
    }

    function rearmGeometryReplacement(intent: IPdfViewportIntent, signal: AbortSignal) {
        if (!intent.navigation) {
            return;
        }
        scheduleGeometryReplacementEnd(intent, signal, beginGeometryReplacement(intent.id));
    }

    function isCurrent(
        intent: IPdfViewportIntent,
        signal: AbortSignal,
        expectedGeometryRevision = intent.geometryRevision,
    ) {
        return !signal.aborted
            && activeIntent.value?.id === intent.id
            && intent.interactionEpoch === interactionEpoch
            && intent.documentRevision === deps.getDocumentRevision()
            && deps.isIntentCurrent?.(intent) !== false
            && expectedGeometryRevision === deps.getGeometryRevision();
    }

    function assertCurrent(
        intent: IPdfViewportIntent,
        signal: AbortSignal,
        expectedGeometryRevision = intent.geometryRevision,
    ) {
        if (!isCurrent(intent, signal, expectedGeometryRevision)) {
            throw new DOMException('Viewport intent superseded', 'AbortError');
        }
    }

    function assertCurrentIntent(intent: IPdfViewportIntent, signal: AbortSignal) {
        if (
            signal.aborted
            || activeIntent.value?.id !== intent.id
            || intent.interactionEpoch !== interactionEpoch
            || intent.documentRevision !== deps.getDocumentRevision()
            || deps.isIntentCurrent?.(intent) === false
        ) {
            throw createViewportAbortError();
        }
    }

    function finish(intent: IPdfViewportIntent, outcome: 'settled' | 'cancelled') {
        // An older execution attempt can reject after a same-ticket geometry
        // replacement has already installed its successor. Its ID is shared
        // by design, so checking only the ID here would terminalize and clear
        // the live successor.
        if (activeIntent.value !== intent) {
            return;
        }
        endGeometryReplacement(intent.id);
        if (terminal.has(intent.id)) {
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
        if (activeIntent.value?.id === intent.id) {
            phase.value = outcome;
            // A synchronous watcher can submit or observe a successor while
            // the terminal phase is published. Re-check before touching the
            // successor's ownership state.
            if (activeIntent.value?.id !== intent.id) {
                return;
            }
            activeIntent.value = null;
            if (activeIntent.value === null) {
                controller = null;
            }
        }
    }

    function cancelActive() {
        const intent = activeIntent.value;
        if (!intent) {
            return;
        }
        controller?.abort();
        finish(intent, 'cancelled');
    }

    async function submit(
        intent: Omit<IPdfViewportIntent, 'interactionEpoch'> & {interactionEpoch?: number},
        options: {
            restartCurrent?: boolean;
            geometryRetryCount?: number;
        } = {},
    ) {
        if (intent.documentRevision <= 0 || intent.geometryRevision <= 0) {
            throw new Error('Viewport intents require positive live document and geometry revisions');
        }
        const sameTicketReplacement = !options.restartCurrent
            && intent.navigationTicket !== undefined
            && activeIntent.value?.navigationTicket === intent.navigationTicket
            && activeIntent.value.id === intent.id;
        if (options.restartCurrent) {
            // A geometry change invalidates only the current execution attempt.
            // Retain the semantic intent and ticket while replacing the abort
            // controller, so this retry does not publish a terminal outcome
            // for an intent that is still live.
            if (activeIntent.value?.id !== intent.id) {
                return {
                    outcome: 'cancelled' as const,
                    intent,
                    positionCommit: null,
                };
            }
            controller?.abort();
            endGeometryReplacement(intent.id);
        } else if (sameTicketReplacement) {
            controller?.abort();
            endGeometryReplacement(intent.id);
            terminal.delete(intent.id);
        } else {
            cancelActive();
        }
        const next = {
            ...intent,
            interactionEpoch: intent.interactionEpoch ?? interactionEpoch,
        };
        if (!options.restartCurrent && !sameTicketReplacement && activeIntent.value !== null) {
            finish(next, 'cancelled');
            return {
                outcome: 'cancelled' as const,
                intent: next,
                positionCommit: null,
            };
        }
        const initialGeometryReplacement = next.navigation
            ? beginGeometryReplacement(next.id)
            : null;
        const nextController = new AbortController();
        controller = nextController;
        const {signal} = nextController;
        activeIntent.value = next;
        try {
            assertCurrentIntent(next, signal);
        } catch (error) {
            finish(next, 'cancelled');
            if (error instanceof DOMException && error.name === 'AbortError') {
                return {
                    outcome: 'cancelled' as const,
                    intent: next,
                    positionCommit: null,
                };
            }
            throw error;
        }
        scheduleGeometryReplacementEnd(next, signal, initialGeometryReplacement);
        let expectedGeometryRevision = next.geometryRevision;
        try {
            phase.value = 'awaiting-metrics';
            const hydratedGeometryRevision = await awaitWithAbort(
                deps.awaitMetrics(next, signal),
                signal,
            );
            if (typeof hydratedGeometryRevision === 'number') {
                expectedGeometryRevision = hydratedGeometryRevision;
            }
            assertCurrent(next, signal, expectedGeometryRevision);
            rearmGeometryReplacement(next, signal);
            phase.value = 'resolving';
            let commit = await awaitWithAbort(deps.resolve(next, signal), signal);
            assertCurrent(next, signal, expectedGeometryRevision);
            phase.value = 'awaiting-slots';
            await awaitWithAbort(deps.awaitSlots(next, signal), signal);
            assertCurrentIntent(next, signal);
            rearmGeometryReplacement(next, signal);
            expectedGeometryRevision = deps.getGeometryRevision();
            if (deps.refine) {
                commit = await awaitWithAbort(deps.refine(next, commit, signal), signal);
                assertCurrent(next, signal, expectedGeometryRevision);
            }
            // Legacy direct authority callers without a shared ticket retain
            // their staged visual contract. Production PDF navigation always
            // carries a ticket and takes the place-first branch below.
            const stagedNavigationVisual = next.navigation !== undefined
                && next.navigationTicket === undefined;
            if (stagedNavigationVisual) {
                phase.value = 'awaiting-visual';
                try {
                    await awaitWithAbort(deps.awaitVisual(next, signal), signal);
                    assertCurrentIntent(next, signal);
                } catch (error) {
                    if (signal.aborted) throw error;
                    // The compatibility path has no shared ticket to fail;
                    // keep its historical placement fallback. Ticketed PDF
                    // execution never enters this branch.
                    if (!(error instanceof DOMException && error.name === 'AbortError')) {
                        throw error;
                    }
                    assertCurrent(next, signal, expectedGeometryRevision);
                }
                if (deps.refineAfterVisual) {
                    expectedGeometryRevision = deps.getGeometryRevision();
                    commit = await awaitWithAbort(
                        deps.refineAfterVisual(next, commit, signal),
                        signal,
                    );
                    assertCurrent(next, signal, expectedGeometryRevision);
                }
            }
            // Navigation owns a semantic ticket. The measured placement is
            // published before raster readiness so the shared session can
            // transfer the shell to the requested page without a paint gate.
            // Raster readiness closes the same ticket after that placement.
            await awaitWithAbort(deps.beforeApply?.(next, signal), signal);
            assertCurrentIntent(next, signal);
            phase.value = 'applying';
            const applied = deps.apply(next, commit);
            // `apply` may synchronously trigger a newer command or physical
            // input. Do not publish the old anchor or call a callback after
            // that re-entrant ownership change.
            assertCurrentIntent(next, signal);
            committedAnchor.value = commit.anchor;
            const appliedPosition = applied
                && typeof applied === 'object'
                && 'left' in applied
                && 'top' in applied
                && typeof applied.left === 'number'
                && typeof applied.top === 'number'
                ? applied as IPdfViewportAppliedPosition
                : commit;
            const positionCommit = Object.freeze({
                intentId: next.id,
                intentKind: next.kind,
                documentRevision: next.documentRevision,
                geometryRevision: expectedGeometryRevision,
                interactionEpoch: next.interactionEpoch,
                page: commit.anchor.page,
                left: appliedPosition.left,
                top: appliedPosition.top,
                ...(next.navigationTicket ? {navigationTicket: next.navigationTicket} : {}),
            });
            deps.onPositionCommitted?.(positionCommit);
            assertCurrentIntent(next, signal);
            if (next.navigationTicket) {
                phase.value = 'awaiting-visual';
                try {
                    await awaitWithAbort(deps.awaitVisual(next, signal), signal);
                    assertCurrentIntent(next, signal);
                } catch (error) {
                    if (signal.aborted) {
                        throw error;
                    }
                    // A current ticket whose raster/readiness failed cannot be
                    // reported as arrived. Let the ticket receive `failed`
                    // below; a later renderer mount can replay the same ticket.
                    throw error;
                }
                if (deps.refineAfterVisual) {
                    expectedGeometryRevision = deps.getGeometryRevision();
                    const refined = await awaitWithAbort(
                        deps.refineAfterVisual(next, commit, signal),
                        signal,
                    );
                    assertCurrent(next, signal, expectedGeometryRevision);
                    const refinedApplied = deps.apply(next, refined);
                    assertCurrentIntent(next, signal);
                    committedAnchor.value = refined.anchor;
                    const refinedPosition = refinedApplied
                        && typeof refinedApplied === 'object'
                        && 'left' in refinedApplied
                        && 'top' in refinedApplied
                        && typeof refinedApplied.left === 'number'
                        && typeof refinedApplied.top === 'number'
                        ? refinedApplied as IPdfViewportAppliedPosition
                        : refined;
                    const refinedCommit = Object.freeze({
                        intentId: next.id,
                        intentKind: next.kind,
                        documentRevision: next.documentRevision,
                        geometryRevision: expectedGeometryRevision,
                        interactionEpoch: next.interactionEpoch,
                        page: refined.anchor.page,
                        left: refinedPosition.left,
                        top: refinedPosition.top,
                        navigationTicket: next.navigationTicket,
                    });
                    deps.onPositionCommitted?.(refinedCommit);
                    assertCurrentIntent(next, signal);
                    commit = refined;
                }
            } else if (!stagedNavigationVisual) {
                phase.value = 'awaiting-visual';
                await awaitWithAbort(deps.awaitVisual(next, signal), signal);
                assertCurrentIntent(next, signal);
            }
            if (next.navigation && deps.postArrival) {
                await awaitWithAbort(deps.postArrival(next.navigation, signal), signal);
            }
            assertCurrentIntent(next, signal);
            if (next.navigationTicket && deps.reportNavigation) {
                const accepted = deps.reportNavigation(next.navigationTicket, {
                    kind: 'arrived',
                    page: commit.anchor.page,
                });
                if (!accepted) {
                    if (!isCurrent(next, signal, expectedGeometryRevision)) {
                        throw createViewportAbortError();
                    }
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
            const geometryChangedWhileCurrent = next.navigationTicket
                && !signal.aborted
                && activeIntent.value?.id === next.id
                && next.interactionEpoch === interactionEpoch
                && next.documentRevision === deps.getDocumentRevision()
                && deps.isIntentCurrent?.(next) !== false
                && expectedGeometryRevision !== deps.getGeometryRevision();
            if (geometryChangedWhileCurrent) {
                // Geometry invalidates only this attempt. Re-submit the same
                // ticket so the semantic command remains ordered by its id;
                // no new surface request or timer is introduced.
                const geometryRetryCount = options.geometryRetryCount ?? 0;
                if (geometryRetryCount < geometryRetryLimit) {
                    return submit({
                        ...next,
                        geometryRevision: deps.getGeometryRevision(),
                    }, {
                        restartCurrent: true,
                        geometryRetryCount: geometryRetryCount + 1,
                    });
                }
                const reason = `Viewport geometry did not stabilize after ${String(geometryRetryLimit)} retries`;
                if (
                    deps.reportNavigation
                    && next.navigationTicket
                    && !signal.aborted
                    && activeIntent.value?.id === next.id
                    && next.documentRevision === deps.getDocumentRevision()
                    && deps.isIntentCurrent?.(next) !== false
                ) {
                    deps.reportNavigation(next.navigationTicket, {
                        kind: 'failed',
                        reason,
                    });
                }
                finish(next, 'cancelled');
                return {
                    outcome: 'cancelled' as const,
                    intent: next,
                    positionCommit: null,
                };
            }
            if (
                next.navigationTicket
                && !signal.aborted
                && isCurrent(next, signal)
                && deps.reportNavigation
            ) {
                const reason = error instanceof Error ? error.message : String(error);
                deps.reportNavigation(next.navigationTicket, {
                    kind: 'failed',
                    reason,
                });
            }
            finish(next, 'cancelled');
            if (error instanceof DOMException && error.name === 'AbortError') {
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

    function suspend() { cancelActive(); }
    function resume(intent: Omit<IPdfViewportIntent, 'interactionEpoch'>) { return submit(intent); }
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
        pendingAnchorPage,
        currentPage,
        submit,
        commitSettledPosition,
        observeUserScroll,
        suspend,
        resume,
        dispose,
        getActiveNavigationRequest: () => activeIntent.value?.navigation,
        getTerminalOutcome: (intentId: string) => terminal.get(intentId) ?? null,
    };
}
