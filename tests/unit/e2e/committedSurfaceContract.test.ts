import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    findCommittedSurfaceCausalOpenViolations,
    findCommittedSurfaceContractViolations,
    findCommittedSurfaceInteractionTailViolations,
    findInitialRenderAuthorityViolations,
    installCommittedSurfaceSampler,
    selectClaimedOpenTrace,
    summarizeCommittedSurfaceTiming,
    waitForCommittedSurfaceSamples,
    type ICommittedSurfaceFrame,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';

const rect = {
    height: 792,
    left: 200,
    top: 170,
    width: 612,
};
const style = {
    backgroundColor: 'rgb(255, 255, 255)',
    borderRadius: '2px',
    boxShadow: 'rgba(0, 0, 0, 0.15) 0px 1px 3px 0px',
};
const skeletonStyle = {
    ...style,
    boxShadow: 'none',
};

function frame(
    sequence: number,
    overrides: Partial<ICommittedSurfaceFrame> = {},
): ICommittedSurfaceFrame {
    return {
        bodyOverflow: 0,
        canvasAuthorityReady: false,
        canvasNonblank: false,
        committedEmptySource: 'live-empty-state',
        documentOverflow: 0,
        elapsedMs: sequence * 16,
        frame: sequence,
        kind: 'committed-empty',
        outOfFrameSkeletonCount: 0,
        pageNumber: null,
        shellId: null,
        shellRect: null,
        shellStyle: null,
        skeletonCount: 0,
        skeletonSharesShell: false,
        skeletonRect: null,
        skeletonStyle: null,
        viewportHasHorizontalOverflow: false,
        viewportOverflow: 0,
        ...overrides,
    };
}

function committedCanvas(sequence: number, shellId = 1) {
    return frame(sequence, {
        canvasAuthorityReady: true,
        canvasNonblank: true,
        canvasSharesRenderLayer: true,
        kind: 'committed-canvas',
        pageNumber: 1,
        shellId,
        shellRect: rect,
        shellStyle: style,
    });
}

function pageShell(sequence: number, shellId = 7, overrides: Partial<ICommittedSurfaceFrame> = {}) {
    return frame(sequence, {
        kind: 'page-shell', pageNumber: 1, shellId, shellRect: rect, shellStyle: style,
        skeletonCount: 1, skeletonSharesShell: true, skeletonRect: rect, skeletonStyle,
        ...overrides,
    });
}

function canvasFrames(start: number, shellId = 1, count = 10) {
    return Array.from({length: count}, (_, index) => committedCanvas(index + start, shellId));
}

function openingTrace() {
    return [frame(1), pageShell(2), ...canvasFrames(3, 7)];
}

const causalContract = {
    maxFirstCanvasMs: 2_500,
    maxFirstPageShellMs: 1_250,
    maxReadyAfterCanvasMs: 1_000,
    requirePageShell: true,
};

function causalTrace(shellMs: number, canvasMs: number, count: number): ICommittedSurfaceFrame[] {
    return [
        frame(1, {openSurfacePhase: 'idle', openSurfacePresentation: 'idle'}),
        pageShell(2, 7, {elapsedMs: shellMs, openSurfacePhase: 'geometry-committed', openSurfacePresentation: 'page-shell'}),
        ...canvasFrames(3, 7, count).map((entry, index) => ({
            ...entry, elapsedMs: canvasMs + index * 16,
            openSurfacePhase: index === 0 ? 'viewport-committed' : 'ready',
            openSurfacePresentation: index === 0 ? 'page-shell' : 'committed',
        })),
    ];
}

describe('committed surface E2E contract', () => {
    it('keeps pixel sampling enabled by default and serializes an explicit opt-out', async () => {
        const evaluate = vi.fn(async (_source: string) => undefined);
        const page = {evaluate} as never;

        await installCommittedSurfaceSampler(page);
        await installCommittedSurfaceSampler(page, {sampleCanvasPixels: false});

        expect(evaluate.mock.calls[0]?.[0]).toContain('})(true);');
        expect(evaluate.mock.calls[1]?.[0]).toContain('})(false);');
    });

    it('polls sampler counts from the host until the requested frame kind is stable', async () => {
        const evaluate = vi.fn<(source: string) => Promise<number>>()
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(10);

        await expect(waitForCommittedSurfaceSamples({evaluate} as never, {
            kind: 'committed-canvas',
            minimumSamples: 10,
            pollIntervalMs: 0,
            timeoutMs: 100,
        })).resolves.toBe(10);
        expect(evaluate).toHaveBeenCalledTimes(2);
    });

    it('reports capture exceptions as explicit contract failures without disguising them as missing frames', () => {
        const trace = {
            errors: [{
                checkpoint: 'page-7-transition',
                elapsedMs: 432,
                frame: 27,
                message: 'InvalidStateError: transient detached canvas',
            }],
            frames: [
                committedCanvas(1),
                committedCanvas(2),
            ],
        };

        expect(findCommittedSurfaceContractViolations(trace)).toContain(
            'surface sampler failed at frame 27 (page-7-transition): InvalidStateError: transient detached canvas',
        );
        expect(findCommittedSurfaceInteractionTailViolations(trace, {
            expectedPageByCheckpoint: {},
            horizontalOverflowCheckpoint: 'high-zoom-transition',
            minStableFrames: 0,
            preserveShellIdentityAcross: [],
            preserveWidthAcross: [],
            stableCheckpoints: [],
        })).toContain(
            'surface sampler failed at frame 27 (page-7-transition): InvalidStateError: transient detached canvas',
        );

        // An open the chassis never claimed fails on that cause, keeps its
        // frames and any capture error, and is not accepted without a shell.
        const idle = (sequence: number) => frame(sequence, {
            openSurfaceDiagnostic: {
                openSurfaceDocumentId: '',
                openSurfaceGeneration: '0',
            },
            openSurfacePhase: 'idle',
        });
        const unclaimed = selectClaimedOpenTrace({
            ...trace,
            frames: [
                idle(1),
                idle(2),
            ],
        });
        expect(unclaimed.frames.map(entry => entry.frame)).toEqual([
            1,
            2,
        ]);
        const unclaimedViolations = findCommittedSurfaceCausalOpenViolations(unclaimed, {
            allowDeferredOpening: true,
            maxFirstCanvasMs: 2_500,
            maxFirstPageShellMs: 1_250,
            maxReadyAfterCanvasMs: 1_000,
            requirePageShell: false,
        });
        expect(unclaimedViolations).toContain('surface sampler failed at frame 2 (unmarked): open never claimed');
        expect(unclaimedViolations).toContain(
            'surface sampler failed at frame 27 (page-7-transition): InvalidStateError: transient detached canvas',
        );
        expect(findCommittedSurfaceContractViolations(selectClaimedOpenTrace({frames: []}))).toEqual([
            'surface sampler failed at frame 0 (unmarked): open never claimed',
            'fewer than two animation frames were sampled',
        ]);
        expect(selectClaimedOpenTrace({frames: [
            idle(1),
            committedCanvas(2),
        ]})).toEqual({frames: [committedCanvas(2)]});
    });

    it.each<{
        name: string;
        mutate: (frames: ICommittedSurfaceFrame[]) => ICommittedSurfaceFrame[];
        errors: string[];
    }>([
        {name: 'accepts empty to exact page-frame shell to a stable canvas', mutate: frames => frames, errors: []},
        {name: 'accepts an empty-to-document sample that begins at the first page shell', mutate: frames => frames.slice(1), errors: []},
        {name: 'accepts the exact page frame before its skeleton appears', mutate: frames => [
            pageShell(1, 6, {committedEmptySource: null, skeletonCount: 0, skeletonSharesShell: false, skeletonRect: null, skeletonStyle: null}),
            ...frames.slice(1).map((entry, index) => index === 0 ? {...entry, committedEmptySource: null} : {...entry, shellId: 8}),
        ], errors: []},
        {name: 'accepts a logical shell handoff across wrappers when geometry and style stay exact', mutate: frames => frames.map((entry, index) =>
            index === 0 ? committedCanvas(1, 11) : {...entry, shellId: index === 1 ? 12 : 13}), errors: []},
        {name: 'accepts the canonical replacement page shell when the canvas reuses its wrapper', mutate: frames => frames.map((entry, index) =>
            index === 0 ? committedCanvas(1, 12) : {...entry, shellId: 12}), errors: []},
        {name: 'accepts a failed or superseded open that leaves the prior canvas committed', mutate: () => canvasFrames(1, 11, 12), errors: []},
        {name: 'rejects a bare placeholder background misreported as committed empty', mutate: frames => [
            frame(1, {committedEmptySource: null, emptyStateOwnsCenter: false, outerPlaceholderOwnsCenter: true,
                outerPlaceholderPresent: true, outerPlaceholderVisible: true, topElementPath: 'div.workspace-host__placeholder > div.blank-background'}),
            ...frames.slice(2),
        ], errors: ['claimed committed-empty without visible empty-state content']},
        {name: 'rejects any page-shell target, geometry, or style change before canvas commit', mutate: frames => [
            ...frames.slice(0, 2),
            pageShell(3, 8, {pageNumber: 2, shellRect: {...rect, width: rect.width + 12}, shellStyle: {...style, borderRadius: '4px'}}),
            ...canvasFrames(4, 8),
        ], errors: ['page shell target changed', 'page shell geometry changed before canvas commit', 'page shell style changed before canvas commit']},
        {name: 'rejects an early post-canvas resize even when the final ten RAFs are stable', mutate: frames => [
            ...frames.slice(0, 3),
            ...canvasFrames(4, 7, 11).map(entry => ({...entry, shellRect: {...rect, left: rect.left - 20, width: rect.width + 40}})),
        ], errors: ['changed after first paint at frame 4']},
        ...(['blank', 'loader'] as const).map(kind => ({
            name: `rejects a visible ${kind} frame`,
            mutate: (frames: ICommittedSurfaceFrame[]) => [frames[0]!, frame(2, {kind}), ...frames.slice(2)],
            errors: [`exposed ${kind}`],
        })),
        {name: 'compares every opening shell frame with the canvas, including one not yet measured', mutate: frames => [
            frames[0]!, pageShell(2, 4, {openSurfaceDiagnostic: {openSurfaceHasGeometry: 'false', openSurfaceHasOpeningGeometry: 'true'},
                shellRect: {...rect, width: rect.width / 2}, skeletonRect: {...rect, width: rect.width / 2}}), ...frames.slice(2),
        ], errors: ['page shell geometry changed at canvas commit']},
        {name: 'rejects a detached or geometrically different skeleton shell', mutate: frames => [
            frames[0]!, pageShell(2, 4, {shellRect: {...rect, top: rect.top + 4}, shellStyle: {...style, boxShadow: 'none'},
                skeletonSharesShell: false, skeletonRect: {...rect, top: rect.top + 4}, skeletonStyle: {...style, boxShadow: 'none'}}),
            ...canvasFrames(3, 5),
        ], errors: ['geometry changed', 'style changed']},
        {name: 'rejects a visible skeleton anywhere outside the actual canvas wrapper', mutate: frames => [
            frame(1, {outOfFrameSkeletonCount: 1}), ...frames.slice(2),
        ], errors: ['outside the actual page canvas wrapper']},
        {name: 'rejects a committed canvas outside the dedicated imperative render layer', mutate: () =>
            canvasFrames(1).map(entry => ({...entry, canvasSharesRenderLayer: false})), errors: ['canvas escaped the imperative render layer']},
        {name: 'rejects a skeleton that survives over a committed page visual', mutate: () =>
            canvasFrames(1).map((entry, index) => ({...entry, skeletonCount: index === 0 ? 1 : 0})), errors: ['retained a skeleton over the committed visual']},
    ])('$name', ({mutate, errors}) => {
        const violations = findCommittedSurfaceContractViolations({frames: mutate(openingTrace())});
        if (errors.length === 0) expect(violations).toEqual([]);
        for (const message of errors) expect(violations.join('\n')).toContain(message);
    });

    it('allows only an explicitly deferred cold opening before the page shell exists', () => {
        const deferredOpening = frame(1, {
            committedEmptySource: null,
            kind: 'blank',
            openSurfaceDiagnostic: {openSurfaceHasOpeningFrame: 'false'},
            openSurfacePhase: 'pending',
            openSurfacePresentation: 'idle',
            pdfNavigationDiagnostic: {openingSurfaceDeferred: 'true'},
        });
        const frames = [
            deferredOpening,
            ...canvasFrames(2, 1),
        ];

        expect(findCommittedSurfaceContractViolations({frames})).toContain('frame 1 exposed blank');
        expect(findCommittedSurfaceContractViolations({frames}, {allowDeferredOpening: true})).toEqual([]);
    });

    it('accepts an atomic document-to-document swap while the old frame remains unchanged', () => {
        const oldRect = {
            ...rect,
            width: 500,
        };
        const oldStyle = {
            ...style,
            borderRadius: '1px',
        };
        const oldFrames = [
            1,
            2,
            3,
        ].map(sequence => frame(sequence, {
            canvasAuthorityReady: true,
            canvasNonblank: true,
            kind: 'committed-canvas',
            pageNumber: 4,
            shellId: 11,
            shellRect: oldRect,
            shellStyle: oldStyle,
        }));
        const newFrames = canvasFrames(4, 12);

        expect(findCommittedSurfaceContractViolations({frames: [
            ...oldFrames,
            ...newFrames,
        ]})).toEqual([]);
    });

    it('requires visible progress while the opening page shape is unknown', () => {
        const openingFrame = (sequence: number, hasOpeningGeometry: 'true' | 'false') => frame(sequence, {
            kind: 'opening-progress',
            openingProgressRect: {
                ...rect,
                height: 8,
            },
            openSurfacePhase: 'pending',
            openSurfaceDiagnostic: {openSurfaceHasOpeningGeometry: hasOpeningGeometry},
        });
        const canvases = canvasFrames(3, 1);

        expect(findCommittedSurfaceContractViolations({frames: [
            {
                ...openingFrame(1, 'false'),
                openSurfacePhase: 'idle',
            },
            openingFrame(2, 'false'),
            ...canvases,
        ]})).toEqual([]);
        expect(findCommittedSurfaceContractViolations({frames: [
            frame(1),
            openingFrame(2, 'true'),
            ...canvases,
        ]}).join('\n')).toContain('exposed opening-progress');
        expect(findCommittedSurfaceContractViolations({frames: [
            frame(1),
            {
                ...openingFrame(2, 'false'),
                kind: 'blank',
            },
            ...canvases,
        ]}).join('\n')).toContain('exposed blank');
        expect(findCommittedSurfaceContractViolations({frames: [
            frame(1),
            {
                ...openingFrame(2, 'false'),
                openingProgressRect: null,
            },
            ...canvases,
        ]}).join('\n')).toContain('exposed opening-progress');
    });

    it('rejects an opening that goes back to the bare viewport after its page shell', () => {
        const opening = {
            openSurfaceDocumentId: '/documents/a.pdf',
            openSurfaceGeneration: '2',
        };
        const shell = pageShell(2, 4, {openSurfaceDiagnostic: {
                ...opening,
                openSurfaceHasOpeningGeometry: 'true',
            }, skeletonStyle});
        const backToBare = frame(3, {
            kind: 'blank',
            openSurfacePhase: 'pending',
            openSurfaceDiagnostic: {
                ...opening,
                openSurfaceHasOpeningGeometry: 'false',
            },
        });
        const canvases = canvasFrames(4, 1);

        expect(findCommittedSurfaceContractViolations({frames: [
            frame(1),
            shell,
            ...canvases,
        ]})).toEqual([]);
        expect(findCommittedSurfaceContractViolations({frames: [
            frame(1),
            shell,
            backToBare,
            ...canvases,
        ]}).join('\n')).toContain('frame 3 exposed blank');
        expect(findCommittedSurfaceContractViolations({frames: [
            frame(1),
            shell,
            {
                ...backToBare,
                kind: 'opening-progress',
                openingProgressRect: {
                    ...rect,
                    height: 8,
                },
            },
            ...canvases,
        ]}).join('\n')).toContain('frame 3 exposed opening-progress');
    });

    it('allows one stable horizontal-overflow transition but rejects a pulse', () => {
        const stableTransitionFrames = [
            frame(1),
            frame(2),
            ...canvasFrames(3, 1),
        ];
        stableTransitionFrames.slice(2).forEach(current => {
            current.viewportHasHorizontalOverflow = true;
            current.viewportOverflow = 900;
        });
        expect(findCommittedSurfaceContractViolations({frames: stableTransitionFrames})).toEqual([]);

        const frames = [
            frame(1),
            frame(2, {
                viewportHasHorizontalOverflow: true,
                viewportOverflow: 900,
            }),
            ...canvasFrames(3, 1),
        ];

        expect(findCommittedSurfaceContractViolations({frames}).join('\n')).toContain('overflow state pulsed');
    });

    it('accepts a stable single-page, navigation, and high-zoom interaction tail', () => {
        const stableCheckpoint = (
            checkpoint: string,
            start: number,
            pageNumber: number,
            shellId: number,
            shellRect = rect,
            horizontalOverflow = false,
        ) => Array.from({length: 10}, (_, index) => frame(start + index, {
            ...committedCanvas(start + index, shellId),
            interactionCheckpoint: checkpoint,
            pageNumber,
            shellRect,
            viewportHasHorizontalOverflow: horizontalOverflow,
            viewportScrollHeight: horizontalOverflow ? 4_100 : 1_100,
            viewportScrollWidth: horizontalOverflow ? 3_100 : 1_000,
        }));
        const frames = [
            ...stableCheckpoint('continuous-stable', 1, 1, 1),
            frame(11, {
                ...committedCanvas(11, 1),
                interactionCheckpoint: 'single-page-transition',
            }),
            ...stableCheckpoint('single-page-stable', 12, 1, 1),
            frame(22, {
                ...committedCanvas(22, 1),
                interactionCheckpoint: 'page-7-transition',
            }),
            ...stableCheckpoint('page-7-stable', 23, 7, 7),
            frame(33, {
                ...committedCanvas(33, 7),
                interactionCheckpoint: 'high-zoom-transition',
                pageNumber: 7,
                shellRect: {
                    ...rect,
                    width: 3_000,
                },
                viewportHasHorizontalOverflow: true,
                viewportScrollHeight: 4_100,
                viewportScrollWidth: 3_100,
            }),
            ...stableCheckpoint(
                'high-zoom-stable',
                34,
                7,
                7,
                {
                    ...rect,
                    width: 3_000,
                },
                true,
            ),
        ];

        expect(findCommittedSurfaceInteractionTailViolations({frames}, {
            expectedPageByCheckpoint: {
                'continuous-stable': 1,
                'high-zoom-stable': 7,
                'page-7-stable': 7,
                'single-page-stable': 1,
            },
            horizontalOverflowCheckpoint: 'high-zoom-transition',
            preserveShellIdentityAcross: [
                [
                    'continuous-stable',
                    'single-page-stable',
                ],
                [
                    'page-7-stable',
                    'high-zoom-stable',
                ],
            ],
            preserveWidthAcross: [[
                'continuous-stable',
                'single-page-stable',
                'page-7-stable',
            ]],
            stableCheckpoints: [
                'continuous-stable',
                'single-page-stable',
                'page-7-stable',
                'high-zoom-stable',
            ],
        })).toEqual([]);
    });

    it('allows only an exact in-frame skeleton without an obsolete canvas during a zoom transition', () => {
        const transition = frame(1, {
            ...committedCanvas(1),
            canvasAuthorityReady: false,
            canvasConnected: false,
            canvasNonblank: false,
            interactionCheckpoint: 'high-zoom-transition',
            kind: 'page-shell',
            pageCanvasNonzeroCanvasCount: 0,
            pageNumber: 7,
            skeletonCount: 1,
            skeletonSharesShell: true,
            viewportHasHorizontalOverflow: true,
        });
        const contract = {
            allowedSkeletonCheckpoints: ['high-zoom-transition'],
            expectedPageByCheckpoint: {'high-zoom-transition': 7},
            horizontalOverflowCheckpoint: 'high-zoom-transition',
            minStableFrames: 0,
            preserveShellIdentityAcross: [],
            preserveWidthAcross: [],
            stableCheckpoints: [],
        };

        expect(findCommittedSurfaceInteractionTailViolations({frames: [transition]}, contract)).toEqual([]);
        expect(findCommittedSurfaceInteractionTailViolations({frames: [{
            ...transition,
            canvasConnected: true,
            skeletonCount: 0,
            skeletonSharesShell: false,
        }]}, contract)).toEqual([]);
        expect(findCommittedSurfaceInteractionTailViolations({frames: [{
            ...transition,
            canvasConnected: true,
            pageCanvasNonzeroCanvasCount: 1,
        }]}, contract)).toContain(
            'frame 1 retained an obsolete canvas during high-zoom-transition',
        );
    });

    it('rejects placeholder, skeleton, scroll-extent, and horizontal-overflow tail regressions', () => {
        const frames = Array.from({length: 10}, (_, index) => frame(index + 1, {
            ...committedCanvas(index + 1),
            interactionCheckpoint: 'stable',
            outerPlaceholderVisible: index === 1,
            skeletonCount: index === 2 ? 1 : 0,
            shellId: index === 5 ? 2 : 1,
            shellRect: index === 6 ? {
                ...rect,
                width: rect.width + 40,
            } : rect,
            viewportHasHorizontalOverflow: index === 3,
            viewportScrollHeight: index === 4 ? 1_200 : 1_100,
            viewportScrollWidth: 1_000,
        }));
        frames.push(frame(11, {
            ...committedCanvas(11),
            interactionCheckpoint: 'high-zoom-transition',
            viewportHasHorizontalOverflow: true,
        }));

        const violations = findCommittedSurfaceInteractionTailViolations({frames}, {
            expectedPageByCheckpoint: {stable: 1},
            horizontalOverflowCheckpoint: 'high-zoom-transition',
            preserveShellIdentityAcross: [],
            preserveWidthAcross: [],
            stableCheckpoints: ['stable'],
        }).join('\n');
        expect(violations).toContain('reintroduced the empty placeholder');
        expect(violations).toContain('reintroduced a skeleton');
        expect(violations).toContain('changed its settled scroll extent');
        expect(violations).toContain('premature horizontal overflow');
        expect(violations).toContain('overflow state pulsed');
        expect(violations).toContain('swapped shell identity');
        expect(violations).toContain('width pulsed before high zoom');
    });

    it.each([
        {name: 'enforces causal shell, canvas, and ready timing for empty-to-document opens', shellMs: 180, canvasMs: 420, count: 10},
        {name: 'uses the canonical page shell immediately after the empty baseline', shellMs: 16, canvasMs: 32, count: 11},
    ])('$name', ({shellMs, canvasMs, count}) => {
        expect(findCommittedSurfaceCausalOpenViolations({frames: causalTrace(shellMs, canvasMs, count)}, causalContract)).toEqual([]);
    });

    it('rejects delayed readiness and regressing open-surface authority', () => {
        const frames = causalTrace(1_500, 2_700, 11).map((entry, index) => {
            if (index === 2) return {...entry, openSurfacePhase: 'canvas-committed'};
            if (index === 3) return {...entry, openSurfacePhase: 'geometry-committed', openSurfacePresentation: 'page-shell'};
            return index >= 4 ? {...entry, elapsedMs: 4_000 + (index - 4) * 16} : entry;
        });
        const contract = causalContract;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const reported = findCommittedSurfaceCausalOpenViolations({frames}, contract).join('\n');
        vi.stubEnv('EVB_E2E_TIMING_BUDGETS', 'enforce');
        const enforced = findCommittedSurfaceCausalOpenViolations({frames}, contract).join('\n');
        vi.unstubAllEnvs();
        warn.mockRestore();

        // Budget misses fail only where budgets are enforced; ordering always fails.
        expect(reported).not.toContain('budget');
        expect(reported).toContain('authority regressed from canvas-committed to geometry-committed');
        expect(enforced).toContain('first page shell missed its 1250ms budget');
        expect(enforced).toContain('first canvas missed its 2500ms budget');
        expect(enforced).toContain('missed its 1000ms post-canvas readiness budget');
        expect(enforced).toContain('authority regressed from canvas-committed to geometry-committed');
    });

    it('summarizes causal timing and rejects competing pre-canvas render authority', () => {
        const frames = causalTrace(180, 420, 11);

        expect(summarizeCommittedSurfaceTiming({frames})).toEqual({
            firstCanvasMs: 420,
            firstPageShellMs: 180,
            readyAfterCanvasMs: 16,
        });
        expect(findInitialRenderAuthorityViolations([
            {
                event: 'renderer-single-page-begin',
                payload: {
                    pageNumber: 1,
                    requestId: 1,
                },
            },
            {
                event: 'renderer-canvas-mounted',
                payload: {
                    pageNumber: 1,
                    requestId: 1,
                },
            },
        ], 1)).toEqual([]);

        const authorityViolations = findInitialRenderAuthorityViolations([
            {
                event: 'renderer-single-page-begin',
                payload: {
                    pageNumber: 1,
                    requestId: 1,
                },
            },
            {
                event: 'renderer-canvas-render-cancel-existing-task',
                payload: {
                    pageNumber: 1,
                    requestId: 2,
                },
            },
            {
                event: 'renderer-single-page-begin',
                payload: {
                    pageNumber: 1,
                    requestId: 2,
                },
            },
            {
                event: 'navigation-viewport-authority-retry',
                payload: {page: 1},
            },
            {
                event: 'renderer-canvas-mounted',
                payload: {
                    pageNumber: 1,
                    requestId: 2,
                },
            },
        ], 1).join('\n');
        expect(authorityViolations).toContain('observed request IDs [1,2]');
        expect(authorityViolations).toContain('competing pre-canvas authority events');
    });
});
