import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import { ZOOM } from '@app/constants/pdfLayout';
import { resolveDocumentWheelInteraction } from '@app/modules/document-viewer/input/documentWheelInteraction';

vi.mock('@app/utils/browserLogger', () => {
    return { BrowserLogger: {
        diagnostic: vi.fn(),
        diagnosticThrottled: vi.fn(),
        warn: vi.fn(),
        warnThrottled: vi.fn(),
    } };
});

const { usePdfViewerWheelZoom } = await import('@app/modules/pdf-viewer/runtime/composables/usePdfViewerWheelZoom');

function toElement<T extends object>(value: T) {
    return value as HTMLElement;
}

describe('usePdfViewerWheelZoom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
        vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function createViewerContainer() {
        return toElement({
            clientWidth: 500,
            clientHeight: 800,
            scrollWidth: 2000,
            scrollHeight: 4000,
            scrollTop: 40,
            scrollLeft: 10,
            getBoundingClientRect: () => ({
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 500,
                bottom: 800,
                width: 500,
                height: 800,
                toJSON: () => ({}),
            }),
        });
    }

    function createWheelEvent(overrides: Partial<WheelEvent> = {}) {
        const event = {
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            deltaMode: 0,
            deltaX: 0,
            deltaY: 0,
            deltaZ: 0,
            cancelable: true,
            defaultPrevented: false,
            clientX: 0,
            clientY: 0,
            preventDefault() {
                Object.defineProperty(event, 'defaultPrevented', {
                    value: true,
                    configurable: true,
                });
            },
            ...overrides,
        } as WheelEvent;
        return event;
    }

    function setupWheelZoom(options?: {
        zoom?: number;
        effectiveScale?: number;
    }) {
        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const zoom = ref(options?.zoom ?? 1);
        const effectiveScale = ref(options?.effectiveScale ?? 1);
        const zoomVirtualizationFreeze = ref(null);
        const singlePageScroll = {
            handleWheel: vi.fn(() => false),
            cancelProgrammaticNavigation: vi.fn(),
        };
        const cancelPendingSearchScroll = vi.fn();
        const markUserViewportInteraction = vi.fn(() => {
            singlePageScroll.cancelProgrammaticNavigation();
        });
        const emit = vi.fn();
        const submitZoomIntent = vi.fn();
        const capturedResizeAnchor = {
            page: 4,
            capturedAtMs: 1_000,
            transitionToken: 1,
            visibleRange: {
                start: 4,
                end: 6,
            },
            viewerMetrics: null,
        };
        const captureZoomVisualSnapshots = vi.fn(() => capturedResizeAnchor);

        const scope = effectScope();
        const wheelZoom = scope.run(() => usePdfViewerWheelZoom({
            submitZoomIntent,
            viewerContainer,
            src: computed(() => ({ kind: 'data' }) as never),
            isLoading: ref(false),
            zoom: computed(() => zoom.value),
            effectiveScale,
            currentPage: ref(4),
            visibleRange: ref({
                start: 4,
                end: 6,
            }),
            virtualizedContinuousMode: ref(true),
            virtualWindowStart: ref(2),
            virtualWindowEnd: ref(8),
            zoomVirtualizationFreeze,
            singlePageScroll,
            cancelPendingSearchScroll,
            markUserViewportInteraction,
            captureZoomVisualSnapshots,
            isSnipActive: () => false,
            emit: emit as never,
        }));

        if (!wheelZoom) {
            throw new Error('Failed to create wheel zoom composable');
        }
        const handleWheel = (event: WheelEvent) => {
            const container = viewerContainer.value;
            if (!container) {
                throw new Error('Viewer container is unavailable');
            }
            wheelZoom.handleViewerWheel(resolveDocumentWheelInteraction(event, container));
        };

        return {
            scope,
            zoom,
            effectiveScale,
            viewerContainer,
            zoomVirtualizationFreeze,
            singlePageScroll,
            cancelPendingSearchScroll,
            markUserViewportInteraction,
            emit,
            submitZoomIntent,
            captureZoomVisualSnapshots,
            capturedResizeAnchor,
            handleWheel,
            wheelZoom,
        };
    }

    it('starts a modifier-wheel zoom session and emits custom zoom updates', () => {
        const setup = setupWheelZoom();

        try {
            const event = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });

            setup.handleWheel(event);

            const emittedEffectiveZoom = setup.emit.mock.calls.find(
                call => call[0] === 'update:effectiveZoom',
            )?.[1];
            const emittedZoom = setup.emit.mock.calls.find(call => call[0] === 'update:zoomState')?.[1]?.scale;

            expect(event.defaultPrevented).toBe(true);
            expect(setup.emit).toHaveBeenCalledWith('update:effectiveZoom', expect.any(Number));
            expect(setup.emit).toHaveBeenCalledWith('update:zoomState', expect.objectContaining({kind: 'custom'}));
            expect(Number.isFinite(emittedEffectiveZoom)).toBe(true);
            expect(Number.isFinite(emittedZoom)).toBe(true);
            expect(emittedEffectiveZoom).toBeGreaterThan(1);
            expect(emittedZoom).toBeGreaterThan(1);
            expect(setup.captureZoomVisualSnapshots).toHaveBeenCalledOnce();
            expect(setup.captureZoomVisualSnapshots.mock.invocationCallOrder[0]).toBeLessThan(
                setup.emit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
            );
            expect(setup.wheelZoom.consumeZoomViewportAnchor()?.resizeAnchor)
                .toStrictEqual(setup.capturedResizeAnchor);
            expect(setup.submitZoomIntent.mock.invocationCallOrder[0]).toBeLessThan(
                setup.emit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
            );
            expect(setup.zoomVirtualizationFreeze.value).toEqual(expect.objectContaining({
                sessionId: 1,
                windowStart: 2,
                windowEnd: 8,
            }));
        } finally {
            setup.scope.stop();
        }
    });

    it('allows macOS Control-wheel packets to scroll without zooming even when keydown was missed', () => {
        vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
        const setup = setupWheelZoom();

        try {
            const event = createWheelEvent({
                ctrlKey: true,
                deltaY: 240,
                clientX: 120,
                clientY: 160,
            });

            setup.handleWheel(event);

            expect(event.defaultPrevented).toBe(false);
            expect(setup.emit).not.toHaveBeenCalled();
            expect(setup.singlePageScroll.handleWheel).not.toHaveBeenCalled();
            expect(setup.cancelPendingSearchScroll).toHaveBeenCalledOnce();
            expect(setup.markUserViewportInteraction).toHaveBeenCalledOnce();
        } finally {
            setup.scope.stop();
        }
    });

    it('uses Command-wheel for zoom on macOS', () => {
        vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
        const setup = setupWheelZoom();

        try {
            const event = createWheelEvent({
                deltaY: -120,
                metaKey: true,
                clientX: 120,
                clientY: 160,
            });

            setup.handleWheel(event);

            expect(event.defaultPrevented).toBe(true);
            expect(setup.emit).toHaveBeenCalledWith('update:effectiveZoom', expect.any(Number));
            expect(setup.emit).toHaveBeenCalledWith('update:zoomState', expect.objectContaining({kind: 'custom'}));
        } finally {
            setup.scope.stop();
        }
    });

    it('converts fit-height wheel zoom to an absolute manual zoom', () => {
        const setup = setupWheelZoom({
            zoom: 1,
            effectiveScale: 0.12,
        });

        try {
            const event = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });

            setup.handleWheel(event);

            expect(setup.emit).toHaveBeenCalledWith('update:effectiveZoom', ZOOM.MIN);
            expect(setup.emit).toHaveBeenCalledWith('update:zoomState', {
                kind: 'custom',
                scale: ZOOM.MIN,
            });
        } finally {
            setup.scope.stop();
        }
    });

    it('does not let ignored below-min zoom-out packets delay the next zoom-in', () => {
        const setup = setupWheelZoom({
            zoom: 1,
            effectiveScale: 0.12,
        });

        try {
            const zoomOutEvent = createWheelEvent({
                deltaY: 240,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });

            setup.handleWheel(zoomOutEvent);

            expect(zoomOutEvent.defaultPrevented).toBe(true);
            expect(setup.emit).not.toHaveBeenCalledWith('update:effectiveZoom', expect.any(Number));
            expect(setup.emit).not.toHaveBeenCalledWith('update:zoomState', expect.objectContaining({kind: 'custom'}));

            setup.emit.mockClear();

            const zoomInEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });

            setup.handleWheel(zoomInEvent);

            expect(zoomInEvent.defaultPrevented).toBe(true);
            expect(setup.emit).toHaveBeenCalledWith('update:effectiveZoom', ZOOM.MIN);
            expect(setup.emit).toHaveBeenCalledWith('update:zoomState', {
                kind: 'custom',
                scale: ZOOM.MIN,
            });
        } finally {
            setup.scope.stop();
        }
    });

    it('suppresses non-modifier wheel packets while the zoom interaction is locked', () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(zoomEvent);

            const plainWheelEvent = createWheelEvent({
                deltaY: 80,
                clientX: 130,
                clientY: 180,
            });
            setup.handleWheel(plainWheelEvent);

            expect(plainWheelEvent.defaultPrevented).toBe(true);
            expect(setup.singlePageScroll.handleWheel).not.toHaveBeenCalled();
            expect(setup.cancelPendingSearchScroll).toHaveBeenCalled();
        } finally {
            setup.scope.stop();
        }
    });

    it('suppresses non-modifier wheel packets during the expected post-zoom scroll window', () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(zoomEvent);

            vi.advanceTimersByTime(600);

            const plainWheelEvent = createWheelEvent({
                deltaY: 80,
                clientX: 130,
                clientY: 180,
            });
            setup.handleWheel(plainWheelEvent);

            expect(plainWheelEvent.defaultPrevented).toBe(true);
            expect(setup.singlePageScroll.handleWheel).not.toHaveBeenCalled();
            expect(setup.cancelPendingSearchScroll).toHaveBeenCalled();
        } finally {
            setup.scope.stop();
        }
    });

    it('allows plain wheel scrolling while a non-wheel zoom rerender is busy', () => {
        const setup = setupWheelZoom();

        try {
            setup.wheelZoom.setZoomRerenderBusy(true);

            const plainWheelEvent = createWheelEvent({
                deltaY: 80,
                clientX: 130,
                clientY: 180,
            });
            setup.handleWheel(plainWheelEvent);

            expect(plainWheelEvent.defaultPrevented).toBe(false);
            expect(setup.cancelPendingSearchScroll).toHaveBeenCalledOnce();
            expect(setup.singlePageScroll.handleWheel).toHaveBeenCalledWith(plainWheelEvent);
            expect(setup.markUserViewportInteraction).toHaveBeenCalledOnce();
        } finally {
            setup.scope.stop();
        }
    });

    it('marks unhandled plain wheel packets as interrupting viewport interactions', () => {
        const setup = setupWheelZoom();

        try {
            const event = createWheelEvent({
                deltaY: 120,
                clientX: 120,
                clientY: 160,
            });

            setup.handleWheel(event);

            expect(setup.cancelPendingSearchScroll).toHaveBeenCalledOnce();
            expect(setup.singlePageScroll.cancelProgrammaticNavigation).toHaveBeenCalledOnce();
            expect(setup.singlePageScroll.handleWheel).toHaveBeenCalledWith(event);
            expect(setup.markUserViewportInteraction).toHaveBeenCalledOnce();
        } finally {
            setup.scope.stop();
        }
    });

    it('preserves programmatic navigation ownership for consumed single-page wheel packets', () => {
        const setup = setupWheelZoom();
        setup.singlePageScroll.handleWheel.mockReturnValue(true);

        try {
            const event = createWheelEvent({
                deltaY: 120,
                clientX: 120,
                clientY: 160,
            });

            setup.handleWheel(event);

            expect(setup.cancelPendingSearchScroll).toHaveBeenCalledOnce();
            expect(setup.singlePageScroll.handleWheel).toHaveBeenCalledWith(event);
            expect(setup.singlePageScroll.cancelProgrammaticNavigation).not.toHaveBeenCalled();
            expect(setup.markUserViewportInteraction).not.toHaveBeenCalled();
        } finally {
            setup.scope.stop();
        }
    });

    it('rebases cumulative wheel delta at the maximum zoom clamp', () => {
        const setup = setupWheelZoom();

        try {
            const zoomInToMax = createWheelEvent({
                deltaY: -10_000,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(zoomInToMax);

            expect(setup.emit).toHaveBeenCalledWith('update:effectiveZoom', ZOOM.MAX);
            expect(setup.emit).toHaveBeenCalledWith('update:zoomState', {
                kind: 'custom',
                scale: ZOOM.MAX,
            });

            setup.effectiveScale.value = ZOOM.MAX;
            setup.zoom.value = ZOOM.MAX;
            setup.emit.mockClear();

            const smallZoomOut = createWheelEvent({
                deltaY: 120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(smallZoomOut);

            const emittedEffectiveZoom = setup.emit.mock.calls.find(
                call => call[0] === 'update:effectiveZoom',
            )?.[1] as number | undefined;
            expect(emittedEffectiveZoom).toBeTypeOf('number');
            expect(emittedEffectiveZoom).toBeLessThan(ZOOM.MAX);
        } finally {
            setup.scope.stop();
        }
    });

    it('rebases cumulative wheel delta at the minimum zoom clamp', () => {
        const setup = setupWheelZoom();

        try {
            const zoomOutToMin = createWheelEvent({
                deltaY: 10_000,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(zoomOutToMin);

            expect(setup.emit).toHaveBeenCalledWith('update:effectiveZoom', ZOOM.MIN);
            expect(setup.emit).toHaveBeenCalledWith('update:zoomState', {
                kind: 'custom',
                scale: ZOOM.MIN,
            });

            setup.effectiveScale.value = ZOOM.MIN;
            setup.zoom.value = ZOOM.MIN;
            setup.emit.mockClear();

            const smallZoomIn = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(smallZoomIn);

            const emittedEffectiveZoom = setup.emit.mock.calls.find(
                call => call[0] === 'update:effectiveZoom',
            )?.[1] as number | undefined;
            expect(emittedEffectiveZoom).toBeTypeOf('number');
            expect(emittedEffectiveZoom).toBeGreaterThan(ZOOM.MIN);
        } finally {
            setup.scope.stop();
        }
    });

    it('submits the cursor semantic anchor with the zoom intent', () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(zoomEvent);

            expect(setup.submitZoomIntent).toHaveBeenCalledOnce();
            expect(setup.submitZoomIntent).toHaveBeenCalledWith({
                zoom: expect.any(Number),
                x: 120,
                y: 160,
            });
        } finally {
            setup.scope.stop();
        }
    });

    it('releases the virtualization freeze after the zoom session and expected scroll window settle', () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(zoomEvent);

            expect(setup.zoomVirtualizationFreeze.value).not.toBeNull();

            vi.advanceTimersByTime(2500);

            expect(setup.zoomVirtualizationFreeze.value).toBeNull();
        } finally {
            setup.scope.stop();
        }
    });

    it('clears an already-applied immediate restore intent when a later zoom packet is unchanged', async () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(zoomEvent);
            const emittedEffectiveZoom = setup.emit.mock.calls.find(
                call => call[0] === 'update:effectiveZoom',
            )?.[1] as number | undefined;
            if (typeof emittedEffectiveZoom !== 'number') {
                throw new Error('Expected effective zoom emit');
            }
            setup.effectiveScale.value = emittedEffectiveZoom;

            const noChangeZoomEvent = createWheelEvent({
                deltaY: 0.001,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.handleWheel(noChangeZoomEvent);

            setup.zoom.value = 1.1;
            await nextTick();

            expect(setup.submitZoomIntent).toHaveBeenCalledOnce();
        } finally {
            setup.scope.stop();
        }
    });
});
