// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { schedulePdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/schedulePdfLayerVisualSnapshotRelease';

describe('schedulePdfLayerVisualSnapshotRelease', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('waits for the configured number of frames before releasing a layer snapshot', () => {
        const release = vi.fn();
        const frames: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame')
            .mockImplementation(callback => {
                frames.push(callback);
                return frames.length;
            });

        schedulePdfLayerVisualSnapshotRelease(release, {minFrames: 2});

        expect(requestAnimationFrame).toHaveBeenCalledOnce();
        frames.shift()?.(0);
        expect(release).not.toHaveBeenCalled();
        expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

        frames.shift()?.(0);
        expect(release).toHaveBeenCalledOnce();
    });

    it('releases at the hard deadline even when the wait predicate never settles', () => {
        vi.useFakeTimers();
        const release = vi.fn();
        const frames: FrameRequestCallback[] = [];
        vi.spyOn(window, 'requestAnimationFrame')
            .mockImplementation(callback => {
                frames.push(callback);
                return frames.length;
            });

        schedulePdfLayerVisualSnapshotRelease(release, {
            maxDelayMs: 100,
            waitFor: () => false,
        });

        frames.shift()?.(0);
        expect(release).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        frames.shift()?.(100);

        expect(release).toHaveBeenCalledOnce();
    });

    it('cancels a pending animation frame', () => {
        const release = vi.fn();
        const frames: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame')
            .mockImplementation(callback => {
                frames.push(callback);
                return frames.length;
            });
        const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame');

        const cancel = schedulePdfLayerVisualSnapshotRelease(release, {waitFor: () => false});
        cancel();
        frames.shift()?.(0);

        expect(cancelAnimationFrame).toHaveBeenCalledWith(requestAnimationFrame.mock.results[0]?.value);
        expect(release).not.toHaveBeenCalled();
    });
});
