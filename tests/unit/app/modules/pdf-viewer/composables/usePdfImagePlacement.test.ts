import { requirePageNumber } from '@contracts/pageNumbers';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { usePdfImagePlacement } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfImagePlacement';
import { getInitialImagePlacementRect } from '@app/modules/pdf-viewer/engine/image-placement/getInitialImagePlacementRect';
import type {IPdfPlacedImageFinalizePayload} from '@app/types/pdfImagePlacement';

function toElement<T extends object>(value: T) {
    return value as HTMLElement;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

describe('usePdfImagePlacement', () => {
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('URL', {
            createObjectURL,
            revokeObjectURL,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function createViewerContainer() {
        const canvas = {
            width: 1200,
            height: 1600,
        } as HTMLCanvasElement;
        const pageContainer = toElement({
            getBoundingClientRect: () => ({
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 600,
                bottom: 800,
                width: 600,
                height: 800,
                toJSON: () => ({}),
            }),
            clientWidth: 600,
            clientHeight: 800,
            querySelector: vi.fn((selector: string) =>
                selector === '.page_canvas canvas' ? canvas : null),
        });

        return toElement({ querySelector: vi.fn((selector: string) =>
            selector === '.page_container[data-page="1"]' ? pageContainer : null) });
    }

    async function probeImageForTest(file: File) {
        const bitmap = await createImageBitmap(file);
        try {
            return {
                bytes: new Uint8Array(await file.arrayBuffer()),
                width: bitmap.width,
                height: bitmap.height,
                frameCount: 1,
                mimeType: file.type,
            };
        } finally {
            bitmap.close();
        }
    }

    const createPreviewForTest = async () => new Blob(['preview'], {type: 'image/png'});

    it('clamps the initial placement rect to page bounds', () => {
        expect(getInitialImagePlacementRect({
            pageNumber: requirePageNumber(2),
            pageX: 0,
            pageY: 1,
            pageWidthPx: 600,
            pageHeightPx: 800,
        }, {
            width: 0.4,
            height: 0.3,
        })).toEqual({
            pageNumber: 2,
            x: 0,
            y: 0.7,
            width: 0.4,
            height: 0.3,
        });
    });

    it('returns false and leaves no draft when image decoding fails', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => {
            throw new Error('decode failed');
        }));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            const didStart = await imagePlacement.startImagePlacement(
                new File([Uint8Array.of(1, 2, 3)], 'broken.png', {type: 'image/png'}),
            );

            expect(didStart).toBe(false);
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
            expect(finalized).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('keeps the latest image placement when overlapping starts resolve out of order', async () => {
        const slowBitmap = createDeferred<{
            width: number;
            height: number;
            close: () => void;
        }>();
        const fastBitmap = createDeferred<{
            width: number;
            height: number;
            close: () => void;
        }>();
        vi.stubGlobal('createImageBitmap', vi.fn()
            .mockReturnValueOnce(slowBitmap.promise)
            .mockReturnValueOnce(fastBitmap.promise));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            const slowStart = imagePlacement.startImagePlacement(
                new File([new Uint8Array([1])], 'slow.png', { type: 'image/png' }),
            );
            const fastStart = imagePlacement.startImagePlacement(
                new File([new Uint8Array([2])], 'fast.png', { type: 'image/png' }),
            );

            fastBitmap.resolve({
                width: 200,
                height: 100,
                close: vi.fn(),
            });
            await expect(fastStart).resolves.toBe(true);
            expect(imagePlacement.pendingImagePlacement.value?.fileName).toBe('fast.png');

            slowBitmap.resolve({
                width: 400,
                height: 200,
                close: vi.fn(),
            });
            await expect(slowStart).resolves.toBe(false);
            expect(imagePlacement.pendingImagePlacement.value?.fileName).toBe('fast.png');
            expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:preview');
        } finally {
            scope.stop();
        }
    });

    it('finalizes with target pixel dimensions derived from the rendered page size', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.png', { type: 'image/png' }),
                {
                    stableKey: 'placed-image-app-1',
                    annotationId: '44R',
                },
            );
            imagePlacement.updatePendingImagePlacementRect({
                x: 0.1,
                y: 0.2,
                width: 0.25,
                height: 0.5,
                rotationDegrees: 90,
            });

            imagePlacement.requestPendingImagePlacementFinalize();

            expect(finalized).toHaveBeenCalledOnce();
            expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
                stableKey: 'placed-image-app-1',
                annotationId: '44R',
                pageNumber: 1,
                x: 0.1,
                y: 0.2,
                width: 0.25,
                height: 0.5,
                rotationDegrees: 90,
                fileName: 'image.png',
                mimeType: 'image/png',
                targetPixelWidth: 150,
                targetPixelHeight: 400,
            }));
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
            expect(imagePlacement.isPendingImagePlacementFinalizing.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('releases the placement only after canonical stamp creation succeeds', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalization = createDeferred<boolean>();
        const finalized = vi.fn(() => finalization.promise);
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.jpg', {type: 'image/jpeg'}),
            );
            imagePlacement.requestPendingImagePlacementFinalize();

            expect(imagePlacement.isPendingImagePlacementFinalizing.value).toBe(true);
            expect(imagePlacement.pendingImagePlacement.value).not.toBeNull();
            finalization.resolve(true);
            await vi.waitFor(() => expect(imagePlacement.pendingImagePlacement.value).toBeNull());
            expect(imagePlacement.isPendingImagePlacementFinalizing.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('preserves a draft position and physical size across view rotations', async () => {
        const scope = effectScope();
        const viewRotation = ref(0);
        const placement = scope.run(() => usePdfImagePlacement({
            viewerContainer: ref(createViewerContainer()),
            currentPage: ref(1),
            numPages: ref(1),
            effectiveScale: ref(1),
            viewRotation,
            getPageDimensions: () => ({
                width: 600,
                height: 800,
            }),
            finalizePlacement: () => false,
            probeImage: async () => ({
                bytes: Uint8Array.of(1),
                width: 40,
                height: 20,
                frameCount: 1,
                mimeType: 'image/png',
            }),
            createPreview: createPreviewForTest,
        }))!;
        try {
            await placement.startImagePlacement(new File([Uint8Array.of(1)], 'image.png', {type: 'image/png'}));
            const original = {...placement.pendingImagePlacement.value!};
            viewRotation.value = 90;
            expect(placement.pendingImagePlacement.value?.rotationDegrees).toBe(90);
            expect(placement.pendingImagePlacement.value!.width * 800).toBeCloseTo(original.width * 600);
            expect(placement.pendingImagePlacement.value!.height * 600).toBeCloseTo(original.height * 800);
            viewRotation.value = 0;
            expect(placement.pendingImagePlacement.value?.x).toBeCloseTo(original.x);
            expect(placement.pendingImagePlacement.value?.y).toBeCloseTo(original.y);
            expect(placement.pendingImagePlacement.value?.width).toBeCloseTo(original.width);
            expect(placement.pendingImagePlacement.value?.height).toBeCloseTo(original.height);
            expect(placement.pendingImagePlacement.value?.rotationDegrees).toBe(original.rotationDegrees);
        } finally {
            scope.stop();
        }
    });

    it('keeps the draft coordinate rotation when page metrics disappear and reprojects from that owner', async () => {
        const scope = effectScope();
        const viewRotation = ref(0);
        let hasMetrics = true;
        const finalizePlacement = vi.fn(() => false);
        const placement = scope.run(() => usePdfImagePlacement({
            viewerContainer: ref(createViewerContainer()),
            currentPage: ref(1),
            numPages: ref(1),
            effectiveScale: ref(1),
            viewRotation,
            getPageDimensions: () => hasMetrics ? {
                width: 600,
                height: 800,
            } : null,
            finalizePlacement,
            probeImage: async () => ({
                bytes: Uint8Array.of(1),
                width: 40,
                height: 20,
                frameCount: 1,
                mimeType: 'image/png',
            }),
            createPreview: createPreviewForTest,
        }))!;
        try {
            await placement.startImagePlacement(new File([Uint8Array.of(1)], 'image.png', {type: 'image/png'}));
            hasMetrics = false;
            viewRotation.value = 90;
            placement.requestPendingImagePlacementFinalize();
            expect(finalizePlacement).toHaveBeenLastCalledWith(expect.objectContaining({
                viewRotation: 0,
                rotationDegrees: 0,
            }));
            hasMetrics = true;
            viewRotation.value = 180;
            expect(placement.pendingImagePlacement.value).toMatchObject({
                viewRotation: 180,
                rotationDegrees: 180,
            });
        } finally { scope.stop(); }
    });

    it('does not clear a newer replacement when an older finalization completes', async () => {
        const first = createDeferred<boolean>();
        const scope = effectScope();
        const placement = scope.run(() => usePdfImagePlacement({
            viewerContainer: ref(createViewerContainer()),
            currentPage: ref(1),
            numPages: ref(1),
            effectiveScale: ref(1),
            finalizePlacement: () => first.promise,
            probeImage: async () => ({
                bytes: Uint8Array.of(1),
                width: 40,
                height: 20,
                frameCount: 1,
                mimeType: 'image/png',
            }),
            createPreview: createPreviewForTest,
        }))!;
        try {
            const file = new File([Uint8Array.of(1)], 'image.png', {type: 'image/png'});
            await placement.startImagePlacement(file, {stableKey: 'same-annotation'});
            placement.requestPendingImagePlacementFinalize();
            await placement.startImagePlacement(file, {stableKey: 'same-annotation'});
            const nextDraft = placement.pendingImagePlacement.value;
            first.resolve(true);
            await first.promise;
            await Promise.resolve();
            expect(placement.pendingImagePlacement.value).toBe(nextDraft);
        } finally {
            scope.stop();
        }
    });

    it('restores a failed stamp finalization and allows a retry', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.jpg', {type: 'image/jpeg'}),
            );
            imagePlacement.requestPendingImagePlacementFinalize();
            await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(imagePlacement.isPendingImagePlacementFinalizing.value).toBe(false));
            expect(imagePlacement.pendingImagePlacement.value).not.toBeNull();

            imagePlacement.requestPendingImagePlacementFinalize();
            await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(imagePlacement.pendingImagePlacement.value).toBeNull());
        } finally {
            scope.stop();
        }
    });

    it('passes owned bytes to stamp creation without exposing the draft buffer', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn((candidate: IPdfPlacedImageFinalizePayload) => {
            candidate.bytes[0] = 99;
            return false;
        });
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.jpg', {type: 'image/jpeg'}),
            );
            const draftBytes = imagePlacement.pendingImagePlacement.value?.bytes.slice();
            imagePlacement.requestPendingImagePlacementFinalize();

            const payload = finalized.mock.calls[0]?.[0];
            expect(payload?.bytes[0]).toBe(99);
            expect(payload?.stableKey).toMatch(/^placed-image-/u);
            expect(imagePlacement.pendingImagePlacement.value?.bytes).toEqual(draftBytes);
        } finally {
            scope.stop();
        }
    });

    it('upsizes tiny finalized placements before serialization', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 400,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'tiny.png', { type: 'image/png' }),
            );
            imagePlacement.updatePendingImagePlacementRect({
                x: 0.15,
                y: 0.2,
                width: 0.01,
                height: 0.01,
                rotationDegrees: 0,
            });

            imagePlacement.requestPendingImagePlacementFinalize();

            expect(finalized).toHaveBeenCalledOnce();
            expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
                fileName: 'tiny.png',
                targetPixelWidth: 48,
                targetPixelHeight: 64,
            }));
        } finally {
            scope.stop();
        }
    });

    it('revokes the preview URL when the draft is cleared', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: vi.fn(),
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([Uint8Array.of(1, 2, 3)], 'image.png', {type: 'image/png'}),
            );

            imagePlacement.clearPendingImagePlacement();

            expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

});
