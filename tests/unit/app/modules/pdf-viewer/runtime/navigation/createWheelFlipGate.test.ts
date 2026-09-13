import {
    describe,
    expect,
    it,
} from 'vitest';
import { createWheelFlipGate } from '@app/modules/document-viewer/single-page-wheel/createWheelFlipGate';

describe('createWheelFlipGate', () => {
    it('blocks same-direction flips inside the cooldown window', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);

        expect(gate.shouldBlockFlip(1, 40)).toBe(true);
        expect(gate.shouldBlockFlip(1, 190)).toBe(false);
    });

    it('allows immediate flips after direction changes', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);
        gate.recordWheelPacket(20);

        expect(gate.shouldBlockFlip(-1, 40)).toBe(false);
    });

    it('blocks same-direction flips in the same pixel-wheel gesture when requested', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10, 120);
        gate.recordWheelPacket(160, 30);

        expect(gate.shouldBlockFlip(1, 260, { delta: 30 })).toBe(false);
        expect(gate.shouldBlockFlip(1, 260, {
            delta: 30,
            requireGestureIdle: true,
        })).toBe(true);

        gate.recordWheelPacket(260, 30);
        expect(gate.shouldBlockFlip(1, 470, {
            delta: 120,
            requireGestureIdle: true,
        })).toBe(false);
    });

    it('keeps blocking same-direction pixel-wheel tails after the bounded inertia window', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10, 120);
        gate.recordWheelPacket(390, 30);

        expect(gate.shouldBlockFlip(1, 410, {
            delta: 30,
            requireGestureIdle: true,
        })).toBe(true);

        gate.recordWheelPacket(410, 30);
        expect(gate.shouldBlockFlip(1, 430, {
            delta: 30,
            requireGestureIdle: true,
        })).toBe(true);

        gate.recordWheelPacket(430, 30);
        expect(gate.shouldBlockFlip(1, 590, {
            delta: 30,
            requireGestureIdle: true,
        })).toBe(true);

        gate.recordWheelPacket(590, 30);
        expect(gate.shouldBlockFlip(1, 720, {
            delta: 30,
            requireGestureIdle: true,
        })).toBe(false);
    });

    it('allows renewed same-direction gestures after the bounded inertia window', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10, 120);
        gate.recordWheelPacket(390, 120);

        expect(gate.shouldBlockFlip(1, 410, {
            delta: 120,
            requireGestureIdle: true,
        })).toBe(true);

        gate.recordWheelPacket(410, 120);
        expect(gate.shouldBlockFlip(1, 430, {
            delta: 120,
            requireGestureIdle: true,
        })).toBe(false);
    });

    it('allows sustained small-delta trackpad gestures after the finite block window', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10, 30);
        gate.recordWheelPacket(190, 15);

        expect(gate.shouldBlockFlip(1, 210, {
            delta: 15,
            requireGestureIdle: true,
        })).toBe(true);

        gate.recordWheelPacket(210, 15);
        expect(gate.shouldBlockFlip(1, 250, {
            delta: 15,
            requireGestureIdle: true,
        })).toBe(false);

        gate.recordWheelPacket(250, 15);
        expect(gate.shouldBlockFlip(1, 310, {
            delta: 15,
            requireGestureIdle: true,
        })).toBe(false);
    });

    it('allows the next edge flip after interior page scrolling', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10, 120);
        gate.recordWheelPacket(40, 30);
        gate.recordInteriorScroll();

        expect(gate.shouldBlockFlip(1, 260, {
            delta: 30,
            requireGestureIdle: true,
        })).toBe(false);
    });

    it('clears cooldown state on reset', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);
        gate.reset();

        expect(gate.shouldBlockFlip(1, 40)).toBe(false);
    });
});
