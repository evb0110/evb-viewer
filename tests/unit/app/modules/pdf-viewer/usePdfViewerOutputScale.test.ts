// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { effectScope } from 'vue';
import {usePdfViewerOutputScale} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerOutputScale';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

const performancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: false,
    lowMemory: false,
});
const constrainedPerformancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: true,
    lowMemory: false,
});

interface IMediaQueryListDouble {
    media: string;
    matches: boolean;
    onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null;
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    dispatchEvent: ReturnType<typeof vi.fn>;
}

function setDevicePixelRatio(value: number) {
    Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value,
    });
}

describe('usePdfViewerOutputScale', () => {
    const mediaQueries: IMediaQueryListDouble[] = [];
    let originalDevicePixelRatio = 1;
    let originalMatchMedia: typeof window.matchMedia | undefined;

    beforeEach(() => {
        mediaQueries.length = 0;
        originalDevicePixelRatio = window.devicePixelRatio;
        originalMatchMedia = window.matchMedia;
        setDevicePixelRatio(1);
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            value: vi.fn((query: string) => {
                const mediaQuery = {
                    media: query,
                    matches: true,
                    onchange: null,
                    addListener: vi.fn(),
                    removeListener: vi.fn(),
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                    dispatchEvent: vi.fn(),
                } satisfies IMediaQueryListDouble;
                mediaQueries.push(mediaQuery);
                return mediaQuery as MediaQueryList;
            }),
        });
    });

    afterEach(() => {
        setDevicePixelRatio(originalDevicePixelRatio);
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            value: originalMatchMedia,
        });
        vi.restoreAllMocks();
    });

    it.each([
        [
            1,
            1,
            2,
        ],
        [
            1.5,
            1.5,
            2,
        ],
        [
            3,
            3,
            3,
        ],
    ])(
        'resolves DPR %s to the policy floor',
        (devicePixelRatio, constrainedScale, normalScale) => {
            setDevicePixelRatio(devicePixelRatio);
            const constrainedScope = effectScope();
            const normalScope = effectScope();
            const constrainedOutputScale = constrainedScope.run(
                () => usePdfViewerOutputScale(constrainedPerformancePolicy),
            );
            const normalOutputScale = normalScope.run(
                () => usePdfViewerOutputScale(performancePolicy),
            );

            expect(constrainedOutputScale?.value).toBe(constrainedScale);
            expect(normalOutputScale?.value).toBe(normalScale);

            constrainedScope.stop();
            normalScope.stop();
        },
    );

    it('tracks raw fractional DPR through media events and releases its listener', () => {
        setDevicePixelRatio(0.75);
        const scope = effectScope();
        const outputScale = scope.run(() => usePdfViewerOutputScale(performancePolicy))!;
        expect(outputScale.value).toBe(2);
        expect(mediaQueries[0]?.media).toBe('(resolution: 0.75dppx)');
        setDevicePixelRatio(2);
        mediaQueries[0]!.addEventListener.mock.calls[0]![1]();
        expect(outputScale.value).toBe(2);
        expect(mediaQueries[1]?.media).toBe('(resolution: 2dppx)');
        scope.stop();
        expect(mediaQueries[1]?.removeEventListener).toHaveBeenCalledOnce();
        setDevicePixelRatio(3);
        window.dispatchEvent(new Event('resize'));
        expect(outputScale.value).toBe(2);
    });

    it('keeps the resolution media listener stable across same-DPR resizes', () => {
        const scope = effectScope();
        const outputScale = scope.run(() => usePdfViewerOutputScale(performancePolicy));
        if (!outputScale) {
            throw new Error('Failed to create output scale composable');
        }

        window.dispatchEvent(new Event('resize'));

        expect(outputScale.value).toBe(2);
        expect(window.matchMedia).toHaveBeenCalledOnce();
        expect(mediaQueries[0]?.removeEventListener).not.toHaveBeenCalled();

        setDevicePixelRatio(2);
        window.dispatchEvent(new Event('resize'));

        expect(outputScale.value).toBe(2);
        expect(window.matchMedia).toHaveBeenCalledTimes(2);
        expect(window.matchMedia).toHaveBeenLastCalledWith('(resolution: 2dppx)');

        setDevicePixelRatio(3);
        window.dispatchEvent(new Event('resize'));

        expect(outputScale.value).toBe(3);
        expect(window.matchMedia).toHaveBeenCalledTimes(3);
        expect(window.matchMedia).toHaveBeenLastCalledWith('(resolution: 3dppx)');
        expect(mediaQueries[0]?.removeEventListener).toHaveBeenCalledOnce();

        scope.stop();

        expect(mediaQueries[2]?.removeEventListener).toHaveBeenCalledOnce();
    });
});
