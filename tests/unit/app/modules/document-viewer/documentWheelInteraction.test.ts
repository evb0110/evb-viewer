import {
    afterEach,
    describe,
    expect,
    expectTypeOf,
    it,
    vi,
} from 'vitest';
import { ZOOM } from '@app/constants/pdfLayout';
import {
    consumeDocumentWheelZoomInteraction,
    createDocumentWheelZoomHandler,
    isDocumentWheelZoomSessionBoundaryKey,
    resolveDocumentWheelInteraction,
    resolveDocumentWheelIntent,
    resolveDocumentWheelZoomTarget,
    shouldResetDocumentWheelZoomSession,
    type IDocumentWheelInteraction,
} from '@app/modules/document-viewer/input/documentWheelInteraction';

function createWheelEvent(overrides: Partial<WheelEvent> = {}) {
    const preventDefault = vi.fn();
    return {
        ctrlKey: false,
        deltaMode: 0,
        deltaY: 120,
        deltaZ: 0,
        metaKey: false,
        preventDefault,
        ...overrides,
    } as WheelEvent;
}

const viewport = {clientHeight: 800} as HTMLElement;

describe('document wheel interaction policy', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        {
            expected: false,
            key: 'Control',
            repeat: false,
        },
        {
            expected: false,
            key: 'Meta',
            repeat: false,
        },
        {
            expected: false,
            key: 'Shift',
            repeat: false,
        },
        {
            expected: false,
            key: 'Alt',
            repeat: false,
        },
        {
            expected: false,
            key: 'AltGraph',
            repeat: false,
        },
        {
            expected: false,
            key: 'ArrowDown',
            repeat: true,
        },
        {
            expected: true,
            key: 'ArrowDown',
            repeat: false,
        },
        {
            expected: true,
            key: 'Escape',
            repeat: false,
        },
    ])('classifies $key repeat=$repeat as a wheel-session boundary: $expected', ({
        expected,
        key,
        repeat,
    }) => {
        expect(isDocumentWheelZoomSessionBoundaryKey({
            key,
            repeat,
        })).toBe(expected);
    });

    it('allows only the interaction-active viewer to reset a wheel session', () => {
        const pointerdown = {type: 'pointerdown'};
        const modifierKeydown = {
            key: 'Meta',
            repeat: false,
            type: 'keydown',
        };
        const navigationKeydown = {
            key: 'PageDown',
            repeat: false,
            type: 'keydown',
        };

        expect(shouldResetDocumentWheelZoomSession(false, pointerdown)).toBe(false);
        expect(shouldResetDocumentWheelZoomSession(true, modifierKeydown)).toBe(false);
        expect(shouldResetDocumentWheelZoomSession(true, navigationKeydown)).toBe(true);
        expect(shouldResetDocumentWheelZoomSession(true, pointerdown)).toBe(true);
    });

    it('keeps physical modifier and depth-axis signals behind the shared resolver', () => {
        type TSourceEvent = IDocumentWheelInteraction['event'];
        expectTypeOf<'ctrlKey' extends keyof TSourceEvent ? true : false>().toEqualTypeOf<false>();
        expectTypeOf<'metaKey' extends keyof TSourceEvent ? true : false>().toEqualTypeOf<false>();
        expectTypeOf<'deltaZ' extends keyof TSourceEvent ? true : false>().toEqualTypeOf<false>();
    });

    it.each([
        {
            expected: 'scroll',
            event: createWheelEvent(),
            isMac: true,
            label: 'plain macOS wheel',
        },
        {
            expected: 'platform-scroll',
            event: createWheelEvent({ctrlKey: true}),
            isMac: true,
            label: 'macOS Control-wheel',
        },
        {
            expected: 'zoom',
            event: createWheelEvent({metaKey: true}),
            isMac: true,
            label: 'macOS Command-wheel',
        },
        {
            expected: 'zoom',
            event: createWheelEvent({ctrlKey: true}),
            isMac: false,
            label: 'non-Mac Control-wheel',
        },
        {
            expected: 'zoom',
            event: createWheelEvent({
                deltaY: 0,
                deltaZ: 2,
            }),
            isMac: true,
            label: 'unmodified depth-axis gesture',
        },
        {
            expected: 'zoom',
            event: createWheelEvent({
                ctrlKey: true,
                metaKey: true,
            }),
            isMac: true,
            label: 'macOS Command-Control-wheel',
        },
    ])('resolves $label as $expected', ({
        event,
        expected,
        isMac,
    }) => {
        expect(resolveDocumentWheelIntent(event, isMac)).toBe(expected);
    });

    it('normalizes line, page, and depth-axis deltas at the shared viewport boundary', () => {
        expect(resolveDocumentWheelInteraction(
            createWheelEvent({
                deltaMode: 1,
                deltaY: 3,
            }),
            viewport,
            false,
        ).deltaPx).toBe(48);
        expect(resolveDocumentWheelInteraction(
            createWheelEvent({
                deltaMode: 2,
                deltaY: 2,
            }),
            viewport,
            false,
        ).deltaPx).toBe(1_600);
        expect(resolveDocumentWheelInteraction(
            createWheelEvent({
                deltaY: 0,
                deltaZ: -4,
            }),
            viewport,
            false,
        ).deltaPx).toBe(-4);
    });

    it('uses one cumulative scaling and clamping policy for every renderer', () => {
        const first = resolveDocumentWheelZoomTarget(1, 0, -120);
        expect(first.valid).toBe(true);
        if (!first.valid) {
            return;
        }
        const second = resolveDocumentWheelZoomTarget(1, first.cumulativeDelta, -120);
        expect(second.valid).toBe(true);
        if (!second.valid) {
            return;
        }
        expect(second.nextZoom).toBeGreaterThan(first.nextZoom);

        const maximum = resolveDocumentWheelZoomTarget(1, 0, -10_000);
        expect(maximum.valid && maximum.nextZoom).toBe(ZOOM.MAX);

        const belowMinimum = resolveDocumentWheelZoomTarget(ZOOM.MIN / 2, 0, 120);
        expect(belowMinimum).toMatchObject({
            cumulativeDelta: 0,
            reason: 'below-manual-min-zoom-out',
            valid: false,
        });
    });

    it('supports a feature-specific fitted minimum while preserving cumulative zoom', () => {
        const first = resolveDocumentWheelZoomTarget(0.4, 0, -1, {
            minimumZoom: 0.4,
            maximumZoom: ZOOM.MAX,
        });
        expect(first.valid).toBe(true);
        if (!first.valid) {
            return;
        }
        expect(first.nextEffectiveZoom).toBeGreaterThan(0.4);

        const zoomOut = resolveDocumentWheelZoomTarget(
            0.4,
            first.cumulativeDelta,
            2,
            {
                minimumZoom: 0.4,
                maximumZoom: ZOOM.MAX,
            },
        );
        expect(zoomOut.valid).toBe(true);
        if (zoomOut.valid) {
            expect(zoomOut.nextEffectiveZoom).toBe(0.4);
        }
    });

    it('consumes only zoom interactions and emits a shared custom-zoom transition', () => {
        const emitZoom = vi.fn();
        const emitZoomMode = vi.fn();
        const zoomEvent = createWheelEvent({
            metaKey: true,
            deltaY: -120,
        });
        const zoomInteraction = resolveDocumentWheelInteraction(zoomEvent, viewport, true);

        expect(consumeDocumentWheelZoomInteraction(zoomInteraction, {
            effectiveZoom: 1,
            zoomMode: 'fit-width',
            emitZoom,
            emitZoomMode,
        })).toBe(true);
        expect(zoomEvent.preventDefault).toHaveBeenCalledOnce();
        expect(emitZoomMode).toHaveBeenCalledWith('custom');
        expect(emitZoom).toHaveBeenCalledWith(expect.any(Number));

        const scrollEvent = createWheelEvent({ctrlKey: true});
        const scrollInteraction = resolveDocumentWheelInteraction(scrollEvent, viewport, true);
        expect(consumeDocumentWheelZoomInteraction(scrollInteraction, {
            effectiveZoom: 1,
            zoomMode: 'custom',
            emitZoom,
            emitZoomMode,
        })).toBe(false);
        expect(scrollEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('captures the pointer anchor before publishing a zoom mutation', () => {
        const calls: string[] = [];
        const zoomEvent = createWheelEvent({
            metaKey: true,
            deltaY: -120,
        });
        const zoomInteraction = resolveDocumentWheelInteraction(zoomEvent, viewport, true);

        expect(consumeDocumentWheelZoomInteraction(zoomInteraction, {
            effectiveZoom: 1,
            zoomMode: 'custom',
            emitZoom: () => calls.push('zoom'),
            emitZoomMode: () => calls.push('mode'),
        }, {beforeZoom: () => calls.push('anchor')})).toBe(true);
        expect(calls).toEqual([
            'anchor',
            'zoom',
        ]);
    });

    it('shares the handler packet clock with the pointer-anchor callback', () => {
        const now = vi.spyOn(performance, 'now')
            .mockReturnValueOnce(179.999)
            .mockReturnValueOnce(180.001);
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            {value: 'custom'},
            vi.fn(),
            {beforeZoom},
        );
        const interaction = resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction);

        expect(now).toHaveBeenCalledOnce();
        expect(beforeZoom).toHaveBeenCalledWith(interaction, 179.999, true);
    });

    it('starts a new session at the exact gesture grace boundary', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(179)
            .mockReturnValueOnce(359);
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            {value: 'custom'},
            vi.fn(),
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -1,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        handler(interaction());
        handler(interaction());

        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            false,
            true,
        ]);
    });

    it('accumulates rapid packets before the parent publishes the prior zoom value', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150)
            .mockReturnValueOnce(400);
        const emit = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            {value: 'custom'},
            emit,
        );
        handler(resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
            timeStamp: 100,
        }), viewport, true));
        handler(resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
            timeStamp: 150,
        }), viewport, true));
        handler(resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
            timeStamp: 400,
        }), viewport, true));

        const emittedZooms = emit.mock.calls.map(call => call[1] as number);
        expect(emittedZooms[1]).toBeGreaterThan(emittedZooms[0]!);
        expect(emittedZooms[2]).toBe(emittedZooms[0]);
    });

    it('continues after the parent publishes a delayed intermediate wheel value', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(120)
            .mockReturnValueOnce(140);
        const effectiveZoom = {value: 1};
        const emit = vi.fn();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            {value: 'custom'},
            emit,
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        handler(interaction());
        effectiveZoom.value = emit.mock.calls[0]?.[1] as number;
        handler(interaction());

        const expected = resolveDocumentWheelZoomTarget(1, -240, -120);
        expect(expected.valid).toBe(true);
        expect(emit.mock.calls[2]?.[1]).toBe(expected.valid ? expected.nextZoom : null);
        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            false,
            false,
        ]);
    });

    it('accumulates sub-threshold deltas until they produce a visible zoom', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(10)
            .mockReturnValueOnce(20);
        const emit = vi.fn();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: ZOOM.MIN},
            {value: 'custom'},
            emit,
            {beforeZoom},
        );
        for (let index = 0; index < 3; index += 1) {
            handler(resolveDocumentWheelInteraction(createWheelEvent({
                deltaY: -1,
                metaKey: true,
            }), viewport, true));
        }

        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith('update:zoom', expect.any(Number));
        expect(beforeZoom).toHaveBeenCalledTimes(3);
    });

    it('restarts from an external zoom change during the gesture grace window', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const effectiveZoom = {value: 1};
        const emit = vi.fn();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            {value: 'custom'},
            emit,
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);
        handler(interaction());
        effectiveZoom.value = 2;
        handler(interaction());

        const expected = resolveDocumentWheelZoomTarget(2, 0, -120);
        expect(expected.valid).toBe(true);
        expect(emit.mock.calls[1]?.[1]).toBe(expected.valid ? expected.nextZoom : null);
        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            true,
        ]);
    });

    it('restarts a same-scale gesture after an external zoom-mode boundary', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const zoomMode = {value: 'custom' as 'custom' | 'fit-width'};
        const emit = vi.fn();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            zoomMode,
            emit,
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        zoomMode.value = 'fit-width';
        handler(interaction());

        const emittedZooms = emit.mock.calls
            .filter(call => call[0] === 'update:zoom')
            .map(call => call[1]);
        expect(emittedZooms).toEqual([
            emittedZooms[0],
            emittedZooms[0],
        ]);
        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            true,
        ]);
    });

    it('restarts a same-scale gesture when its document session changes', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const sessionKey = {value: 'first'};
        const emit = vi.fn();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            {value: 'custom'},
            emit,
            {
                beforeZoom,
                readSessionKey: () => sessionKey.value,
            },
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        sessionKey.value = 'second';
        handler(interaction());

        expect(emit.mock.calls[1]?.[1]).toBe(emit.mock.calls[0]?.[1]);
        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            true,
        ]);
    });

    it('exposes an interaction-boundary reset for mousedown and external controls', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const emit = vi.fn();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            {value: 'custom'},
            emit,
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        handler.reset();
        handler(interaction());

        expect(emit.mock.calls[1]?.[1]).toBe(emit.mock.calls[0]?.[1]);
        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            true,
        ]);
    });

    it('restarts when an external change returns to an acknowledged earlier zoom', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(120)
            .mockReturnValueOnce(140)
            .mockReturnValueOnce(160);
        const effectiveZoom = {value: 1};
        const emit = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            {value: 'custom'},
            emit,
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        effectiveZoom.value = emit.mock.calls[0]?.[1] as number;
        handler(interaction());
        effectiveZoom.value = emit.mock.calls[1]?.[1] as number;
        handler(interaction());
        effectiveZoom.value = 1;
        handler(interaction());

        const expected = resolveDocumentWheelZoomTarget(1, 0, -120);
        expect(expected.valid).toBe(true);
        expect(emit.mock.calls[3]?.[1]).toBe(expected.valid ? expected.nextZoom : null);
    });

    it('retires duplicate coalesced emits before reconciling an external reset', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(110)
            .mockReturnValueOnce(120)
            .mockReturnValueOnce(130)
            .mockReturnValueOnce(140);
        const effectiveZoom = {value: 1};
        const emit = vi.fn();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            {value: 'custom'},
            emit,
            {beforeZoom},
        );
        const interaction = (deltaY: number) => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY,
            metaKey: true,
        }), viewport, true);

        handler(interaction(-120));
        handler(interaction(-120));
        handler(interaction(120));
        const firstEmittedZoom = emit.mock.calls[0]?.[1] as number;
        const supersededZoom = emit.mock.calls[1]?.[1] as number;
        effectiveZoom.value = firstEmittedZoom;
        handler(interaction(0));
        effectiveZoom.value = supersededZoom;
        handler(interaction(-120));

        const expected = resolveDocumentWheelZoomTarget(supersededZoom, 0, -120);
        expect(expected.valid).toBe(true);
        expect(emit.mock.calls.at(-1)?.[1]).toBe(expected.valid ? expected.nextZoom : null);
        expect(beforeZoom.mock.calls.at(-1)?.[2]).toBe(true);
    });

    it('resets its session and notifies the lifecycle on non-zoom input', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const emit = vi.fn();
        const onNonZoom = vi.fn();
        const effectiveZoom = {value: 1};
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            {value: 'custom'},
            emit,
            {onNonZoom},
        );
        handler(resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true));
        expect(handler(resolveDocumentWheelInteraction(createWheelEvent(), viewport, true))).toBe(false);
        effectiveZoom.value = 2;
        handler(resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true));

        const expected = resolveDocumentWheelZoomTarget(2, 0, -120);
        expect(onNonZoom).toHaveBeenCalledOnce();
        expect(emit.mock.calls[1]?.[1]).toBe(expected.valid ? expected.nextZoom : null);
    });

    it('does not replace the active anchor for a clamped no-op packet', () => {
        const beforeZoom = vi.fn();
        const emitZoom = vi.fn();
        const zoomEvent = createWheelEvent({
            metaKey: true,
            deltaY: -120,
        });

        expect(consumeDocumentWheelZoomInteraction(
            resolveDocumentWheelInteraction(zoomEvent, viewport, true),
            {
                effectiveZoom: ZOOM.MAX,
                zoomMode: 'custom',
                emitZoom,
                emitZoomMode: vi.fn(),
            },
            {beforeZoom},
        )).toBe(true);
        expect(beforeZoom).not.toHaveBeenCalled();
        expect(emitZoom).not.toHaveBeenCalled();
    });

    it('does not replace the active anchor for a near-limit clamped no-op packet', () => {
        const beforeZoom = vi.fn();
        const emitZoom = vi.fn();
        const effectiveZoom = ZOOM.MAX - 0.0005;
        const zoomEvent = createWheelEvent({
            metaKey: true,
            deltaY: -1,
        });

        expect(consumeDocumentWheelZoomInteraction(
            resolveDocumentWheelInteraction(zoomEvent, viewport, true),
            {
                effectiveZoom,
                zoomMode: 'custom',
                emitZoom,
                emitZoomMode: vi.fn(),
            },
            {beforeZoom},
        )).toBe(true);
        expect(beforeZoom).not.toHaveBeenCalled();
        expect(emitZoom).not.toHaveBeenCalled();
    });
});
