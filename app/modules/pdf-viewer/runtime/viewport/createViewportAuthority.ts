import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type { IPdfNavigationRequest } from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';

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
    priority: number;
    supersessionKey: string;
    navigation?: IPdfNavigationRequest;
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
}

interface IPdfViewportAppliedPosition {
    left: number;
    top: number;
}

interface IViewportAuthorityDependencies {
    getDocumentRevision(): number;
    getGeometryRevision(): number;
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
    postArrival?(request: IPdfNavigationRequest, signal: AbortSignal): Promise<void>;
    clearDemand?(intentId: string): void;
}

export function createViewportAuthority(deps: IViewportAuthorityDependencies) {
    const terminalOutcomeLimit = 128;
    const phase = ref<TPdfViewportPhase>('idle');
    const activeIntent = shallowRef<IPdfViewportIntent | null>(null);
    const committedAnchor = shallowRef<IPdfSemanticAnchor | null>(null);
    const pendingTargetPage = computed(() => {
        const target = activeIntent.value?.navigation?.target;
        return target && 'page' in target ? target.page : null;
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
        ) {
            throw new DOMException('Viewport intent superseded', 'AbortError');
        }
    }

    function finish(intent: IPdfViewportIntent, outcome: 'settled' | 'cancelled') {
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
            activeIntent.value = null;
            controller = null;
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

    async function submit(intent: Omit<IPdfViewportIntent, 'interactionEpoch'> & {interactionEpoch?: number}) {
        if (intent.documentRevision <= 0 || intent.geometryRevision <= 0) {
            throw new Error('Viewport intents require positive live document and geometry revisions');
        }
        cancelActive();
        const next = {
            ...intent,
            interactionEpoch: intent.interactionEpoch ?? interactionEpoch,
        };
        const initialGeometryReplacement = next.navigation
            ? beginGeometryReplacement(next.id)
            : null;
        activeIntent.value = next;
        controller = new AbortController();
        const {signal} = controller;
        scheduleGeometryReplacementEnd(next, signal, initialGeometryReplacement);
        let expectedGeometryRevision = next.geometryRevision;
        try {
            phase.value = 'awaiting-metrics';
            const hydratedGeometryRevision = await deps.awaitMetrics(next, signal);
            if (typeof hydratedGeometryRevision === 'number') {
                expectedGeometryRevision = hydratedGeometryRevision;
            }
            assertCurrent(next, signal, expectedGeometryRevision);
            rearmGeometryReplacement(next, signal);
            phase.value = 'resolving';
            let commit = await deps.resolve(next, signal);
            assertCurrent(next, signal, expectedGeometryRevision);
            phase.value = 'awaiting-slots';
            await deps.awaitSlots(next, signal);
            assertCurrentIntent(next, signal);
            rearmGeometryReplacement(next, signal);
            expectedGeometryRevision = deps.getGeometryRevision();
            if (deps.refine) {
                commit = await deps.refine(next, commit, signal);
                assertCurrent(next, signal, expectedGeometryRevision);
            }
            const stagedNavigationVisual = next.navigation !== undefined;
            if (stagedNavigationVisual) {
                // Requested rows mount from semantic navigation demand before
                // the physical viewport moves. Paint that offscreen row first
                // so a fast page jump never replaces the committed canvas with
                // a visible skeleton while PDF.js catches up.
                phase.value = 'awaiting-visual';
                try {
                    await deps.awaitVisual(next, signal);
                    assertCurrentIntent(next, signal);
                } catch (error) {
                    if (!(error instanceof DOMException && error.name === 'AbortError')) {
                        throw error;
                    }
                    // A current target whose raster failed must remain
                    // navigable. Genuine supersession still fails this fence.
                    assertCurrent(next, signal, expectedGeometryRevision);
                }
            }
            await deps.beforeApply?.(next, signal);
            assertCurrentIntent(next, signal);
            if (stagedNavigationVisual && deps.refineAfterVisual) {
                expectedGeometryRevision = deps.getGeometryRevision();
                commit = await deps.refineAfterVisual(next, commit, signal);
                assertCurrent(next, signal, expectedGeometryRevision);
            }
            phase.value = 'applying';
            const applied = deps.apply(next, commit);
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
            });
            deps.onPositionCommitted?.(positionCommit);
            if (!stagedNavigationVisual) {
                phase.value = 'awaiting-visual';
                await deps.awaitVisual(next, signal);
                assertCurrentIntent(next, signal);
            }
            if (next.navigation && deps.postArrival) await deps.postArrival(next.navigation, signal);
            assertCurrentIntent(next, signal);
            finish(next, 'settled');
            return {
                outcome: 'settled' as const,
                intent: next,
                positionCommit,
            };
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
