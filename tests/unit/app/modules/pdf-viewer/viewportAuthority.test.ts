import {createViewportAuthority} from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import {createPageNavigationRequest} from '@app/modules/document-viewer/public';
import {createDocumentOpenSurfaceSession} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type {IDocumentNavigationTicket, IPdfSemanticAnchor} from '@app/modules/document-viewer/public';
import type {IPdfViewportIntent} from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import {describe, expect, it, vi} from 'vitest';
import {watch} from 'vue';

const anchor = {
    page: 1,
    pageXFraction: 0.5,
    pageYFraction: 0,
    viewportXFraction: 0.5,
    viewportYFraction: 0,
    affinity: 'start' as const,
};

function intent(id: string, page: number): Omit<IPdfViewportIntent, 'interactionEpoch'> {
    return {
        id,
        kind: 'navigate',
        documentRevision: 1,
        navigation: createPageNavigationRequest(page, 'toolbar'),
    };
}

/** A navigation with a surface ticket places before its raster is ready. */
function ticketedIntent(id: string, page: number): Omit<IPdfViewportIntent, 'interactionEpoch'> {
    const request = createPageNavigationRequest(page, 'toolbar');
    return {
        ...intent(id, page),
        navigation: request,
        navigationTicket: {
            generation: 1,
            documentRevision: 'revision-1',
            id,
            request,
            signal: new AbortController().signal,
            finished: Promise.resolve({
                kind: 'arrived',
                page,
            }),
        },
    };
}

describe('ViewportAuthority', () => {
    it('does not report a state intent anchor as a navigation target', async () => {
        let releaseVisual!: () => void;
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: request.anchor ?? anchor,
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {},
            apply: () => {},
            awaitVisual: () =>
                new Promise<void>((resolve) => {
                    releaseVisual = resolve;
                }),
        });

        const pending = authority.submit({
            id: 'fit-page-2',
            kind: 'document-restore',
            documentRevision: 1,
            anchor: {
                ...anchor,
                page: 2,
            },
        });
        await vi.waitFor(() => expect(releaseVisual).toBeTypeOf('function'));

        expect(authority.pendingTargetPage.value).toBeNull();
        releaseVisual();
        await expect(pending).resolves.toMatchObject({outcome: 'settled'});
        expect(authority.currentPage.value).toBe(2);
    });

    it('records the port interaction epoch and yields only to reader scroll', async () => {
        let epoch = 4;
        let releaseVisual!: () => void;
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => epoch,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor: {
                    ...anchor,
                    page: 3,
                },
                left: 0,
                top: 1_800,
            }),
            awaitMetrics: async () => {},
            apply: () => {},
            awaitVisual: () =>
                new Promise<void>((resolve) => {
                    releaseVisual = resolve;
                }),
        });

        const flip = authority.submit({
            ...intent('wheel-flip', 3),
            kind: 'wheel-page',
        });
        await vi.waitFor(() => expect(releaseVisual).toBeTypeOf('function'));
        // Later packets of the gesture that flipped the page advance the
        // port's epoch; they must not withdraw the flip they produced.
        epoch += 1;
        releaseVisual();
        await expect(flip).resolves.toMatchObject({
            outcome: 'settled',
            positionCommit: {interactionEpoch: 4},
        });
        expect(authority.currentPage.value).toBe(3);

        // The reader scrolling the view ends the next one.
        const next = authority.submit(intent('navigate-5', 5));
        await vi.waitFor(() => expect(authority.phase.value).toBe('awaiting-visual'));
        authority.observeUserScroll(anchor);
        await expect(next).resolves.toMatchObject({outcome: 'cancelled'});
        // A settled position records the epoch current when it lands.
        expect(
            authority.commitSettledPosition({
                intentId: 'relayout-1',
                intentKind: 'relayout',
                documentRevision: 1,
                geometryRevision: 1,
                page: 1,
                left: 0,
                top: 0,
            }),
        ).toMatchObject({interactionEpoch: 5});
    });

    it('bounds terminal outcomes while retaining the newest intent result', async () => {
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 0,
            }),
            awaitMetrics: async () => {},
            apply: () => {},
            awaitVisual: async () => {},
        });

        for (let index = 0; index < 130; index += 1) {
            await authority.submit(intent(`bounded-${String(index)}`, index + 1));
        }

        expect(authority.getTerminalOutcome('bounded-0')).toBeNull();
        expect(authority.getTerminalOutcome('bounded-129')).toBe('settled');
    });

    it('joins a transaction-owned settled viewport into the durable authority state', () => {
        const onPositionCommitted = vi.fn();
        const authority = createViewportAuthority({
            getDocumentRevision: () => 3,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 5,
            resolve: async () => ({
                anchor,
                left: 0,
                top: 0,
            }),
            awaitMetrics: async () => {},
            apply: () => {},
            awaitVisual: async () => {},
            onPositionCommitted,
        });
        const settledAnchor = {
            ...anchor,
            page: 7,
        };

        const commit = authority.commitSettledPosition({
            intentId: 'reload-viewport-1-7',
            intentKind: 'document-restore',
            documentRevision: 3,
            geometryRevision: 5,
            page: 7,
            left: 12,
            top: 640,
            anchor: settledAnchor,
        });

        expect(commit).toMatchObject({
            intentId: 'reload-viewport-1-7',
            page: 7,
            left: 12,
            top: 640,
        });
        expect(authority.currentPage.value).toBe(7);
        expect(onPositionCommitted).toHaveBeenCalledWith(commit);
    });

    it('keeps the committed destination until a navigation target is visually ready', async () => {
        let releaseVisual!: () => void;
        const events: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {
                events.push('metrics');
            },
            awaitVisual: () =>
                new Promise<void>((resolve) => {
                    events.push('visual-requested');
                    releaseVisual = resolve;
                }),
            beforeApply: async () => {
                events.push('before-apply');
            },
            apply: () => {
                events.push('applied');
            },
        });

        const pending = authority.submit(intent('visual', 2));
        await vi.waitFor(() => expect(events).toContain('visual-requested'));
        expect(events).not.toContain('applied');
        expect(authority.currentPage.value).toBe(1);
        releaseVisual();
        await expect(pending).resolves.toMatchObject({outcome: 'settled'});
        expect(events).toEqual(['metrics', 'visual-requested', 'before-apply', 'applied']);
        expect(authority.currentPage.value).toBe(2);
        expect(authority.pendingTargetPage.value).toBeNull();
    });

    it('does not apply an intent suspended while its before-apply fence is pending', async () => {
        let releaseBeforeApply!: () => void;
        const events: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {},
            awaitVisual: async () => {},
            beforeApply: () =>
                new Promise<void>((resolve) => {
                    events.push('before-apply');
                    releaseBeforeApply = resolve;
                }),
            apply: () => {
                events.push('applied');
            },
        });

        const pending = authority.submit(intent('suspended-before-apply', 2));
        await vi.waitFor(() => expect(releaseBeforeApply).toBeTypeOf('function'));
        authority.suspend();
        releaseBeforeApply();

        await expect(pending).resolves.toMatchObject({outcome: 'cancelled'});
        expect(events).toEqual(['before-apply']);
        expect(authority.currentPage.value).toBe(1);
        expect(authority.getTerminalOutcome('suspended-before-apply')).toBe('cancelled');
    });

    it('completes cancellation while a dependency ignores the abort signal', async () => {
        let releaseVisual!: () => void;
        let completed = false;
        const heldVisual = new Promise<void>((resolve) => {
            releaseVisual = resolve;
        });
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: request.anchor ?? anchor,
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {},
            awaitVisual: async () => {
                await heldVisual;
            },
            apply: () => {},
        });

        const pending = authority.submit({
            id: 'held-visual',
            kind: 'document-restore',
            documentRevision: 1,
            anchor: {
                ...anchor,
                page: 2,
            },
        });
        pending.then(() => {
            completed = true;
        });
        await vi.waitFor(() => expect(authority.phase.value).toBe('awaiting-visual'));

        authority.suspend();
        try {
            for (let index = 0; index < 8; index += 1) {
                await Promise.resolve();
            }
            expect(completed).toBe(true);
        } finally {
            releaseVisual();
        }
        await expect(pending).resolves.toMatchObject({outcome: 'cancelled'});
    });

    it('applies a current navigation target when staged raster readiness fails', async () => {
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {},
            awaitVisual: async () => {
                throw new DOMException('PDF navigation readiness not reached', 'AbortError');
            },
            apply: (request) => {
                writes.push(request.id);
            },
        });

        await expect(authority.submit(intent('readiness-fallback', 2))).resolves.toMatchObject({outcome: 'settled'});
        expect(writes).toEqual(['readiness-fallback']);
        expect(authority.currentPage.value).toBe(2);
    });

    it('cancels a staged target when a newer navigation supersedes its visual wait', async () => {
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {},
            awaitVisual: (request, signal) =>
                request.id === 'stale-visual'
                    ? new Promise<void>((_resolve, reject) =>
                          signal.addEventListener(
                              'abort',
                              () => {
                                  reject(new DOMException('superseded', 'AbortError'));
                              },
                              {once: true},
                          ),
                      )
                    : Promise.resolve(),
            apply: (request) => {
                writes.push(request.id);
            },
        });

        const stale = authority.submit(intent('stale-visual', 2));
        await vi.waitFor(() => expect(authority.phase.value).toBe('awaiting-visual'));
        const latest = authority.submit(intent('latest-visual', 3));

        await expect(stale).resolves.toMatchObject({outcome: 'cancelled'});
        await expect(latest).resolves.toMatchObject({outcome: 'settled'});
        expect(writes).toEqual(['latest-visual']);
        expect(authority.currentPage.value).toBe(3);
    });

    it('refines against mounted slots before the single terminal viewport write', async () => {
        const writes: number[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {},
            apply: (_request, commit) => {
                writes.push(commit.top);
            },
            awaitVisual: async () => {},
            refine: async (_request, commit) => ({
                ...commit,
                top: 920,
            }),
        });

        await expect(authority.submit(intent('refined', 2))).resolves.toMatchObject({outcome: 'settled'});
        expect(writes).toEqual([920]);
        expect(authority.currentPage.value).toBe(2);
    });

    it.each([false, true])(
        'refines a staged navigation after visual readiness before its only viewport write (ticket: %s)',
        async (withTicket) => {
            const writes: number[] = [];
            const events: string[] = [];
            const authority = createViewportAuthority({
                getDocumentRevision: () => 1,
                getInteractionEpoch: () => 0,
                getGeometryRevision: () => 1,
                shouldStageNavigationVisual: () => true,
                resolve: async () => ({
                    anchor: {
                        ...anchor,
                        page: 2,
                    },
                    left: 0,
                    top: 100,
                }),
                awaitMetrics: async () => {},
                awaitVisual: async () => {
                    events.push('visual');
                },
                refineAfterVisual: async (_request, commit) => {
                    events.push('refine-after-visual');
                    return {
                        ...commit,
                        top: 920,
                    };
                },
                apply: (_request, commit) => {
                    events.push('apply');
                    writes.push(commit.top);
                },
            });
            const navigationTicket: IDocumentNavigationTicket = {
                generation: 1,
                documentRevision: 'revision-1',
                id: 'after-visual-refine',
                request: createPageNavigationRequest(2, 'search'),
                signal: new AbortController().signal,
                finished: Promise.resolve({
                    kind: 'arrived',
                    page: 2,
                }),
            };

            await expect(
                authority.submit({
                    ...intent('after-visual-refine', 2),
                    ...(withTicket ? {navigationTicket} : {}),
                }),
            ).resolves.toMatchObject({outcome: 'settled'});

            // A ticket still waits for its visible neighbors after placement.
            expect(events).toEqual(['visual', 'refine-after-visual', 'apply', ...(withTicket ? ['visual'] : [])]);
            expect(writes).toEqual([920]);
        },
    );

    it('returns the final commit after the placement is refined once its raster is ready', async () => {
        const writes: number[] = [];
        const committed: number[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor: {
                    ...anchor,
                    page: 2,
                },
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {},
            awaitVisual: async () => {},
            // The raster settles the mounted page 30 px lower than estimated.
            refineAfterVisual: async (_request, commit) => ({
                ...commit,
                top: 930,
            }),
            apply: (_request, commit) => {
                writes.push(commit.top);
            },
            onPositionCommitted: (commit) => committed.push(commit.top),
        });
        const result = await authority.submit(ticketedIntent('refined-after-visual', 2));

        expect(writes).toEqual([900, 930]);
        expect(committed).toEqual([900, 930]);
        expect(result).toMatchObject({
            outcome: 'settled',
            positionCommit: {
                top: 930,
                page: 2,
            },
        });
    });

    it('refines a placed navigation for a layout change and settles on that commit', async () => {
        let releaseVisual!: () => void;
        let layoutScale = 1;
        const writes: Array<{
            id: string;
            top: number;
        }> = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor: {
                    ...anchor,
                    page: 4,
                },
                left: 0,
                top: 3_000,
            }),
            awaitMetrics: async () => {},
            awaitVisual: () =>
                new Promise<void>((resolve) => {
                    releaseVisual = resolve;
                }),
            apply: (request, commit) => {
                writes.push({
                    id: request.id,
                    top: commit.top,
                });
            },
        });
        const resolveForLayout = (placed: IPdfSemanticAnchor) => ({
            anchor: placed,
            left: 0,
            top: 3_000 * layoutScale,
        });

        // Nothing in flight: the layout change places its own point.
        expect(authority.refineLayout(resolveForLayout)).toBeNull();
        const pending = authority.submit(ticketedIntent('placed-then-resized', 4));
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(authority.phase.value).toBe('awaiting-visual');

        // A sidebar narrows the fit scale while the raster is pending. The
        // change belongs to this navigation: it is placed again, as its commit.
        layoutScale = 0.8;
        const refined = authority.refineLayout(resolveForLayout);
        expect(refined).toMatchObject({
            outcome: 'placed',
            commit: {
                intentId: 'placed-then-resized',
                intentKind: 'navigate',
                page: 4,
                top: 2_400,
            },
        });
        expect(authority.activeIntent.value?.id).toBe('placed-then-resized');
        releaseVisual();

        await expect(pending).resolves.toMatchObject({
            outcome: 'settled',
            positionCommit: {top: 2_400},
        });
        expect(writes).toEqual([
            {
                id: 'placed-then-resized',
                top: 3_000,
            },
            {
                id: 'placed-then-resized',
                top: 2_400,
            },
        ]);
        expect(authority.getTerminalOutcome('placed-then-resized')).toBe('settled');
    });

    it('places a navigation through its handoff release before it arrives', async () => {
        const events: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor: {
                    ...anchor,
                    page: 3,
                },
                left: 0,
                top: 1_800,
            }),
            awaitMetrics: async () => {},
            awaitVisual: async () => {},
            apply: (_request, commit) => ({
                left: commit.left,
                top: commit.top,
            }),
            onPositionCommitted: (commit) => events.push(`commit ${String(commit.top)}`),
            // The outgoing page above, laid out at the current scale once
            // released, moves the page-top destination 120 px down.
            settleHandoff: async (_request, placement) => {
                events.push(`released ${String(authority.pendingTargetPage.value)} ${String(authority.activeIntent.value?.id)}`);
                return {
                    ...placement.commit,
                    anchor: placement.anchor,
                    top: placement.commit.top + 120,
                };
            },
            reportNavigation: (_ticket, report) => {
                events.push(report.kind);
                return true;
            },
        });
        const stop = watch(
            authority.activeIntent,
            (active) => {
                if (!active) {
                    events.push('settled');
                }
            },
            {flush: 'sync'},
        );

        const result = await authority.submit(ticketedIntent('page-top', 3));
        stop();

        expect(events).toEqual(['commit 1800', 'released null page-top', 'commit 1920', 'arrived', 'settled']);
        expect(result).toMatchObject({
            outcome: 'settled',
            positionCommit: {
                top: 1_920,
                navigationTicket: expect.anything(),
            },
        });
    });

    it('commits nothing the view refused to write', async () => {
        let refuse = false;
        let releaseVisual!: () => void;
        const committed: number[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor: {
                    ...anchor,
                    page: 2,
                },
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => {},
            awaitVisual: () =>
                new Promise<void>((resolve) => {
                    releaseVisual = resolve;
                }),
            apply: (_request, commit) =>
                refuse
                    ? null
                    : {
                          left: commit.left,
                          top: commit.top,
                      },
            onPositionCommitted: (commit) => committed.push(commit.top),
        });

        const pending = authority.submit(ticketedIntent('refused-refine', 2));
        await vi.waitFor(() => expect(committed).toEqual([900]));
        refuse = true;
        expect(
            authority.refineLayout((placed) => ({
                anchor: placed,
                left: 0,
                top: 700,
            })),
        ).toEqual({outcome: 'cancelled'});
        expect(committed).toEqual([900]);
        releaseVisual();
        await expect(pending).resolves.toMatchObject({outcome: 'settled'});

        await expect(authority.submit(ticketedIntent('refused-placement', 4))).resolves.toMatchObject({
            outcome: 'cancelled',
            positionCommit: null,
        });
        expect(committed).toEqual([900]);
        expect(authority.currentPage.value).toBe(2);
    });

    it('lets an unplaced navigation resolve against a changed layout itself', async () => {
        let releaseMetrics!: () => void;
        const writes: number[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor: {
                    ...anchor,
                    page: 6,
                },
                left: 0,
                top: 5_000,
            }),
            awaitMetrics: () =>
                new Promise<void>((resolve) => {
                    releaseMetrics = resolve;
                }),
            awaitVisual: async () => {},
            apply: (_request, commit) => {
                writes.push(commit.top);
            },
        });
        const resolveForLayout = vi.fn((placed: IPdfSemanticAnchor) => ({
            anchor: placed,
            left: 0,
            top: 1,
        }));

        const pending = authority.submit(ticketedIntent('unplaced', 6));
        await vi.waitFor(() => expect(releaseMetrics).toBeTypeOf('function'));
        expect(authority.refineLayout(resolveForLayout)).toEqual({outcome: 'superseded'});
        expect(resolveForLayout).not.toHaveBeenCalled();
        releaseMetrics();

        await expect(pending).resolves.toMatchObject({
            outcome: 'settled',
            positionCommit: {top: 5_000},
        });
        expect(writes).toEqual([5_000]);
    });

    it('serializes intents, executes aborts, and permits only latest commit', async () => {
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 10,
            }),
            awaitMetrics: (request, signal) =>
                request.id === 'A'
                    ? new Promise<void>((_resolve, reject) =>
                          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true}),
                      )
                    : Promise.resolve(),
            apply: (request) => {
                writes.push(request.id);
            },
            awaitVisual: async () => {},
        });

        const stale = authority.submit(intent('A', 30));
        await Promise.resolve();
        const latest = authority.submit(intent('B', 928));
        await expect(stale).resolves.toMatchObject({outcome: 'cancelled'});
        await expect(latest).resolves.toMatchObject({outcome: 'settled'});
        expect(writes).toEqual(['B']);
        expect(authority.currentPage.value).toBe(928);
        expect(authority.getTerminalOutcome('A')).toBe('cancelled');
    });

    it('lets user scroll dominate delayed async work', async () => {
        let release!: () => void;
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolveIndicatorPage: (_anchor, previousPage) => previousPage,
            resolve: async () => ({
                anchor,
                left: 0,
                top: 10,
            }),
            awaitMetrics: () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
            apply: (request) => {
                writes.push(request.id);
            },
            awaitVisual: async () => {},
        });
        const pending = authority.submit(intent('restore', 8));
        await Promise.resolve();
        authority.observeUserScroll({
            ...anchor,
            page: 3,
        });
        release();
        await expect(pending).resolves.toMatchObject({outcome: 'cancelled'});
        expect(writes).toEqual([]);
        expect(authority.currentPage.value).toBe(1);
        expect(authority.committedAnchor.value?.page).toBe(3);
    });

    it('retains newer input when a viewport write synchronously changes ownership', async () => {
        // R2: publishing layout during a write may synchronously deliver a
        // newer interaction. The cancelled command must not publish its page.
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor,
                left: 0,
                top: 0,
            }),
            awaitMetrics: async () => {},
            awaitVisual: async () => {},
            apply: () => {
                authority.observeUserScroll({
                    ...anchor,
                    page: 380,
                });
                return {
                    left: 0,
                    top: 300_000,
                };
            },
        });

        await expect(authority.submit(intent('first-page', 1))).resolves.toMatchObject({outcome: 'cancelled'});
        expect(authority.currentPage.value).toBe(380);
    });

    it('does not clobber a successor installed by an active-intent watcher', async () => {
        let reentered = false;
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async (request) => ({
                anchor: {
                    ...anchor,
                    page: request.id === 'successor' ? 2 : 1,
                },
                left: 0,
                top: 0,
            }),
            awaitMetrics: async () => {},
            awaitVisual: async () => {},
            apply: () => {},
        });
        let successor!: ReturnType<typeof authority.submit>;
        const stop = watch(
            authority.activeIntent,
            (active) => {
                if (active?.id === 'first' && !reentered) {
                    reentered = true;
                    successor = authority.submit(intent('successor', 2));
                }
            },
            {flush: 'sync'},
        );

        try {
            await expect(authority.submit(intent('first', 1))).resolves.toMatchObject({outcome: 'cancelled'});
            await expect(successor).resolves.toMatchObject({outcome: 'settled'});
            expect(authority.currentPage.value).toBe(2);
        } finally {
            stop();
        }
    });

    it('rejects a continuation when the document revision changes', async () => {
        let documentRevision = 1;
        let release!: () => void;
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => documentRevision,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor,
                left: 0,
                top: 10,
            }),
            awaitMetrics: () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
            apply: (request) => {
                writes.push(request.id);
            },
            awaitVisual: async () => {},
        });

        const pending = authority.submit(intent('document-change', 2));
        await Promise.resolve();
        documentRevision = 2;
        release();

        await expect(pending).resolves.toMatchObject({outcome: 'cancelled'});
        expect(writes).toEqual([]);
    });

    it('keeps a cancelled visual wait pending on its shared surface', async () => {
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: 'rotation.pdf',
            documentRevision: 'rotated',
        });
        surface.metadataReady(3);
        const ticket = surface.navigate(createPageNavigationRequest(1, 'search'))!;
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor,
                left: 0,
                top: 0,
            }),
            awaitMetrics: async () => {},
            apply: () => {},
            awaitVisual: async () => {
                throw new DOMException('Superseded raster layout', 'AbortError');
            },
            reportNavigation: (current, report) => surface.reportNavigation(current, report),
        });
        await expect(
            authority.submit({
                ...intent('rotation', 1),
                navigationTicket: ticket,
            }),
        ).resolves.toMatchObject({outcome: 'cancelled'});
        expect(surface.viewportSession.value.visual).toMatchObject({presentation: 'skeleton'});
        expect(surface.navigationTicket.value).toBe(ticket);
        surface.reset();
    });

    it('replays a current navigation ticket after a stale cancellation', async () => {
        let currentCheckCount = 0;
        const navigationTicket: IDocumentNavigationTicket = {
            generation: 1,
            documentRevision: 'revision-1',
            id: 'ticket-replay',
            request: createPageNavigationRequest(2, 'toolbar'),
            signal: new AbortController().signal,
            finished: Promise.resolve({
                kind: 'arrived',
                page: 2,
            }),
        };
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getInteractionEpoch: () => 0,
            getGeometryRevision: () => 1,
            isIntentCurrent: () => {
                currentCheckCount += 1;
                return currentCheckCount > 1;
            },
            resolve: async () => ({
                anchor: {
                    ...anchor,
                    page: 2,
                },
                left: 0,
                top: 0,
            }),
            awaitMetrics: async () => {},
            apply: () => {},
            awaitVisual: async () => {},
        });
        const replayableIntent = {
            ...intent('ticket-replay', 2),
            navigationTicket,
        };

        await expect(authority.submit(replayableIntent)).resolves.toMatchObject({outcome: 'cancelled'});
        expect(authority.getTerminalOutcome('ticket-replay')).toBe('cancelled');

        await expect(authority.submit(replayableIntent)).resolves.toMatchObject({outcome: 'settled'});
        expect(authority.currentPage.value).toBe(2);
        expect(authority.getTerminalOutcome('ticket-replay')).toBe('settled');
    });
});
