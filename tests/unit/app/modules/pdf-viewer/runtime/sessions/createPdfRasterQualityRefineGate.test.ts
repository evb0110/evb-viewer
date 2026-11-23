// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createPdfRasterQualityRefineGate } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRasterQualityRefineGate';

const QUALITY_REFINE_INPUT_IDLE_MS = 160;

function createGate(overrides: {
    hasActiveTransaction?: () => boolean;
    getInteractionEpoch?: () => number;
} = {}) {
    const requestReconcileFrame = vi.fn();
    const gate = createPdfRasterQualityRefineGate({
        getClampedVisibleRefineMode: () => 'input-idle',
        getInteractionEpoch: overrides.getInteractionEpoch ?? (() => 1),
        hasActiveTransaction: overrides.hasActiveTransaction ?? (() => false),
        requestReconcileFrame,
    });

    return {
        gate,
        requestReconcileFrame,
    };
}

describe('createPdfRasterQualityRefineGate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('refines without waiting under the immediate policy', () => {
        const requestReconcileFrame = vi.fn();
        const gate = createPdfRasterQualityRefineGate({
            getClampedVisibleRefineMode: () => 'immediate',
            getInteractionEpoch: () => 1,
            hasActiveTransaction: () => true,
            requestReconcileFrame,
        });

        expect(gate.canRefineVisibleRaster()).toBe(true);
        vi.advanceTimersByTime(QUALITY_REFINE_INPUT_IDLE_MS * 2);
        expect(requestReconcileFrame).not.toHaveBeenCalled();
    });

    it('comes back when the open idle window closes rather than a full window later', () => {
        const {
            gate,
            requestReconcileFrame,
        } = createGate();

        vi.advanceTimersByTime(60);
        expect(gate.canRefineVisibleRaster()).toBe(false);

        vi.advanceTimersByTime(QUALITY_REFINE_INPUT_IDLE_MS - 60 - 1);
        expect(requestReconcileFrame).not.toHaveBeenCalled();

        // The remaining 100ms of the window, not another 160ms on top of it.
        vi.advanceTimersByTime(1);
        expect(requestReconcileFrame).toHaveBeenCalledTimes(1);
        expect(gate.canRefineVisibleRaster()).toBe(true);
    });

    it('holds the refine without polling while a live transaction blocks it', () => {
        let activeTransaction = true;
        const {
            gate,
            requestReconcileFrame,
        } = createGate({hasActiveTransaction: () => activeTransaction});

        // The idle window is long gone; only the transaction holds the refine.
        vi.advanceTimersByTime(QUALITY_REFINE_INPUT_IDLE_MS + 40);
        expect(gate.canRefineVisibleRaster()).toBe(false);

        // No timer asks again: the transaction's end republishes the demand.
        vi.advanceTimersByTime(QUALITY_REFINE_INPUT_IDLE_MS * 10);
        expect(requestReconcileFrame).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        activeTransaction = false;
        expect(gate.canRefineVisibleRaster()).toBe(true);
    });

    it('keeps the quiet window under a transaction, then waits for the transaction alone', () => {
        let activeTransaction = true;
        const {
            gate,
            requestReconcileFrame,
        } = createGate({hasActiveTransaction: () => activeTransaction});

        vi.advanceTimersByTime(60);
        expect(gate.canRefineVisibleRaster()).toBe(false);
        vi.advanceTimersByTime(QUALITY_REFINE_INPUT_IDLE_MS - 60);
        expect(requestReconcileFrame).toHaveBeenCalledTimes(1);

        // The window closed while the transaction still runs: nothing re-arms.
        expect(gate.canRefineVisibleRaster()).toBe(false);
        vi.advanceTimersByTime(QUALITY_REFINE_INPUT_IDLE_MS * 10);
        expect(requestReconcileFrame).toHaveBeenCalledTimes(1);

        activeTransaction = false;
        expect(gate.canRefineVisibleRaster()).toBe(true);
    });

    it('restarts the idle window whenever the interaction epoch moves', () => {
        let epoch = 1;
        const {
            gate,
            requestReconcileFrame,
        } = createGate({getInteractionEpoch: () => epoch});

        vi.advanceTimersByTime(120);
        expect(gate.canRefineVisibleRaster()).toBe(false);

        // A scroll lands mid-window. The demand loop reports it, which drops
        // the pending retry and starts the window again from here.
        epoch += 1;
        gate.synchronizeViewportInteractionEpoch();
        vi.advanceTimersByTime(QUALITY_REFINE_INPUT_IDLE_MS - 1);
        expect(requestReconcileFrame).not.toHaveBeenCalled();
        expect(gate.canRefineVisibleRaster()).toBe(false);

        vi.advanceTimersByTime(1);
        expect(requestReconcileFrame).toHaveBeenCalledTimes(1);
        expect(gate.canRefineVisibleRaster()).toBe(true);
    });

    it('drops a pending retry when the idle timer is cleared', () => {
        const {
            gate,
            requestReconcileFrame,
        } = createGate();

        expect(gate.canRefineVisibleRaster()).toBe(false);
        gate.clearIdleTimer();

        vi.advanceTimersByTime(QUALITY_REFINE_INPUT_IDLE_MS * 2);
        expect(requestReconcileFrame).not.toHaveBeenCalled();
    });
});
