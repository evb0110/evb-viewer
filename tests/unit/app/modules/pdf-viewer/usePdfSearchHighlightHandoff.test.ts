// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import type {IPdfSearchMatch} from '@app/types/pdfUi';
import {usePdfSearchHighlightHandoff} from '@app/modules/pdf-viewer/runtime/rendering/usePdfSearchHighlightHandoff';
import {createViewportAuthority} from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import {
    pageIndexToPageNumber,
    requirePageIndex,
} from '@contracts/pageNumbers';

function createDeferred() {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

function createMatch(
    pageIndex: number,
    pageMatchIndex: number,
    startOffset: number,
    text = 'needle',
): IPdfSearchMatch {
    return {
        pageIndex: requirePageIndex(pageIndex),
        pageMatchIndex,
        matchIndex: pageMatchIndex,
        startOffset,
        endOffset: startOffset + 6,
        excerpt: {
            prefix: false,
            suffix: false,
            before: '',
            match: text,
            after: '',
        },
    };
}

function createSearchIntent(
    id: string,
    match: IPdfSearchMatch,
    searchNavigationId?: number,
) {
    return {
        id,
        kind: 'search' as const,
        documentRevision: 1,
        geometryRevision: 1,
        navigation: {
            target: {
                kind: 'text-anchor' as const,
                page: pageIndexToPageNumber(match.pageIndex),
                text: match.excerpt?.match ?? 'needle',
                ...(match.pageMatchIndex === undefined ? {} : {pageMatchIndex: match.pageMatchIndex}),
                ...(match.matchIndex === undefined ? {} : {matchIndex: match.matchIndex}),
                searchRange: {
                    startOffset: match.startOffset,
                    endOffset: match.endOffset,
                },
            },
            ...(searchNavigationId === undefined ? {} : {searchNavigationId}),
            alignment: 'rect-center' as const,
            readiness: 'text-layer' as const,
            postArrival: 'search-highlight' as const,
            source: 'search' as const,
            supersession: 'latest-wins' as const,
        },
    };
}

function createHarness(initialMatch: IPdfSearchMatch | null) {
    const scope = effectScope();
    const currentSearchMatch = shallowRef<IPdfSearchMatch | null>(initialMatch);
    const navigationId = ref(0);
    const visualWaits = new Map<string, ReturnType<typeof createDeferred>>();
    const paintedMatches: Array<IPdfSearchMatch | null> = [];
    const highlightCalls: Array<{
        pages: number[];
        match: IPdfSearchMatch | null;
    }> = [];
    let handoff!: ReturnType<typeof usePdfSearchHighlightHandoff>;

    const authority = createViewportAuthority({
        getDocumentRevision: () => 1,
        getGeometryRevision: () => 1,
        resolve: async intent => {
            const target = intent.navigation?.target;
            const page = target && 'page' in target ? target.page : 1;
            return {
                anchor: {
                    page,
                    pageXFraction: 0.5,
                    pageYFraction: 0.5,
                    viewportXFraction: 0.5,
                    viewportYFraction: 0.5,
                    affinity: 'center' as const,
                },
                left: 0,
                top: 100,
            };
        },
        awaitMetrics: async () => {},
        awaitSlots: async () => {},
        awaitVisual: (intent, signal) => {
            const deferred = createDeferred();
            visualWaits.set(intent.id, deferred);
            const rejectOnAbort = () => deferred.reject(new DOMException('superseded', 'AbortError'));
            signal.addEventListener('abort', rejectOnAbort, {once: true});
            return deferred.promise.finally(() => {
                signal.removeEventListener('abort', rejectOnAbort);
            });
        },
        apply: () => {
            paintedMatches.push(handoff.currentHighlightMatch.value);
        },
    });

    scope.run(() => {
        handoff = usePdfSearchHighlightHandoff({
            currentSearchMatch,
            navigationId,
            authority,
            applyHighlights: pages => {
                highlightCalls.push({
                    pages: [...pages],
                    match: handoff.currentHighlightMatch.value,
                });
            },
        });
    });

    return {
        authority,
        currentSearchMatch,
        handoff,
        highlightCalls,
        navigationId,
        paintedMatches,
        releaseVisual(id: string) {
            visualWaits.get(id)?.resolve();
        },
        scope,
        visualWaits,
    };
}

async function waitForVisual(
    harness: ReturnType<typeof createHarness>,
    id: string,
) {
    await vi.waitFor(() => expect(harness.visualWaits.has(id)).toBe(true));
}

describe('usePdfSearchHighlightHandoff', () => {
    it('keeps the outgoing selection until target readiness, then paints before viewport apply', async () => {
        const outgoing = createMatch(0, 0, 0);
        const target = createMatch(4, 0, 12);
        const harness = createHarness(outgoing);

        try {
            harness.currentSearchMatch.value = target;
            harness.navigationId.value = 1;
            await nextTick();
            expect(harness.handoff.currentHighlightMatch.value).toBe(outgoing);

            const navigation = harness.authority.submit(createSearchIntent('target-ready', target));
            await waitForVisual(harness, 'target-ready');
            expect(harness.handoff.currentHighlightMatch.value).toBe(outgoing);

            harness.releaseVisual('target-ready');
            await expect(navigation).resolves.toMatchObject({outcome: 'settled'});

            expect(harness.paintedMatches).toEqual([target]);
            expect(harness.highlightCalls).toEqual([{
                pages: [
                    1,
                    5,
                ],
                match: target,
            }]);
        } finally {
            harness.authority.dispose();
            harness.scope.stop();
        }
    });

    it('keeps same-page duplicate identity and refreshes highlights only once for that page', async () => {
        const outgoing = createMatch(0, 0, 0);
        const duplicate = createMatch(0, 1, 20);
        const harness = createHarness(outgoing);

        try {
            harness.currentSearchMatch.value = duplicate;
            harness.navigationId.value = 1;
            await nextTick();

            const navigation = harness.authority.submit(createSearchIntent('same-page-duplicate', duplicate));
            await waitForVisual(harness, 'same-page-duplicate');
            expect(harness.handoff.currentHighlightMatch.value).toBe(outgoing);

            harness.releaseVisual('same-page-duplicate');
            await expect(navigation).resolves.toMatchObject({outcome: 'settled'});

            expect(harness.paintedMatches).toEqual([duplicate]);
            expect(harness.highlightCalls).toEqual([{
                pages: [1],
                match: duplicate,
            }]);
        } finally {
            harness.authority.dispose();
            harness.scope.stop();
        }
    });

    it('allows the latest search navigation to paint while a stale target is still waiting', async () => {
        const outgoing = createMatch(0, 0, 0);
        const staleTarget = createMatch(1, 0, 8);
        const latestTarget = createMatch(2, 0, 16);
        const harness = createHarness(outgoing);

        try {
            harness.currentSearchMatch.value = staleTarget;
            harness.navigationId.value = 1;
            await nextTick();
            const staleNavigation = harness.authority.submit(createSearchIntent('stale-target', staleTarget));
            await waitForVisual(harness, 'stale-target');

            harness.currentSearchMatch.value = latestTarget;
            harness.navigationId.value = 2;
            await nextTick();
            expect(harness.handoff.currentHighlightMatch.value).toBe(outgoing);

            const latestNavigation = harness.authority.submit(createSearchIntent('latest-target', latestTarget));
            await expect(staleNavigation).resolves.toMatchObject({outcome: 'cancelled'});
            await waitForVisual(harness, 'latest-target');
            expect(harness.paintedMatches).toEqual([]);

            harness.releaseVisual('latest-target');
            await expect(latestNavigation).resolves.toMatchObject({outcome: 'settled'});
            expect(harness.paintedMatches).toEqual([latestTarget]);
            expect(harness.highlightCalls).toEqual([{
                pages: [
                    1,
                    3,
                ],
                match: latestTarget,
            }]);
        } finally {
            harness.authority.dispose();
            harness.scope.stop();
        }
    });

    it('clears the painted selection immediately and does not restore it when the pending query is cleared', async () => {
        const outgoing = createMatch(0, 0, 0);
        const target = createMatch(3, 0, 24);
        const harness = createHarness(outgoing);

        try {
            harness.currentSearchMatch.value = target;
            harness.navigationId.value = 1;
            await nextTick();
            const navigation = harness.authority.submit(createSearchIntent('cleared-query', target));
            await waitForVisual(harness, 'cleared-query');

            harness.currentSearchMatch.value = null;
            harness.navigationId.value = 2;
            await nextTick();
            expect(harness.handoff.currentHighlightMatch.value).toBeNull();
            expect(harness.highlightCalls).toEqual([{
                pages: [1],
                match: null,
            }]);

            harness.releaseVisual('cleared-query');
            await expect(navigation).resolves.toMatchObject({outcome: 'settled'});
            expect(harness.paintedMatches).toEqual([null]);
        } finally {
            harness.authority.dispose();
            harness.scope.stop();
        }
    });

    it('rejects a stale same-page search id before handing off an identical-offset replacement', async () => {
        const outgoing = createMatch(0, 0, 8, 'needle');
        const replacement = createMatch(0, 0, 8, 'foobar');
        const harness = createHarness(outgoing);

        try {
            harness.currentSearchMatch.value = replacement;
            harness.navigationId.value = 2;
            await nextTick();

            const staleNavigation = harness.authority.submit(
                createSearchIntent('stale-query-replacement', replacement, 1),
            );
            await waitForVisual(harness, 'stale-query-replacement');
            harness.releaseVisual('stale-query-replacement');
            await expect(staleNavigation).resolves.toMatchObject({outcome: 'settled'});

            expect(harness.paintedMatches).toEqual([outgoing]);
            expect(harness.handoff.currentHighlightMatch.value).toBe(outgoing);
            expect(harness.highlightCalls).toEqual([]);

            const currentNavigation = harness.authority.submit(
                createSearchIntent('current-query-replacement', replacement, 2),
            );
            await waitForVisual(harness, 'current-query-replacement');
            harness.releaseVisual('current-query-replacement');
            await expect(currentNavigation).resolves.toMatchObject({outcome: 'settled'});

            expect(harness.paintedMatches).toEqual([
                outgoing,
                replacement,
            ]);
            expect(harness.highlightCalls).toEqual([{
                pages: [1],
                match: replacement,
            }]);
        } finally {
            harness.authority.dispose();
            harness.scope.stop();
        }
    });

    it('rejects a stale same-page OCR rectangle id and accepts the current id', async () => {
        const outgoing = createMatch(0, 0, 8);
        const replacement = createMatch(0, 0, 8);
        const harness = createHarness(outgoing);

        try {
            harness.currentSearchMatch.value = replacement;
            harness.navigationId.value = 2;
            await nextTick();

            const staleNavigation = harness.authority.submit({
                ...createSearchIntent('stale-ocr-rect', replacement, 1),
                navigation: {
                    ...createSearchIntent('stale-ocr-rect', replacement, 1).navigation,
                    target: {
                        kind: 'rect' as const,
                        page: pageIndexToPageNumber(replacement.pageIndex),
                        rect: {
                            left: 0.25,
                            top: 0.5,
                            width: 0.1,
                            height: 0.05,
                        },
                    },
                },
            });
            await waitForVisual(harness, 'stale-ocr-rect');
            harness.releaseVisual('stale-ocr-rect');
            await expect(staleNavigation).resolves.toMatchObject({outcome: 'settled'});

            expect(harness.paintedMatches).toEqual([outgoing]);
            expect(harness.highlightCalls).toEqual([]);

            const currentNavigation = harness.authority.submit({
                ...createSearchIntent('current-ocr-rect', replacement, 2),
                navigation: {
                    ...createSearchIntent('current-ocr-rect', replacement, 2).navigation,
                    target: {
                        kind: 'rect' as const,
                        page: pageIndexToPageNumber(replacement.pageIndex),
                        rect: {
                            left: 0.25,
                            top: 0.5,
                            width: 0.1,
                            height: 0.05,
                        },
                    },
                },
            });
            await waitForVisual(harness, 'current-ocr-rect');
            harness.releaseVisual('current-ocr-rect');
            await expect(currentNavigation).resolves.toMatchObject({outcome: 'settled'});

            expect(harness.paintedMatches).toEqual([
                outgoing,
                replacement,
            ]);
            expect(harness.highlightCalls).toEqual([{
                pages: [1],
                match: replacement,
            }]);
        } finally {
            harness.authority.dispose();
            harness.scope.stop();
        }
    });
});
