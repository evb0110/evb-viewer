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
    });

    it('accepts empty to exact page-frame shell to a stable canvas', () => {
        const frames = [
            frame(1),
            frame(2, {
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 7,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 3, 7)),
        ];

        expect(findCommittedSurfaceContractViolations({frames})).toEqual([]);
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
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 2)),
        ];

        expect(findCommittedSurfaceContractViolations({frames})).toContain('frame 1 exposed blank');
        expect(findCommittedSurfaceContractViolations({frames}, {allowDeferredOpening: true})).toEqual([]);
    });

    it('accepts an empty-to-document sample that begins at the first page shell', () => {
        const frames = [
            frame(1, {
                committedEmptySource: null,
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 7,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 2, 7)),
        ];

        expect(findCommittedSurfaceContractViolations({frames})).toEqual([]);
    });

    it('accepts the exact page frame before its debounced skeleton appears', () => {
        const frames = [
            frame(1, {
                committedEmptySource: null,
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 6,
                shellRect: rect,
                shellStyle: style,
            }),
            frame(2, {
                committedEmptySource: null,
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 7,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 3, 8)),
        ];

        expect(findCommittedSurfaceContractViolations({frames})).toEqual([]);
    });

    it('rejects a bare placeholder background misreported as committed empty', () => {
        const frames = [
            frame(1, {
                committedEmptySource: null,
                emptyStateOwnsCenter: false,
                outerPlaceholderOwnsCenter: true,
                outerPlaceholderPresent: true,
                outerPlaceholderVisible: true,
                topElementPath: 'div.workspace-host__placeholder > div.blank-background',
            }),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 2)),
        ];

        expect(findCommittedSurfaceContractViolations({frames}).join('\n'))
            .toContain('claimed committed-empty without visible empty-state content');
    });

    it('rejects any page-shell target, geometry, or style change before canvas commit', () => {
        const firstShell = frame(2, {
            kind: 'page-shell',
            pageNumber: 1,
            shellId: 7,
            shellRect: rect,
            shellStyle: style,
            skeletonCount: 1,
            skeletonSharesShell: true,
            skeletonRect: rect,
            skeletonStyle,
        });
        const changedShell = frame(3, {
            ...firstShell,
            frame: 3,
            pageNumber: 2,
            shellId: 8,
            shellRect: {
                ...rect,
                width: rect.width + 12,
            },
            shellStyle: {
                ...style,
                borderRadius: '4px',
            },
        });
        const frames = [
            frame(1),
            firstShell,
            changedShell,
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 4, 8)),
        ];
        const violations = findCommittedSurfaceContractViolations({frames}).join('\n');

        expect(violations).toContain('page shell target changed');
        expect(violations).toContain('page shell geometry changed before canvas commit');
        expect(violations).toContain('page shell style changed before canvas commit');
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
        const newFrames = Array.from({length: 10}, (_, index) => committedCanvas(index + 4, 12));

        expect(findCommittedSurfaceContractViolations({frames: [
            ...oldFrames,
            ...newFrames,
        ]})).toEqual([]);
    });

    it('rejects an early post-canvas resize even when the final ten RAFs are stable', () => {
        const firstCanvas = committedCanvas(3, 7);
        const widenedRect = {
            ...rect,
            left: rect.left - 20,
            width: rect.width + 40,
        };
        const frames = [
            frame(1),
            frame(2, {
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 7,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            firstCanvas,
            ...Array.from({length: 11}, (_, index) => ({
                ...committedCanvas(index + 4, 7),
                shellRect: widenedRect,
            })),
        ];

        expect(findCommittedSurfaceContractViolations({frames}).join('\n'))
            .toContain('changed after first paint at frame 4');
    });

    it('accepts a logical shell handoff across wrappers when geometry and style stay exact', () => {
        const frames = [
            committedCanvas(1, 11),
            frame(2, {
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 12,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 3, 13)),
        ];

        expect(findCommittedSurfaceContractViolations({frames})).toEqual([]);
    });

    it('accepts the canonical replacement page shell when the canvas reuses its wrapper', () => {
        const frames = [
            committedCanvas(1, 12),
            frame(2, {
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 12,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 3, 12)),
        ];

        expect(findCommittedSurfaceContractViolations({frames})).toEqual([]);
    });

    it('accepts a failed or superseded open that leaves the prior canvas committed', () => {
        const frames = Array.from({length: 12}, (_, index) => committedCanvas(index + 1, 11));

        expect(findCommittedSurfaceContractViolations({frames})).toEqual([]);
    });

    it.each([
        'blank',
        'loader',
        'neutral',
    ] as const)('rejects a visible %s frame', kind => {
        const frames = [
            frame(1),
            frame(2, {kind}),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 3)),
        ];

        expect(findCommittedSurfaceContractViolations({frames}).join('\n')).toContain(`exposed ${kind}`);
    });

    it('rejects a detached or geometrically different skeleton shell', () => {
        const frames = [
            frame(1),
            frame(2, {
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 4,
                shellRect: {
                    ...rect,
                    top: rect.top + 4,
                },
                shellStyle: {
                    ...style,
                    boxShadow: 'none',
                },
                skeletonCount: 1,
                skeletonSharesShell: false,
                skeletonRect: {
                    ...rect,
                    top: rect.top + 4,
                },
                skeletonStyle: {
                    ...style,
                    boxShadow: 'none',
                },
            }),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 3, 5)),
        ];
        const violations = findCommittedSurfaceContractViolations({frames}).join('\n');

        expect(violations).toContain('geometry changed');
        expect(violations).toContain('style changed');
    });

    it('rejects a visible skeleton anywhere outside the actual canvas wrapper', () => {
        const frames = [
            frame(1, {outOfFrameSkeletonCount: 1}),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 2)),
        ];

        expect(findCommittedSurfaceContractViolations({frames}).join('\n'))
            .toContain('outside the actual page canvas wrapper');
    });

    it('rejects a committed canvas outside the dedicated imperative render layer', () => {
        const frames = Array.from({length: 10}, (_, index) => ({
            ...committedCanvas(index + 1),
            canvasSharesRenderLayer: false,
        }));

        expect(findCommittedSurfaceContractViolations({frames}).join('\n'))
            .toContain('canvas escaped the imperative render layer');
    });

    it('rejects a skeleton that survives over a committed page visual', () => {
        const frames = Array.from({length: 10}, (_, index) => ({
            ...committedCanvas(index + 1),
            skeletonCount: index === 0 ? 1 : 0,
        }));

        expect(findCommittedSurfaceContractViolations({frames}).join('\n'))
            .toContain('retained a skeleton over the committed visual');
    });

    it('allows one stable horizontal-overflow transition but rejects a pulse', () => {
        const stableTransitionFrames = [
            frame(1),
            frame(2),
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 3)),
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
            ...Array.from({length: 10}, (_, index) => committedCanvas(index + 3)),
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

    it('enforces causal shell, canvas, and ready timing for empty-to-document opens', () => {
        const frames = [
            frame(1, {
                openSurfacePhase: 'idle',
                openSurfacePresentation: 'idle',
            }),
            frame(2, {
                elapsedMs: 180,
                kind: 'page-shell',
                openSurfacePhase: 'geometry-committed',
                openSurfacePresentation: 'page-shell',
                pageNumber: 1,
                shellId: 7,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            ...Array.from({length: 10}, (_, index) => ({
                ...committedCanvas(index + 3, 7),
                elapsedMs: 420 + (index * 16),
                openSurfacePhase: index === 0 ? 'viewport-committed' : 'ready',
                openSurfacePresentation: index === 0 ? 'page-shell' : 'committed',
            })),
        ];

        expect(findCommittedSurfaceCausalOpenViolations(
            {frames},
            {
                maxFirstCanvasMs: 2_500,
                maxFirstPageShellMs: 1_250,
                maxReadyAfterCanvasMs: 1_000,
                requirePageShell: true,
            },
        )).toEqual([]);
    });

    it('rejects delayed readiness and regressing open-surface authority', () => {
        const frames = [
            frame(1, {
                openSurfacePhase: 'idle',
                openSurfacePresentation: 'idle',
            }),
            frame(2, {
                elapsedMs: 1_500,
                kind: 'page-shell',
                openSurfacePhase: 'geometry-committed',
                openSurfacePresentation: 'page-shell',
                pageNumber: 1,
                shellId: 7,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            {
                ...committedCanvas(3, 7),
                elapsedMs: 2_700,
                openSurfacePhase: 'canvas-committed',
                openSurfacePresentation: 'page-shell',
            },
            {
                ...committedCanvas(4, 7),
                elapsedMs: 2_716,
                openSurfacePhase: 'geometry-committed',
                openSurfacePresentation: 'page-shell',
            },
            ...Array.from({length: 9}, (_, index) => ({
                ...committedCanvas(index + 5, 7),
                elapsedMs: 4_000 + (index * 16),
                openSurfacePhase: 'ready',
                openSurfacePresentation: 'committed',
            })),
        ];
        const violations = findCommittedSurfaceCausalOpenViolations(
            {frames},
            {
                maxFirstCanvasMs: 2_500,
                maxFirstPageShellMs: 1_250,
                maxReadyAfterCanvasMs: 1_000,
                requirePageShell: true,
            },
        ).join('\n');

        expect(violations).toContain('first page shell missed its 1250ms budget');
        expect(violations).toContain('first canvas missed its 2500ms budget');
        expect(violations).toContain('missed its 1000ms post-canvas readiness budget');
        expect(violations).toContain('authority regressed from canvas-committed to geometry-committed');
    });

    it('uses the canonical page shell immediately after the empty baseline', () => {
        const frames = [
            frame(1, {
                kind: 'committed-empty',
                committedEmptySource: 'live-empty-state',
                openSurfacePhase: 'idle',
                openSurfacePresentation: 'idle',
            }),
            frame(2, {
                elapsedMs: 16,
                kind: 'page-shell',
                openSurfacePhase: 'geometry-committed',
                openSurfacePresentation: 'page-shell',
                pageNumber: 1,
                shellId: 7,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            ...Array.from({length: 11}, (_, index) => ({
                ...committedCanvas(index + 3, 7),
                elapsedMs: 32 + (index * 16),
                openSurfacePhase: index === 0 ? 'viewport-committed' : 'ready',
                openSurfacePresentation: index === 0 ? 'page-shell' : 'committed',
            })),
        ];

        expect(findCommittedSurfaceCausalOpenViolations(
            {frames},
            {
                maxFirstCanvasMs: 2_500,
                maxFirstPageShellMs: 1_250,
                maxReadyAfterCanvasMs: 1_000,
                requirePageShell: true,
            },
        )).toEqual([]);
    });

    it('summarizes causal timing and rejects competing pre-canvas render authority', () => {
        const frames = [
            frame(1),
            frame(2, {
                elapsedMs: 180,
                kind: 'page-shell',
                pageNumber: 1,
                shellId: 7,
                shellRect: rect,
                shellStyle: style,
                skeletonCount: 1,
                skeletonSharesShell: true,
                skeletonRect: rect,
                skeletonStyle,
            }),
            {
                ...committedCanvas(3, 7),
                elapsedMs: 420,
                openSurfacePhase: 'viewport-committed',
                openSurfacePresentation: 'page-shell',
            },
            ...Array.from({length: 10}, (_, index) => ({
                ...committedCanvas(index + 4, 7),
                elapsedMs: 436 + (index * 16),
                openSurfacePhase: 'ready',
                openSurfacePresentation: 'committed',
            })),
        ];

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
