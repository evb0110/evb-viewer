import {
    describe,
    expect,
    it,
} from 'vitest';
import { createWheelFlipGate } from '@app/modules/document-viewer/single-page-wheel/createWheelFlipGate';

describe('createWheelFlipGate', () => {
    it('blocks same-direction flips inside the cooldown window', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, {
            timeStamp: 10,
            deltaY: 120,
        });

        expect(gate.shouldBlockFlip(1, {
            timeStamp: 40,
            deltaY: 120,
        })).toBe(true);
        // After a quiet gap (>= 200ms) a new gesture flips immediately.
        expect(gate.shouldBlockFlip(1, {
            timeStamp: 240,
            deltaY: 120,
        })).toBe(false);
    });

    it('allows immediate flips after direction changes', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, {
            timeStamp: 10,
            deltaY: 120,
        });

        expect(gate.shouldBlockFlip(-1, {
            timeStamp: 40,
            deltaY: -40,
        })).toBe(false);
    });

    it('blocks decaying inertia tails of any length for both small and large smooth scrolls', () => {
        const gate = createWheelFlipGate();

        // Small smooth scroll starting at deltaY=36 and decaying over 900ms.
        gate.recordFlip(1, {
            timeStamp: 10,
            deltaY: 36,
        });
        for (let step = 1; step <= 30; step += 1) {
            const deltaY = Math.max(1, Math.round(36 * Math.exp(-0.12 * step)));
            expect(gate.shouldBlockFlip(1, {
                timeStamp: 10 + step * 30,
                deltaY,
            })).toBe(true);
        }

        // After a quiet pause (>= 200ms), the next scroll starts a new gesture and flips.
        expect(gate.shouldBlockFlip(1, {
            timeStamp: 1_150,
            deltaY: 36,
        })).toBe(false);
    });

    it('tracks the peak delta of an ease-in smooth scroll so its decaying tail stays blocked', () => {
        const gate = createWheelFlipGate();

        // Smooth scroll ramps up (8 -> 24 -> 52) then decays (34 -> 20 -> 10 -> 4).
        gate.recordFlip(1, {
            timeStamp: 0,
            deltaY: 8,
        });
        expect(gate.shouldBlockFlip(1, {
            timeStamp: 16,
            deltaY: 24,
        })).toBe(true);
        expect(gate.shouldBlockFlip(1, {
            timeStamp: 32,
            deltaY: 52,
        })).toBe(true);
        for (const [
            timeStamp,
            deltaY,
        ] of [
            [120, 34],
            [200, 20],
            [280, 12],
            [360, 6],
        ] as const) {
            expect(gate.shouldBlockFlip(1, {
                timeStamp,
                deltaY,
            })).toBe(true);
        }
    });

    it('blocks non-cancelable native inertia packets regardless of spacing', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, {
            timeStamp: 0,
            deltaY: 120,
            cancelable: true,
        });

        expect(gate.shouldBlockFlip(1, {
            timeStamp: 350,
            deltaY: 120,
            cancelable: false,
        })).toBe(true);
        expect(gate.shouldBlockFlip(1, {
            timeStamp: 800,
            deltaY: 120,
            cancelable: false,
        })).toBe(true);
        // A new cancelable packet after a non-cancelable sequence starts a new gesture.
        expect(gate.shouldBlockFlip(1, {
            timeStamp: 850,
            deltaY: 120,
            cancelable: true,
        })).toBe(false);
    });

    it('absorbs mid-gesture horizontal or diagonal jitter without resetting or falsely reversing the flip gate', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, {
            timeStamp: 10,
            deltaY: 80,
        });
        // Diagonal jitter (even with a tiny opposing deltaY wobble) belongs to the active flip gesture.
        expect(gate.consumeGestureJitter({
            timeStamp: 30,
            deltaY: -1,
        })).toBe(true);
        expect(gate.shouldBlockFlip(1, {
            timeStamp: 50,
            deltaY: 20,
        })).toBe(true);

        // Once the gesture goes quiet, jitter is no longer absorbed.
        expect(gate.consumeGestureJitter({
            timeStamp: 300,
            deltaY: 0,
        })).toBe(false);
    });

    it('allows sustained full-strength cancelable notched-wheel spinning at a steady cadence', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, {
            timeStamp: 0,
            deltaY: 180,
            cancelable: true,
        });
        for (const timeStamp of [
            40,
            80,
            120,
            160,
            200,
            240,
        ]) {
            expect(gate.shouldBlockFlip(1, {
                timeStamp,
                deltaY: 180,
                cancelable: true,
            })).toBe(true);
        }
        expect(gate.shouldBlockFlip(1, {
            timeStamp: 280,
            deltaY: 180,
            cancelable: true,
        })).toBe(false);
    });

    it('keeps blocking a slowly decreasing same-direction tail even above the delta floor', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, {
            timeStamp: 0,
            deltaY: 120,
            cancelable: true,
        });
        for (const [
            timeStamp,
            deltaY,
        ] of [
            [70, 116],
            [140, 112],
            [210, 108],
            [280, 104],
        ] as const) {
            expect(gate.shouldBlockFlip(1, {
                timeStamp,
                deltaY,
                cancelable: true,
            })).toBe(true);
        }
    });

    it('keeps blocking a rounded decaying plateau below peak while allowing steady full-strength line-mode notches', () => {
        const decayingGate = createWheelFlipGate();
        decayingGate.recordFlip(1, {
            timeStamp: 0,
            deltaY: 120,
            cancelable: true,
        });
        for (const [
            timeStamp,
            deltaY,
        ] of [
            [90, 112],
            [180, 100],
            [270, 100],
        ] as const) {
            expect(decayingGate.shouldBlockFlip(1, {
                timeStamp,
                deltaY,
                cancelable: true,
            })).toBe(true);
        }

        // Normalized 3-line wheel notches (3 * 16 = 48 px) renew cleanly at steady cadence.
        const lineModeGate = createWheelFlipGate();
        lineModeGate.recordFlip(1, {
            timeStamp: 0,
            deltaY: 48,
            cancelable: true,
        });
        expect(lineModeGate.shouldBlockFlip(1, {
            timeStamp: 140,
            deltaY: 48,
            cancelable: true,
        })).toBe(true);
        expect(lineModeGate.shouldBlockFlip(1, {
            timeStamp: 280,
            deltaY: 48,
            cancelable: true,
        })).toBe(false);
    });

    it('allows the next edge flip after interior page scrolling', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, {
            timeStamp: 10,
            deltaY: 120,
        });
        gate.recordInteriorScroll({
            timeStamp: 40,
            deltaY: 30,
        });

        expect(gate.shouldBlockFlip(1, {
            timeStamp: 200,
            deltaY: 30,
        })).toBe(false);
    });

    it('clears gate state on reset', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, {
            timeStamp: 10,
            deltaY: 120,
        });
        gate.reset();

        expect(gate.shouldBlockFlip(1, {
            timeStamp: 40,
            deltaY: 120,
        })).toBe(false);
    });
});
