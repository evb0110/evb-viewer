import {
    afterEach,
    describe,
    expect,
    expectTypeOf,
    it,
    vi,
} from 'vitest';
import type { IZoomStateAccess, TPdfZoomState } from '@contracts/shared';
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

function readScale(state: TPdfZoomState | undefined) {
    return state?.kind === 'custom' ? state.scale : NaN;
}

function createZoomOwner(scale = 1) {
    const requested = {value: {kind: 'custom', scale} as TPdfZoomState};
    const set = vi.fn((state: TPdfZoomState) => {
        requested.value = state;
    });
    const access: IZoomStateAccess = {
        get state() {
            return requested.value;
        },
        get manualScale() {
            return requested.value.kind === 'custom' ? requested.value.scale : scale;
        },
        set,
    };
    return {access, requested, set};
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
        const zoomEvent = createWheelEvent({
            metaKey: true,
            deltaY: -120,
        });
        const zoomInteraction = resolveDocumentWheelInteraction(zoomEvent, viewport, true);

        expect(consumeDocumentWheelZoomInteraction(zoomInteraction, {
            effectiveZoom: 1,
            emitZoom,
        })).toBe(true);
        expect(zoomEvent.preventDefault).toHaveBeenCalledOnce();
        expect(emitZoom).toHaveBeenCalledWith(expect.any(Number));

        const scrollEvent = createWheelEvent({ctrlKey: true});
        const scrollInteraction = resolveDocumentWheelInteraction(scrollEvent, viewport, true);
        expect(consumeDocumentWheelZoomInteraction(scrollInteraction, {
            effectiveZoom: 1,
            emitZoom,
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
            emitZoom: () => calls.push('zoom'),
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
        const {access} = createZoomOwner();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            () => access,
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
        const {access} = createZoomOwner();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            () => access,
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

    it('accumulates rapid packets while rendering lags and continues from the requested scale after a pause', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150)
            .mockReturnValueOnce(400);
        const {access, set: emit} = createZoomOwner();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            () => access,
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

        const emittedZooms = emit.mock.calls.map(call => call[0].kind === 'custom' ? call[0].scale : NaN);
        expect(emittedZooms[1]).toBeGreaterThan(emittedZooms[0]!);
        const resumed = resolveDocumentWheelZoomTarget(emittedZooms[1]!, 0, -120);
        expect(emittedZooms[2]).toBe(resumed.valid ? resumed.nextZoom : null);
    });

    it('continues after the renderer shows a delayed intermediate wheel scale', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(120)
            .mockReturnValueOnce(140);
        const effectiveZoom = {value: 1};
        const {access, set: emit} = createZoomOwner();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            () => access,
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        handler(interaction());
        effectiveZoom.value = readScale(emit.mock.calls[0]?.[0]);
        handler(interaction());

        const expected = resolveDocumentWheelZoomTarget(1, -240, -120);
        expect(expected.valid).toBe(true);
        expect(readScale(emit.mock.calls[2]?.[0])).toBe(expected.valid ? expected.nextZoom : null);
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
        const {access, set: emit} = createZoomOwner(ZOOM.MIN);
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: ZOOM.MIN},
            () => access,
            {beforeZoom},
        );
        for (let index = 0; index < 3; index += 1) {
            handler(resolveDocumentWheelInteraction(createWheelEvent({
                deltaY: -1,
                metaKey: true,
            }), viewport, true));
        }

        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({kind: 'custom'}));
        expect(beforeZoom).toHaveBeenCalledTimes(3);
    });

    it('restarts from an external zoom change during the gesture grace window', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const effectiveZoom = {value: 1};
        const {access, requested, set: emit} = createZoomOwner();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            () => access,
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);
        handler(interaction());
        requested.value = {kind: 'custom', scale: 2};
        handler(interaction());

        const expected = resolveDocumentWheelZoomTarget(2, 0, -120);
        expect(expected.valid).toBe(true);
        expect(readScale(emit.mock.calls[1]?.[0])).toBe(expected.valid ? expected.nextZoom : null);
        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            true,
        ]);
    });

    it('restarts a same-scale gesture after an external zoom-mode boundary', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const {access, requested, set: emit} = createZoomOwner();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            () => access,
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        requested.value = {kind: 'fit', axis: 'width'};
        handler(interaction());

        const emittedZooms = emit.mock.calls.map(([state]) => state.kind === 'custom' ? state.scale : NaN);
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
        const {access, requested, set: emit} = createZoomOwner();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            () => access,
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
        requested.value = {kind: 'custom', scale: 1};
        handler(interaction());

        expect(readScale(emit.mock.calls[1]?.[0])).toBe(readScale(emit.mock.calls[0]?.[0]));
        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            true,
        ]);
    });

    it('exposes an interaction-boundary reset for mousedown and external controls', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const {access, set: emit} = createZoomOwner();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            {value: 1},
            () => access,
            {beforeZoom},
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        handler.reset();
        const next = resolveDocumentWheelZoomTarget(readScale(emit.mock.calls[0]?.[0]), 0, -120);
        handler(interaction());

        expect(readScale(emit.mock.calls[1]?.[0])).toBe(next.valid ? next.nextZoom : null);
        expect(beforeZoom.mock.calls.map(call => call[2])).toEqual([
            true,
            true,
        ]);
    });

    it('restarts when an external command returns to an earlier zoom', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(120)
            .mockReturnValueOnce(140)
            .mockReturnValueOnce(160);
        const effectiveZoom = {value: 1};
        const {access, requested, set: emit} = createZoomOwner();
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            () => access,
        );
        const interaction = () => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true);

        handler(interaction());
        effectiveZoom.value = readScale(emit.mock.calls[0]?.[0]);
        handler(interaction());
        effectiveZoom.value = readScale(emit.mock.calls[1]?.[0]);
        handler(interaction());
        requested.value = {kind: 'custom', scale: 1};
        handler(interaction());

        const expected = resolveDocumentWheelZoomTarget(1, 0, -120);
        expect(expected.valid).toBe(true);
        expect(readScale(emit.mock.calls[3]?.[0])).toBe(expected.valid ? expected.nextZoom : null);
    });

    it('restarts from an external command after a coalesced wheel reversal', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(110)
            .mockReturnValueOnce(120)
            .mockReturnValueOnce(130)
            .mockReturnValueOnce(140);
        const effectiveZoom = {value: 1};
        const {access, requested, set: emit} = createZoomOwner();
        const beforeZoom = vi.fn();
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            () => access,
            {beforeZoom},
        );
        const interaction = (deltaY: number) => resolveDocumentWheelInteraction(createWheelEvent({
            deltaY,
            metaKey: true,
        }), viewport, true);

        handler(interaction(-120));
        handler(interaction(-120));
        handler(interaction(120));
        const firstEmittedZoom = readScale(emit.mock.calls[0]?.[0]);
        const supersededZoom = readScale(emit.mock.calls[1]?.[0]);
        effectiveZoom.value = firstEmittedZoom;
        handler(interaction(0));
        requested.value = {kind: 'custom', scale: supersededZoom};
        handler(interaction(-120));

        const expected = resolveDocumentWheelZoomTarget(supersededZoom, 0, -120);
        expect(expected.valid).toBe(true);
        expect(readScale(emit.mock.calls.at(-1)?.[0])).toBe(expected.valid ? expected.nextZoom : null);
        expect(beforeZoom.mock.calls.at(-1)?.[2]).toBe(true);
    });

    it('resets its session and notifies the lifecycle on non-zoom input', () => {
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(150);
        const {access, requested, set: emit} = createZoomOwner();
        const onNonZoom = vi.fn();
        const effectiveZoom = {value: 1};
        const handler = createDocumentWheelZoomHandler(
            effectiveZoom,
            () => access,
            {onNonZoom},
        );
        handler(resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true));
        expect(handler(resolveDocumentWheelInteraction(createWheelEvent(), viewport, true))).toBe(false);
        requested.value = {kind: 'custom', scale: 2};
        handler(resolveDocumentWheelInteraction(createWheelEvent({
            deltaY: -120,
            metaKey: true,
        }), viewport, true));

        const expected = resolveDocumentWheelZoomTarget(2, 0, -120);
        expect(onNonZoom).toHaveBeenCalledOnce();
        expect(readScale(emit.mock.calls[1]?.[0])).toBe(expected.valid ? expected.nextZoom : null);
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
                emitZoom,
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
                emitZoom,
            },
            {beforeZoom},
        )).toBe(true);
        expect(beforeZoom).not.toHaveBeenCalled();
        expect(emitZoom).not.toHaveBeenCalled();
    });
});
